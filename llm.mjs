// Provider adapter shared by the demos (copied into each app; edit the copy in assets/llm/).
// The apps keep Claude-style messages and tool definitions; this file talks to OpenAI or
// Anthropic. PROVIDER=openai|anthropic picks one (default: openai when OPENAI_API_KEY is set).

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export const PROVIDER = process.env.PROVIDER ?? (process.env.OPENAI_API_KEY ? 'openai' : 'anthropic');
export const MODEL = process.env.MODEL ?? (PROVIDER === 'openai' ? 'gpt-4.1-mini' : 'claude-opus-5');
const EFFORT = process.env.EFFORT ?? 'low';

// USD per million tokens: [input, cached input, output]. Unknown models are costed at the
// dearest listed model of their provider, so the daily budget errs on the safe side.
const PRICES = {
  'gpt-4.1-nano': [0.1, 0.025, 0.4], 'gpt-4.1-mini': [0.4, 0.1, 1.6], 'gpt-4.1': [2, 0.5, 8],
  'gpt-5-mini': [0.25, 0.025, 2], 'gpt-5': [1.25, 0.125, 10],
  'claude-haiku-4-5': [1, 0.1, 5], 'claude-sonnet-5': [2, 0.2, 10], 'claude-opus-5-5': [4, 0.4, 20], 'claude-opus-5': [5, 0.5, 25],
};
const price = () => PRICES[MODEL] ?? (PROVIDER === 'openai' ? PRICES['gpt-5'] : PRICES['claude-opus-5']);

const clients = new Map();
function client(kind, timeout) {
  const key = `${kind}:${timeout}`;
  if (!clients.has(key)) clients.set(key, kind === 'openai' ? new OpenAI({ timeout, maxRetries: 1 }) : new Anthropic({ timeout, maxRetries: 1 }));
  return clients.get(key);
}
export const openai = (timeout = 60_000) => client('openai', timeout);
export const anthropic = (timeout = 60_000) => client('anthropic', timeout);

export function costOpenAi(u = {}) {
  const [i, c, o] = price();
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return (((u.prompt_tokens ?? 0) - cached) * i + cached * c + (u.completion_tokens ?? 0) * o) / 1e6;
}
export function costAnthropic(u = {}) {
  const [i, c, o] = price();
  return (((u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) * 1.25) * i + (u.cache_read_input_tokens ?? 0) * c + (u.output_tokens ?? 0) * o) / 1e6;
}

/** Claude-style messages → OpenAI chat messages. */
function toOpenAiMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (m.role === 'assistant') {
      const calls = blocks.filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const b of blocks.filter((x) => x.type === 'tool_result')) {
      out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) });
    }
    if (text) out.push({ role: 'user', content: text });
  }
  return out;
}

const toOpenAiTool = (t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema, ...(t.strict ? { strict: true } : {}) },
});

/**
 * One model turn with tools. Takes and returns Claude-style shapes:
 * { content: [{type:'text'} | {type:'tool_use', id, name, input}], stop_reason, cost }.
 */
export async function chat({ system, tools = [], messages, maxTokens = 2048, timeout = 60_000 }) {
  if (PROVIDER === 'openai') {
    const r = await openai(timeout).chat.completions.create({
      model: MODEL,
      max_completion_tokens: maxTokens,
      messages: toOpenAiMessages(system, messages),
      ...(tools.length ? { tools: tools.map(toOpenAiTool) } : {}),
    });
    const choice = r.choices[0];
    const msg = choice.message;
    const content = [];
    if (msg.content) content.push({ type: 'text', text: msg.content });
    for (const call of msg.tool_calls ?? []) {
      let input = {};
      try { input = JSON.parse(call.function.arguments || '{}'); } catch { /* tool will reject it */ }
      content.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
    }
    const stop_reason = msg.refusal || choice.finish_reason === 'content_filter' ? 'refusal'
      : msg.tool_calls?.length ? 'tool_use'
      : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
    return { content, stop_reason, cost: costOpenAi(r.usage) };
  }
  const r = await anthropic(timeout).messages.create({
    model: MODEL, max_tokens: maxTokens, system, tools, messages,
    cache_control: { type: 'ephemeral' }, output_config: { effort: EFFORT },
  });
  return { content: r.content, stop_reason: r.stop_reason, cost: costAnthropic(r.usage) };
}

/** 'no_credit' | 'busy' | 'api' for provider errors, null for anything else. */
export function classifyError(err) {
  if (err instanceof OpenAI.APIError) {
    if (err.status === 401 || err.code === 'insufficient_quota' || /quota|billing/i.test(err.message ?? '')) return 'no_credit';
    if (err.status === 429 || err.status === 503) return 'busy';
    return 'api';
  }
  if (err instanceof Anthropic.APIError) {
    if (err instanceof Anthropic.AuthenticationError || (err.status === 400 && /credit balance/i.test(err.message))) return 'no_credit';
    if (err.status === 429 || err.status === 529) return 'busy';
    return 'api';
  }
  return null;
}

/**
 * Is the provider usable? A 1-token request with the cheapest model (refused, and free,
 * when there's no credit). Returns false only when the key or credit is the problem.
 */
export async function probe() {
  try {
    if (PROVIDER === 'openai') {
      await openai(15_000).chat.completions.create({ model: 'gpt-4.1-nano', max_completion_tokens: 1, messages: [{ role: 'user', content: 'ok' }] });
    } else {
      await anthropic(15_000).messages.create({ model: 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] });
    }
    return true;
  } catch (err) {
    return classifyError(err) !== 'no_credit';
  }
}
