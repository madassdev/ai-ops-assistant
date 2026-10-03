import { mkdirSync } from 'node:fs';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { probe, classifyError, PROVIDER } from './llm.mjs';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { DateTime } from 'luxon';
import { openDb, ensureFreshData, nowLocal, money, TECHS, ZONE } from './data.mjs';
import { createOpsServer } from './mcp-server.mjs';
import { connectBackOffice, decide, ROLES, readResult, requestAction } from './approvals.mjs';
import { respond, AiUnavailable, MODEL } from './agent.mjs';
import { LIMITS, issueChallenge, verifyChallenge, createSession, getSession, initUsage, usageToday, aiBlocked, recordUsage } from './guard.mjs';

const PORT = Number(process.env.PORT ?? 5200);
mkdirSync('data', { recursive: true });
const db = openDb();
initUsage(db);
ensureFreshData(db);
setInterval(() => ensureFreshData(db), 30 * 60_000).unref();
const bo = await connectBackOffice(db);

// Is the AI provider usable? A 1-token probe at start and every 15 minutes (refused, and
// free, when there's no credit).
const aiHealth = { ok: null };
async function probeAi() { aiHealth.ok = await probe(); }
if (LIMITS.aiEnabled) { probeAi(); setInterval(probeAi, 15 * 60_000).unref(); }
const aiStatus = () => aiBlocked(db) ?? (aiHealth.ok === false ? 'paused' : 'ok');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static('public', { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

const limiter = (limit, minutes) => rateLimit({
  windowMs: minutes * 60_000, limit, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: 'Too many requests from your connection. Please wait a few minutes.' },
});
const sessionFrom = (req) => getSession(String(req.body?.session ?? req.query.session ?? ''));

app.get('/health', (_req, res) => res.json({ ok: true }));

// Headline numbers for the dashboard strip.
app.get('/api/overview', limiter(120, 1), (_req, res) => {
  const now = nowLocal();
  const dayStart = now.startOf('day').toUTC().toISO(), dayEnd = now.endOf('day').toUTC().toISO();
  const jobsToday = db.prepare("SELECT technician, COUNT(*) AS n FROM jobs WHERE start_utc BETWEEN ? AND ? AND status != 'cancelled' GROUP BY technician").all(dayStart, dayEnd);
  const open = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total - paid), 0) AS owed FROM invoices WHERE status = 'open' AND total > paid").get();
  const overdue = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total - paid), 0) AS owed FROM invoices WHERE status = 'open' AND total > paid AND due_on < ?").get(now.toISODate());
  const month = db.prepare("SELECT COALESCE(SUM(paid), 0) AS s FROM invoices WHERE issued_on >= ?").get(now.minus({ days: 30 }).toISODate());
  const u = usageToday(db);
  res.json({
    date: now.toFormat('cccc d LLLL'),
    jobsToday: TECHS.map((t) => ({ technician: t, jobs: jobsToday.find((j) => j.technician === t)?.n ?? 0 })),
    openInvoices: { count: open.n, owed: money(open.owed) },
    overdue: { count: overdue.n, owed: money(overdue.owed) },
    collectedThisMonth: money(month.s),
    ai: { status: aiStatus(), spentToday: Number(u.cost_usd.toFixed(4)), budget: LIMITS.dailyBudgetUsd },
  });
});

app.get('/api/challenge', limiter(20, 10), (_req, res) => res.json(issueChallenge()));
app.post('/api/session', limiter(20, 10), (req, res) => {
  const problem = verifyChallenge(req.body?.token, req.body?.nonce);
  if (problem) return res.status(403).json({ error: 'Verification failed. Reload the page to try again.' });
  const s = createSession(req.ip);
  if (s.error) return res.status(429).json({ error: 'You have started several sessions recently. Please come back in an hour.' });
  res.json({ session: s.id, role: 'dispatcher', messagesLeft: LIMITS.messagesPerSession });
});

// Demo only: lets a visitor act as the dispatcher or the owner to see role-gated approvals.
app.post('/api/role', limiter(60, 10), (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Session expired. Reload the page.', expired: true });
  if (!ROLES[req.body?.role]) return res.status(400).json({ error: 'Unknown role' });
  s.role = req.body.role;
  res.json({ role: s.role });
});

const UNAVAILABLE = {
  disabled: 'The live AI is switched off right now. The dashboard, approvals and MCP endpoint still work.',
  daily_call_limit: 'The demo has reached its daily AI limit. Try again tomorrow.',
  daily_budget: 'The demo has reached its daily AI limit. Try again tomorrow.',
  no_credit: 'The live AI is paused right now. The dashboard and the public MCP endpoint still work.',
};

app.post('/api/chat', limiter(40, 60), async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Your session expired. Reload the page to start a new one.', expired: true });
  const text = String(req.body?.message ?? '').trim();
  if (!text) return res.status(400).json({ error: 'Type a message first.' });
  if (text.length > LIMITS.maxMessageChars) return res.status(400).json({ error: `Keep messages under ${LIMITS.maxMessageChars} characters.` });
  if (s.turns >= LIMITS.messagesPerSession) return res.status(429).json({ error: 'This demo session has reached its message limit. Reload to start a new one.' });
  if (s.busy) return res.status(409).json({ error: 'Still working on your last message.' });
  s.busy = true;
  try {
    const out = await respond(db, bo, s, text, { beforeCall: () => aiBlocked(db), onCost: (c) => { recordUsage(db, c); s.cost += c; } });
    s.turns++;
    res.json({ ...out, messagesLeft: LIMITS.messagesPerSession - s.turns, sessionCost: s.cost });
  } catch (err) {
    if (err instanceof AiUnavailable) return res.status(503).json({ error: UNAVAILABLE[err.message] ?? UNAVAILABLE.disabled });
    const kind = classifyError(err);
    if (kind === 'no_credit') {
      console.error(`${PROVIDER}: key rejected or out of credit`);
      aiHealth.ok = false;
      return res.status(503).json({ error: UNAVAILABLE.no_credit, paused: true });
    }
    if (kind === 'busy') return res.status(503).json({ error: 'The AI service is busy. Try again in a minute.' });
    if (kind === 'api') {
      console.error(`${PROVIDER} error`, err.status, err.message);
      return res.status(502).json({ error: 'The AI service returned an error. Try sending that again.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our side. Try again.' });
  } finally {
    s.busy = false;
  }
});

// Example run, no AI: real data through the same MCP tools, and real approval cards queued for
// this visitor (three reminders and one owner-only refund) so they can practise approving.
app.post('/api/example', limiter(10, 10), async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Session expired. Reload the page.', expired: true });
  s.examples = (s.examples ?? 0) + 1;
  if (s.examples > 3) return res.status(429).json({ error: 'You have played the example a few times already. Reload the page to start fresh.' });
  const { data: unpaid } = readResult(await bo.client.callTool({ name: 'list_unpaid_invoices', arguments: { min_days_overdue: 14 } }));
  const top = unpaid.invoices.slice(0, 3);
  const lines = top.map((i) => `- ${i.customer}: ${i.balance} on ${i.number}, ${i.days_overdue} days late`).join(String.fromCharCode(10));
  const proposals = [];
  for (const inv of top) {
    const first = inv.customer.split(' ')[0];
    const message = `Hi ${first}, a friendly reminder that invoice ${inv.number} for ${inv.balance} was due on ${inv.due_on}. You can pay by card or bank transfer. Thank you! Copperline Heating & Air`;
    proposals.push(requestAction(db, s.id, 'send_payment_reminder', { invoice_id: inv.invoice_id, channel: 'sms', message }));
  }
  const paid = db.prepare("SELECT i.id, i.number, c.name FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.status = 'paid' AND i.total BETWEEN 120 AND 600 ORDER BY i.issued_on DESC LIMIT 1").get();
  if (paid) proposals.push(requestAction(db, s.id, 'issue_refund', { invoice_id: paid.id, amount: 25, reason: 'Charged for a filter the customer supplied themselves' }));
  res.json({
    steps: [
      { who: 'me', text: 'Who owes us money and is more than two weeks late?' },
      { who: 'bot', events: ['Checked unpaid invoices'], text: `${unpaid.count} invoices are more than two weeks late, ${unpaid.total_outstanding} in total. The oldest three:${String.fromCharCode(10)}${lines}` },
      { who: 'me', text: 'Text those three a polite reminder.' },
      { who: 'bot', events: top.map((i) => `Queued for approval: text ${i.customer}`), text: 'I have drafted three reminders. They are waiting in your approval inbox, nothing has been sent yet.' },
      { who: 'me', text: `Also refund $25 to ${paid?.name ?? 'the customer'}, they supplied their own filter.` },
      { who: 'bot', events: ['Queued for approval: refund'], text: 'Refund drafted. Refunds need the owner, so it is waiting for Olivia to approve.' },
    ],
    proposals,
  });
});

const actionView = (a) => ({
  id: a.id, tool: a.tool, summary: a.summary, detail: a.detail, requiredRole: a.required_role, status: a.status,
  decidedBy: a.decided_by, result: a.result ? JSON.parse(a.result) : null,
  createdAt: DateTime.fromISO(a.created_at).setZone(ZONE).toFormat('h:mm a'),
});

app.get('/api/actions', limiter(120, 1), (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.json({ actions: [], audit: [] });
  const actions = db.prepare('SELECT * FROM actions WHERE session_id = ? ORDER BY id DESC LIMIT 30').all(s.id).map(actionView);
  const auditRows = db.prepare('SELECT actor, kind, text, created_at FROM audit WHERE session_id = ? ORDER BY id DESC LIMIT 40').all(s.id)
    .map((r) => ({ ...r, time: DateTime.fromISO(r.created_at).setZone(ZONE).toFormat('h:mm:ss a') }));
  res.json({ role: s.role, actions, audit: auditRows });
});

app.post('/api/actions/:id', limiter(60, 10), async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Session expired. Reload the page.', expired: true });
  const out = await decide(db, bo.client, { actionId: Number(req.params.id), sessionId: s.id, role: s.role, approve: req.body?.approve === true });
  if (out.error === 'insufficient_role') return res.status(403).json({ error: `Only the ${out.required} can approve this. Switch to the ${out.required} role to approve it.` });
  if (out.error === 'already_decided') return res.status(409).json({ error: 'This action was already decided.' });
  if (out.error) return res.status(404).json({ error: 'Action not found.' });
  res.json(out);
});

// Public, read-only MCP endpoint (Streamable HTTP, stateless). Connect any MCP client to it.
const mcpLimiter = limiter(60, 1);
app.post('/mcp', mcpLimiter, async (req, res) => {
  const server = createOpsServer(db, { readOnly: true });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('mcp error', err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
});
app.all('/mcp', (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. POST JSON-RPC to this endpoint.' }, id: null }));

app.listen(PORT, () => console.log(`ops on :${PORT} using ${PROVIDER} ${MODEL}; AI ${LIMITS.aiEnabled ? 'on' : 'off'}`));
