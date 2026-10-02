import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb, ensureFreshData } from '../data.mjs';
import { createOpsServer } from '../mcp-server.mjs';
import { connectBackOffice, readResult, requestAction, decide, takeDecisionNote } from '../approvals.mjs';

async function setup() {
  const db = openDb(':memory:');
  ensureFreshData(db);
  const bo = await connectBackOffice(db);
  const call = async (name, args) => readResult(await bo.client.callTool({ name, arguments: args }));
  return { db, ...bo, call };
}

test('tools are discovered over MCP and write tools are flagged for approval', async () => {
  const { tools, needsApproval } = await setup();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['create_invoice_draft', 'get_customer', 'issue_refund', 'list_jobs', 'list_unpaid_invoices', 'reschedule_job', 'revenue_summary', 'search_customers', 'send_payment_reminder']);
  assert.equal(needsApproval('list_jobs'), false);
  assert.equal(needsApproval('issue_refund'), true);
  assert.equal(needsApproval('send_payment_reminder'), true);
});

test('the public read-only server exposes no write tools', async () => {
  const db = openDb(':memory:');
  ensureFreshData(db);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createOpsServer(db, { readOnly: true }).connect(b);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(a);
  const { tools } = await client.listTools();
  assert.ok(tools.length === 5 && tools.every((t) => t.annotations?.readOnlyHint === true));
});

test('read tools return seeded business data', async () => {
  const { call } = await setup();
  const unpaid = await call('list_unpaid_invoices', { min_days_overdue: 0 });
  assert.ok(unpaid.ok && unpaid.data.count > 0);
  const found = await call('search_customers', { query: unpaid.data.invoices[0].customer.split(' ')[0] });
  assert.ok(found.data.length >= 1);
  const rev = await call('revenue_summary', { from_date: '2000-01-01', to_date: '2100-01-01' });
  assert.ok(rev.data.invoices > 50);
});

test('server-side validation rejects bad input even if the model sends it', async () => {
  const { call } = await setup();
  const r = await call('send_payment_reminder', { invoice_id: 1, channel: 'pigeon', message: 'hi' });
  assert.equal(r.ok, false);
});

test('changes wait for approval, and the right role runs them exactly once', async () => {
  const { db, client, call } = await setup();
  const inv = (await call('list_unpaid_invoices', { min_days_overdue: 0 })).data.invoices[0];
  const outboxBefore = db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n;
  const { action_id } = requestAction(db, 's1', 'send_payment_reminder', { invoice_id: inv.invoice_id, channel: 'sms', message: 'Hi, a friendly reminder that your invoice is due. Thanks!' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, outboxBefore); // nothing sent yet
  assert.equal((await decide(db, client, { actionId: action_id, sessionId: 'someone-else', role: 'owner', approve: true })).error, 'not_found');
  const ok = await decide(db, client, { actionId: action_id, sessionId: 's1', role: 'dispatcher', approve: true });
  assert.equal(ok.status, 'executed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, outboxBefore + 1);
  const again = await decide(db, client, { actionId: action_id, sessionId: 's1', role: 'dispatcher', approve: true });
  assert.equal(again.error, 'already_decided');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, outboxBefore + 1);
  assert.match(takeDecisionNote(db, 's1'), /executed by Dispatcher/);
  assert.equal(takeDecisionNote(db, 's1'), null); // reported once
});

test('refunds need the owner, and cannot exceed what was paid', async () => {
  const { db, client } = await setup();
  const paid = db.prepare("SELECT id, paid FROM invoices WHERE status = 'paid' LIMIT 1").get();
  const { action_id } = requestAction(db, 's1', 'issue_refund', { invoice_id: paid.id, amount: paid.paid + 100, reason: 'Customer overcharged' });
  assert.equal((await decide(db, client, { actionId: action_id, sessionId: 's1', role: 'dispatcher', approve: true })).error, 'insufficient_role');
  const r = await decide(db, client, { actionId: action_id, sessionId: 's1', role: 'owner', approve: true });
  assert.equal(r.status, 'failed'); // amount too high, refused by the server
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM refunds').get().n, 0);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind = 'denied'").get().n === 1);
});

test('reschedule refuses a clash with the same technician', async () => {
  const { db, call } = await setup();
  const [a, b] = db.prepare("SELECT * FROM jobs WHERE status = 'scheduled' ORDER BY technician, start_utc").all()
    .filter((j, i, all) => all.some((o) => o.technician === j.technician && o.id !== j.id)).slice(0, 2);
  if (!a || a.technician !== b.technician) return; // seed may not produce a pair; nothing to test
  const { DateTime } = await import('luxon');
  const target = DateTime.fromISO(b.start_utc).setZone('America/Chicago').toFormat("yyyy-LL-dd'T'HH:mm");
  const r = await call('reschedule_job', { job_id: a.id, new_start: target });
  assert.equal(r.ok, false);
  assert.match(r.data.error, /already has job|at least an hour/);
});
