// Host-side policy. The MCP server marks which tools change data; this module decides that
// such calls wait for a person, which role may approve them, and records every decision.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DateTime } from 'luxon';
import { createOpsServer } from './mcp-server.mjs';
import { audit, money, ZONE } from './data.mjs';

export const ROLES = { dispatcher: 1, owner: 2 };

/** Minimum role that may approve each change. Unlisted write tools default to owner. */
export const APPROVER = {
  create_invoice_draft: 'dispatcher',
  send_payment_reminder: 'dispatcher',
  reschedule_job: 'dispatcher',
  issue_refund: 'owner',
};

/** Connect an MCP client to the full back-office server over an in-process transport. */
export async function connectBackOffice(db) {
  const server = createOpsServer(db);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'copperline-ops-host', version: '1.0.0' });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  return { client, tools, needsApproval: (name) => tools.find((t) => t.name === name)?.annotations?.readOnlyHint !== true };
}

/** Parse an MCP tool result into { ok, data }. */
export function readResult(res) {
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '{}';
  let data;
  try { data = JSON.parse(text); } catch { data = { text }; }
  return { ok: !res.isError && !data.error, data };
}

const fmt = (iso) => DateTime.fromISO(iso, { zone: ZONE }).toFormat("ccc d LLL, h:mm a");

/** Plain-English summary and detail shown on the approval card. */
export function describe(db, tool, input) {
  switch (tool) {
    case 'send_payment_reminder': {
      const inv = db.prepare('SELECT i.number, i.total, i.paid, c.name, c.phone, c.email FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?').get(input.invoice_id);
      if (!inv) return { summary: `Send reminder for invoice #${input.invoice_id}`, detail: input.message };
      return { summary: `Text ${inv.name} about ${inv.number} (${money(inv.total - inv.paid)} due)`.replace('Text', input.channel === 'sms' ? 'Text' : 'Email'), detail: `To ${input.channel === 'sms' ? inv.phone : inv.email}:\n${input.message}` };
    }
    case 'reschedule_job': {
      const job = db.prepare('SELECT j.*, c.name FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE j.id = ?').get(input.job_id);
      if (!job) return { summary: `Reschedule job #${input.job_id}`, detail: `New time ${input.new_start}` };
      return { summary: `Move ${job.name}'s job #${job.id} (${job.technician})`, detail: `${DateTime.fromISO(job.start_utc).setZone(ZONE).toFormat("ccc d LLL, h:mm a")}  to  ${fmt(input.new_start)}` };
    }
    case 'create_invoice_draft': {
      const job = db.prepare('SELECT j.id, c.name FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE j.id = ?').get(input.job_id);
      const total = input.items.reduce((s, i) => s + i.amount, 0);
      return { summary: `Draft invoice for ${job?.name ?? 'job'} (job #${input.job_id}), ${money(total)}`, detail: input.items.map((i) => `${i.description}: ${money(i.amount)}`).join('\n') };
    }
    case 'issue_refund': {
      const inv = db.prepare('SELECT i.number, c.name FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?').get(input.invoice_id);
      return { summary: `Refund ${money(input.amount)} to ${inv?.name ?? 'customer'} on ${inv?.number ?? `invoice #${input.invoice_id}`}`, detail: `Reason: ${input.reason}` };
    }
    default:
      return { summary: `Run ${tool}`, detail: JSON.stringify(input) };
  }
}

/** Queue a change for approval instead of running it. */
export function requestAction(db, sessionId, tool, input) {
  const { summary, detail } = describe(db, tool, input);
  const role = APPROVER[tool] ?? 'owner';
  const r = db.prepare('INSERT INTO actions (session_id, tool, input, summary, detail, required_role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sessionId, tool, JSON.stringify(input), summary, detail, role, DateTime.utc().toISO());
  audit(db, { sessionId, actor: 'assistant', kind: 'proposed', text: `Proposed: ${summary} (needs ${role} approval)` });
  return { action_id: Number(r.lastInsertRowid), summary, required_role: role };
}

/**
 * Approve or reject a pending action. Only the session that created it can decide, and
 * approving needs at least the required role. Approved actions run through MCP.
 */
export async function decide(db, client, { actionId, sessionId, role, approve }) {
  const a = db.prepare('SELECT * FROM actions WHERE id = ? AND session_id = ?').get(actionId, sessionId);
  if (!a) return { ok: false, error: 'not_found' };
  if (a.status !== 'pending') return { ok: false, error: 'already_decided', status: a.status };
  const actor = role === 'owner' ? 'Owner' : 'Dispatcher';
  const now = DateTime.utc().toISO();
  if (!approve) {
    db.prepare("UPDATE actions SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?").run(actor, now, a.id);
    audit(db, { sessionId, actor, kind: 'rejected', text: `Rejected: ${a.summary}` });
    return { ok: true, status: 'rejected' };
  }
  if ((ROLES[role] ?? 0) < ROLES[a.required_role]) {
    audit(db, { sessionId, actor, kind: 'denied', text: `Blocked: ${actor} tried to approve "${a.summary}", which needs the ${a.required_role}` });
    return { ok: false, error: 'insufficient_role', required: a.required_role };
  }
  // Claim the action first so a double click can't run it twice.
  const claimed = db.prepare("UPDATE actions SET status = 'running', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(actor, now, a.id);
  if (claimed.changes !== 1) return { ok: false, error: 'already_decided' };
  const { ok, data } = readResult(await client.callTool({ name: a.tool, arguments: JSON.parse(a.input) }));
  const status = ok ? 'executed' : 'failed';
  db.prepare('UPDATE actions SET status = ?, result = ? WHERE id = ?').run(status, JSON.stringify(data), a.id);
  audit(db, { sessionId, actor, kind: status, text: ok ? `Approved and done: ${a.summary}` : `Approved but failed: ${a.summary} (${data.error})` });
  return { ok, status, result: data };
}

/**
 * Decisions the assistant hasn't been told about yet, as one note for its next turn.
 * Marks them reported so each is mentioned once.
 */
export function takeDecisionNote(db, sessionId) {
  const rows = db.prepare("SELECT * FROM actions WHERE session_id = ? AND reported = 0 AND status IN ('executed','failed','rejected')").all(sessionId);
  if (!rows.length) return null;
  db.prepare(`UPDATE actions SET reported = 1 WHERE id IN (${rows.map(() => '?').join(',')})`).run(...rows.map((r) => r.id));
  return rows.map((r) => `Action ${r.id} (${r.summary}): ${r.status} by ${r.decided_by}${r.result ? `, result ${r.result}` : ''}`).join(String.fromCharCode(10));
}
