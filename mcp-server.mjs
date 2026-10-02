// Copperline's back office as an MCP server. Tools that only read are annotated
// readOnlyHint: true. Tools that change data are readOnlyHint: false; this server executes
// them when called, and it is the host's job (approvals.mjs) to decide whether to call them.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { ZONE, TECHS, SERVICES, money } from './data.mjs';

const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const fail = (message) => ({ content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true });
const local = (utc) => DateTime.fromISO(utc).setZone(ZONE);
const dayStartUtc = (d) => DateTime.fromISO(d, { zone: ZONE }).startOf('day').toUTC().toISO();
const dayEndUtc = (d) => DateTime.fromISO(d, { zone: ZONE }).endOf('day').toUTC().toISO();
const today = () => DateTime.now().setZone(ZONE).startOf('day');
const daysOverdue = (dueOn) => Math.max(0, Math.floor(today().diff(DateTime.fromISO(dueOn, { zone: ZONE }), 'days').days));

function jobView(j) {
  const s = local(j.start_utc);
  return { job_id: j.id, customer: j.customer_name, customer_id: j.customer_id, service: SERVICES[j.service]?.label ?? j.service, technician: j.technician, when: s.toFormat("ccc d LLL, h:mm a"), start_local: s.toFormat("yyyy-LL-dd'T'HH:mm"), minutes: j.minutes, status: j.status };
}

function invoiceView(i) {
  return { invoice_id: i.id, number: i.number, customer: i.customer_name, customer_id: i.customer_id, status: i.status, issued_on: i.issued_on, due_on: i.due_on, total: money(i.total), paid: money(i.paid), balance: money(i.total - i.paid), days_overdue: i.status === 'open' && i.due_on ? daysOverdue(i.due_on) : 0 };
}

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

/**
 * Build the server. With { readOnly: true } only read tools are registered; that version is
 * safe to expose publicly over HTTP.
 */
export function createOpsServer(db, { readOnly = false } = {}) {
  const server = new McpServer({ name: 'copperline-ops', version: '1.0.0' });

  server.registerTool('search_customers', {
    description: 'Find customers by name, phone, email or street. Returns up to 8 matches with their open balance.',
    inputSchema: { query: z.string().min(2).describe('Part of a name, phone number, email or address') },
    annotations: READ,
  }, ({ query }) => {
    const q = `%${query.trim()}%`;
    const rows = db.prepare(`SELECT c.*, COALESCE((SELECT SUM(total - paid) FROM invoices i WHERE i.customer_id = c.id AND i.status = 'open'), 0) AS balance
      FROM customers c WHERE c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR c.address LIKE ? ORDER BY c.name LIMIT 8`).all(q, q, q, q);
    return json(rows.map((c) => ({ customer_id: c.id, name: c.name, phone: c.phone, city: c.city, open_balance: money(c.balance) })));
  });

  server.registerTool('get_customer', {
    description: 'Full customer record with their 10 most recent jobs and all invoices.',
    inputSchema: { customer_id: z.number().int().positive() },
    annotations: READ,
  }, ({ customer_id }) => {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(customer_id);
    if (!c) return fail(`No customer ${customer_id}`);
    const jobs = db.prepare('SELECT j.*, ? AS customer_name FROM jobs j WHERE customer_id = ? ORDER BY start_utc DESC LIMIT 10').all(c.name, customer_id);
    const invoices = db.prepare('SELECT i.*, ? AS customer_name FROM invoices i WHERE customer_id = ? ORDER BY issued_on DESC').all(c.name, customer_id);
    return json({ customer_id: c.id, name: c.name, phone: c.phone, email: c.email, address: c.address, customer_since: c.since, notes: c.notes, jobs: jobs.map(jobView), invoices: invoices.map(invoiceView) });
  });

  server.registerTool('list_jobs', {
    description: 'Jobs between two dates (inclusive, Austin time), optionally for one technician or status. Max 40 results.',
    inputSchema: {
      from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      technician: z.enum(['any', ...TECHS]).default('any'),
      status: z.enum(['any', 'scheduled', 'completed', 'cancelled']).default('any'),
    },
    annotations: READ,
  }, ({ from_date, to_date, technician, status }) => {
    const rows = db.prepare(`SELECT j.*, c.name AS customer_name FROM jobs j JOIN customers c ON c.id = j.customer_id
      WHERE j.start_utc >= ? AND j.start_utc <= ? AND (? = 'any' OR j.technician = ?) AND (? = 'any' OR j.status = ?)
      ORDER BY j.start_utc LIMIT 40`).all(dayStartUtc(from_date), dayEndUtc(to_date), technician, technician, status, status);
    return json({ count: rows.length, jobs: rows.map(jobView) });
  });

  server.registerTool('list_unpaid_invoices', {
    description: 'Open invoices with a balance, oldest first. Use min_days_overdue to find late payers (0 includes not-yet-due).',
    inputSchema: { min_days_overdue: z.number().int().min(0).default(0) },
    annotations: READ,
  }, ({ min_days_overdue }) => {
    const rows = db.prepare(`SELECT i.*, c.name AS customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id
      WHERE i.status = 'open' AND i.total > i.paid ORDER BY i.due_on`).all();
    const list = rows.map(invoiceView).filter((i) => i.days_overdue >= min_days_overdue);
    const owed = rows.filter((r) => daysOverdue(r.due_on) >= min_days_overdue).reduce((s, r) => s + r.total - r.paid, 0);
    return json({ count: list.length, total_outstanding: money(owed), invoices: list.slice(0, 30) });
  });

  server.registerTool('revenue_summary', {
    description: 'Invoiced and collected revenue between two dates, with breakdowns by service and technician.',
    inputSchema: { from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) },
    annotations: READ,
  }, ({ from_date, to_date }) => {
    const rows = db.prepare(`SELECT i.total, i.paid, j.service, j.technician FROM invoices i JOIN jobs j ON j.id = i.job_id
      WHERE i.issued_on >= ? AND i.issued_on <= ? AND i.status != 'draft'`).all(from_date, to_date);
    const sum = (f) => rows.reduce((s, r) => s + f(r), 0);
    const group = (key) => Object.entries(rows.reduce((acc, r) => ((acc[r[key]] = (acc[r[key]] ?? 0) + r.total), acc), {}))
      .sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ [key]: key === 'service' ? SERVICES[k]?.label ?? k : k, invoiced: money(v) }));
    return json({ from_date, to_date, invoices: rows.length, invoiced: money(sum((r) => r.total)), collected: money(sum((r) => r.paid)), outstanding: money(sum((r) => r.total - r.paid)), by_service: group('service'), by_technician: group('technician') });
  });

  if (readOnly) return server;

  server.registerTool('create_invoice_draft', {
    description: 'Create a draft invoice for a completed job that has none. Drafts are not sent to the customer.',
    inputSchema: {
      job_id: z.number().int().positive(),
      items: z.array(z.object({ description: z.string().min(2), amount: z.number().positive().max(50_000) })).min(1).max(10),
    },
    annotations: WRITE,
  }, ({ job_id, items }) => {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job_id);
    if (!job) return fail(`No job ${job_id}`);
    if (job.status !== 'completed') return fail(`Job ${job_id} is ${job.status}; only completed jobs can be invoiced`);
    if (db.prepare('SELECT 1 FROM invoices WHERE job_id = ?').get(job_id)) return fail(`Job ${job_id} already has an invoice`);
    const next = (db.prepare("SELECT MAX(CAST(SUBSTR(number, 5) AS INTEGER)) AS n FROM invoices").get().n ?? 1000) + 1;
    const total = items.reduce((s, i) => s + i.amount, 0);
    const r = db.prepare("INSERT INTO invoices (job_id, customer_id, number, status, total, paid, items) VALUES (?, ?, ?, 'draft', ?, 0, ?)")
      .run(job_id, job.customer_id, `INV-${next}`, total, JSON.stringify(items));
    return json({ ok: true, invoice_id: Number(r.lastInsertRowid), number: `INV-${next}`, status: 'draft', total: money(total) });
  });

  server.registerTool('send_payment_reminder', {
    description: 'Send a payment reminder for an open invoice by SMS or email.',
    inputSchema: {
      invoice_id: z.number().int().positive(),
      channel: z.enum(['sms', 'email']),
      message: z.string().min(20).max(600).describe('The exact message the customer will receive'),
    },
    annotations: WRITE,
  }, ({ invoice_id, channel, message }) => {
    const inv = db.prepare('SELECT i.*, c.phone, c.email FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?').get(invoice_id);
    if (!inv) return fail(`No invoice ${invoice_id}`);
    if (inv.status !== 'open' || inv.total <= inv.paid) return fail(`${inv.number} has no balance to collect`);
    const recipient = channel === 'sms' ? inv.phone : inv.email;
    db.prepare('INSERT INTO outbox (customer_id, channel, recipient, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(inv.customer_id, channel, recipient, message, DateTime.utc().toISO());
    return json({ ok: true, sent_to: recipient, channel, invoice: inv.number });
  });

  server.registerTool('reschedule_job', {
    description: 'Move a scheduled job to a new start time, same technician, if they are free.',
    inputSchema: { job_id: z.number().int().positive(), new_start: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).describe('Austin time, YYYY-MM-DDTHH:mm') },
    annotations: WRITE,
  }, ({ job_id, new_start }) => {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job_id);
    if (!job) return fail(`No job ${job_id}`);
    if (job.status !== 'scheduled') return fail(`Job ${job_id} is ${job.status}`);
    const start = DateTime.fromISO(new_start, { zone: ZONE });
    if (start < DateTime.now().setZone(ZONE).plus({ hours: 1 })) return fail('New time must be at least an hour from now');
    const open = start.weekday === 6 ? [9, 14] : start.weekday === 7 ? null : [8, 18];
    const end = start.plus({ minutes: job.minutes });
    if (!open || start.hour < open[0] || end > start.set({ hour: open[1], minute: 0 })) return fail('Outside business hours');
    const clash = db.prepare(`SELECT id FROM jobs WHERE technician = ? AND status = 'scheduled' AND id != ?
      AND start_utc < ? AND datetime(start_utc, '+' || minutes || ' minutes') > datetime(?)`).get(job.technician, job_id, end.toUTC().toISO(), start.toUTC().toISO());
    if (clash) return fail(`${job.technician} already has job ${clash.id} at that time`);
    db.prepare('UPDATE jobs SET start_utc = ? WHERE id = ?').run(start.toUTC().toISO(), job_id);
    return json({ ok: true, job_id, technician: job.technician, new_time: start.toFormat("ccc d LLL, h:mm a") });
  });

  server.registerTool('issue_refund', {
    description: 'Refund part or all of what a customer paid on an invoice.',
    inputSchema: { invoice_id: z.number().int().positive(), amount: z.number().positive(), reason: z.string().min(5).max(300) },
    annotations: { ...WRITE, destructiveHint: true },
  }, ({ invoice_id, amount, reason }) => {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice_id);
    if (!inv) return fail(`No invoice ${invoice_id}`);
    const refunded = db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM refunds WHERE invoice_id = ?').get(invoice_id).s;
    if (amount > inv.paid - refunded + 1e-9) return fail(`Only ${money(inv.paid - refunded)} can be refunded on ${inv.number}`);
    db.prepare('INSERT INTO refunds (invoice_id, amount, reason, created_at) VALUES (?, ?, ?, ?)').run(invoice_id, amount, reason, DateTime.utc().toISO());
    return json({ ok: true, invoice: inv.number, refunded: money(amount) });
  });

  return server;
}
