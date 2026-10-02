// Copperline's back office: customers, jobs, invoices, payments, plus the demo's outbox,
// pending actions and audit log. Demo data is generated relative to today and rebuilt daily.

import { DatabaseSync } from 'node:sqlite';
import { DateTime } from 'luxon';

export const ZONE = 'America/Chicago';
export const TECHS = ['Marcus', 'Elena', 'Jordan'];
export const SERVICES = {
  repair: { label: 'Repair visit', base: 89 },
  tuneup: { label: 'AC or furnace tune-up', base: 129 },
  install: { label: 'New system install', base: 7400 },
  thermostat: { label: 'Smart thermostat install', base: 149 },
  ductwork: { label: 'Duct cleaning and sealing', base: 480 },
};

export function openDb(path = process.env.DB_PATH ?? 'data/ops.db') {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT NOT NULL,
      address TEXT NOT NULL, city TEXT NOT NULL, since TEXT NOT NULL, notes TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
      service TEXT NOT NULL, technician TEXT NOT NULL, start_utc TEXT NOT NULL, minutes INTEGER NOT NULL,
      status TEXT NOT NULL, notes TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY, job_id INTEGER REFERENCES jobs(id), customer_id INTEGER NOT NULL REFERENCES customers(id),
      number TEXT NOT NULL UNIQUE, status TEXT NOT NULL, issued_on TEXT, due_on TEXT,
      total REAL NOT NULL, paid REAL NOT NULL DEFAULT 0, items TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS refunds (
      id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id), amount REAL NOT NULL,
      reason TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, channel TEXT NOT NULL, recipient TEXT NOT NULL,
      body TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL,
      summary TEXT NOT NULL, detail TEXT NOT NULL, required_role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', result TEXT, reported INTEGER NOT NULL DEFAULT 0, decided_by TEXT, created_at TEXT NOT NULL, decided_at TEXT
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, session_id TEXT, actor TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_days (day TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0);
  `);
  return db;
}

export const nowLocal = () => DateTime.now().setZone(ZONE);
export const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function audit(db, { sessionId = null, actor, kind, text }) {
  db.prepare('INSERT INTO audit (session_id, actor, kind, text, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, actor, kind, text, DateTime.utc().toISO());
}

// ---------- demo data ----------

const FIRST = ['Dana', 'Luis', 'Priya', 'Tom', 'Grace', 'Andre', 'Molly', 'Ken', 'Rosa', 'Sam', 'Nora', 'Victor', 'Hannah', 'Omar', 'Julia', 'Derek', 'Mei', 'Carlos', 'Beth', 'Isaac'];
const LAST = ['Whitfield', 'Ortega', 'Raman', 'Becker', 'Kim', 'Wallace', 'Shaw', 'Ito', 'Delgado', 'Okafor', 'Price', 'Nguyen', 'Brooks', 'Haddad', 'Fischer', 'Lowe'];
const STREETS = ['Oak Hollow Dr', 'S Lamar Blvd', 'Barton Hills Dr', 'Manchaca Rd', 'Burnet Rd', 'Cherrywood Rd', 'Riverside Dr', 'Pecan St', 'Hyde Park Ave', 'Westgate Blvd'];
const CITIES = [['Austin', '78704'], ['Austin', '78745'], ['Austin', '78751'], ['Round Rock', '78664'], ['Pflugerville', '78660'], ['Cedar Park', '78613']];

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Rebuild the demo business if it was last built on an earlier day. Returns true if rebuilt. */
export function ensureFreshData(db, now = nowLocal()) {
  const today = now.toISODate();
  if (db.prepare("SELECT value FROM meta WHERE key = 'seeded_on'").get()?.value === today) return false;
  db.exec('BEGIN');
  try {
    for (const t of ['refunds', 'outbox', 'actions', 'audit', 'invoices', 'jobs', 'customers']) db.exec(`DELETE FROM ${t}`);
    seed(db, now);
    db.prepare("INSERT INTO meta (key, value) VALUES ('seeded_on', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(today);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return true;
}

function seed(db, now) {
  const rand = rng(20261002);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const insC = db.prepare('INSERT INTO customers (id, name, phone, email, address, city, since, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (let id = 1; id <= 40; id++) {
    const first = FIRST[(id * 7) % FIRST.length], last = LAST[(id * 11) % LAST.length];
    const [city, zip] = pick(CITIES);
    insC.run(id, `${first} ${last}`, `512555${String(1000 + id * 137).slice(-4)}`, `${first}.${last}@example.com`.toLowerCase(),
      `${100 + Math.floor(rand() * 8800)} ${pick(STREETS)}, ${city} TX ${zip}`, city,
      now.minus({ months: 1 + Math.floor(rand() * 40) }).toISODate(), rand() < 0.15 ? 'Prefers text over calls' : '');
  }

  const insJ = db.prepare('INSERT INTO jobs (customer_id, service, technician, start_utc, minutes, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insI = db.prepare('INSERT INTO invoices (job_id, customer_id, number, status, issued_on, due_on, total, paid, items) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const weights = [...Array(9).fill('repair'), ...Array(7).fill('tuneup'), 'thermostat', 'thermostat', 'ductwork', 'install'];
  let invoiceNo = 1040;
  for (let d = -60; d <= 10; d++) {
    const day = now.startOf('day').plus({ days: d });
    if (day.weekday === 7) continue;
    for (const tech of TECHS) {
      let hour = day.weekday === 6 ? 9 : 8;
      const close = day.weekday === 6 ? 14 : 18;
      while (hour < close - 1) {
        if (rand() < 0.35) { hour += 1; continue; }
        const service = pick(weights);
        const minutes = service === 'install' ? 240 : service === 'repair' ? 90 : 60;
        if (hour * 60 + minutes > close * 60) break;
        const start = day.set({ hour, minute: 0 });
        const past = start < now;
        const status = past ? (rand() < 0.05 ? 'cancelled' : 'completed') : 'scheduled';
        const customer = 1 + Math.floor(rand() * 40);
        const job = insJ.run(customer, service, tech, start.toUTC().toISO(), minutes, status, '');
        if (status === 'completed') {
          const parts = service === 'repair' ? Math.round(rand() * 380) : 0;
          const base = service === 'install' ? SERVICES.install.base + Math.round(rand() * 2600) : SERVICES[service].base;
          const items = [{ description: SERVICES[service].label, amount: base }, ...(parts ? [{ description: 'Parts', amount: parts }] : [])];
          const total = items.reduce((s, i) => s + i.amount, 0);
          const issued = start.toISODate();
          const due = start.plus({ days: 14 }).toISODate();
          // Most customers pay within a few weeks; a few drift into the overdue list.
          const age = now.diff(start, 'days').days;
          const r = rand();
          const paidShare = age > 30 ? (r < 0.965 ? 1 : r < 0.98 ? 0.5 : 0) : age > 14 ? (r < 0.88 ? 1 : r < 0.92 ? 0.5 : 0) : (r < 0.55 ? 1 : 0);
          const paid = Math.round(total * paidShare);
          insI.run(job.lastInsertRowid, customer, `INV-${invoiceNo++}`, paid >= total ? 'paid' : 'open', issued, due, total, paid, JSON.stringify(items));
        }
        hour += Math.ceil(minutes / 60) + (rand() < 0.4 ? 1 : 0);
      }
    }
  }
}
