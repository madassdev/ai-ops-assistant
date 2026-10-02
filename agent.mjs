// The ops assistant: Claude, with tools discovered from the back-office MCP server.
// Read tools run immediately; tools that change data become approval requests.

import Anthropic from '@anthropic-ai/sdk';
import { readResult, requestAction, takeDecisionNote } from './approvals.mjs';
import { nowLocal, TECHS } from './data.mjs';

export const MODEL = process.env.MODEL ?? 'claude-opus-5';
const EFFORT = process.env.EFFORT ?? 'low';
const MAX_TOOL_ROUNDS = 6;
const PRICES = { 'claude-opus-5': [5, 25], 'claude-opus-5-5': [4, 20], 'claude-sonnet-5': [2, 10], 'claude-haiku-4-5': [1, 5] };

const client = new Anthropic({ timeout: 90_000, maxRetries: 1 });

const SYSTEM = `You are the operations assistant for Copperline Heating & Air, an HVAC company in Austin, Texas with technicians ${TECHS.join(', ')}. You work for the office staff (a dispatcher or the owner), not for customers.

You can look up customers, jobs, invoices and revenue, and propose changes: draft invoices, payment reminders, rescheduling and refunds.

How to work:
- Get every fact from the tools. Never guess numbers, names or dates. If a tool returns nothing, say so.
- Be brief and concrete: lead with the answer, then the few numbers that matter. Use short lists for several items. No markdown headings.
- Changes never happen directly. Calling a change tool only queues it as an approval card for the staff member. After proposing, say what is waiting for approval in one line. Never say a change is done until you have been told it was approved and executed.
- Only propose changes the staff member asked for, or clearly implied (for example "chase the overdue ones"). Propose at most 5 changes per request.
- Payment reminders: polite, specific (invoice number, amount, due date), under 320 characters, signed "Copperline Heating & Air". Prefer SMS when the customer's notes say they prefer texts.
- Refunds always need the owner's approval; mention that when you propose one.
- Times are Austin time. Dates are YYYY-MM-DD in tool inputs.`;

/** Turn MCP tool definitions into Claude tool definitions. */
export function toClaudeTools(mcpTools) {
  return mcpTools.map((t) => ({
    name: t.name,
    description: t.annotations?.readOnlyHint === true
      ? t.description
      : `${t.description} REQUIRES APPROVAL: calling this queues the change for a person to approve; it does not run until they do.`,
    input_schema: (({ $schema, ...rest }) => rest)(t.inputSchema),
  }));
}

function costOf(usage) {
  const [i, o] = PRICES[MODEL] ?? PRICES['claude-opus-5'];
  return (((usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) * 1.25 + (usage.cache_read_input_tokens ?? 0) * 0.1) * i + (usage.output_tokens ?? 0) * o) / 1e6;
}

export class AiUnavailable extends Error {}

const short = (data) => {
  const s = JSON.stringify(data);
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
};

/**
 * Handle one staff message. Returns { reply, events, cost }. `bo` is the connected
 * back office from approvals.connectBackOffice.
 */
export async function respond(db, bo, session, userText, { beforeCall, onCost }) {
  const tools = toClaudeTools(bo.tools);
  const now = nowLocal();
  const startLen = session.messages.length;
  const rollback = () => { session.messages.length = startLen; };

  const content = [{ type: 'text', text: `[Today is ${now.toFormat('cccc d LLLL yyyy')} (${now.toISODate()}), ${now.toFormat('h:mm a')} in Austin. You are talking to the ${session.role}.]` }];
  const note = takeDecisionNote(db, session.id);
  if (note) content.push({ type: 'text', text: `[Decisions on your earlier proposals since the last message:\n${note}]` });
  content.push({ type: 'text', text: userText });
  session.messages.push({ role: 'user', content });

  const events = [];
  let cost = 0;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const blocked = beforeCall();
    if (blocked) { rollback(); throw new AiUnavailable(blocked); }
    let response;
    try {
      response = await client.messages.create({
        model: MODEL, max_tokens: 3000, system: SYSTEM, tools, messages: session.messages,
        cache_control: { type: 'ephemeral' }, output_config: { effort: EFFORT },
      });
    } catch (err) {
      rollback();
      throw err;
    }
    const c = costOf(response.usage);
    cost += c;
    onCost(c);

    if (response.stop_reason === 'refusal') {
      rollback();
      return { reply: "I can't help with that one.", events, cost };
    }
    session.messages.push({ role: 'assistant', content: response.content });
    const uses = response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || !uses.length) {
      const reply = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { reply: reply || 'Done.', events, cost };
    }

    const results = await Promise.all(uses.map(async (tu) => {
      if (bo.needsApproval(tu.name)) {
        const pending = requestAction(db, session.id, tu.name, tu.input);
        events.push({ tool: tu.name, kind: 'proposed', text: pending.summary, actionId: pending.action_id });
        return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify({ status: 'waiting_for_approval', ...pending }) };
      }
      const res = await bo.client.callTool({ name: tu.name, arguments: tu.input });
      const { ok, data } = readResult(res);
      events.push({ tool: tu.name, kind: ok ? 'read' : 'error', text: ok ? `${tu.name}(${short(tu.input)})` : `${tu.name} failed: ${data.error}` });
      return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(data), ...(ok ? {} : { is_error: true }) };
    }));
    session.messages.push({ role: 'user', content: results });
  }
  rollback();
  return { reply: 'That needed more steps than I allow per question. Try asking for one part at a time.', events, cost };
}
