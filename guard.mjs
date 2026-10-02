// Spend protection for the public demo. Layers, cheapest first:
//   1. proof-of-work: a browser must burn ~1s of CPU before it gets a chat session
//   2. per-session message cap and per-IP session cap
//   3. daily AI call limit and daily dollar budget, tracked in the database
//   4. AI_ENABLED kill switch
// The provider-side monthly spend limit (set in the Anthropic console) sits behind all of these.

import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DateTime } from 'luxon';

const env = (k, d) => process.env[k] ?? d;
export const LIMITS = {
  aiEnabled: env('AI_ENABLED', 'true') !== 'false',
  powBits: Number(env('POW_BITS', 17)),
  messagesPerSession: Number(env('MESSAGES_PER_SESSION', 14)),
  sessionsPerIpPerHour: Number(env('SESSIONS_PER_IP_PER_HOUR', 6)),
  dailyCalls: Number(env('DAILY_AI_CALLS', 400)),
  dailyBudgetUsd: Number(env('DAILY_BUDGET_USD', 1.5)),
  maxMessageChars: 600,
};

const SECRET = env('GUARD_SECRET', randomBytes(32).toString('hex'));
const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (s) => createHmac('sha256', SECRET).update(s).digest('base64url');

// ---------- proof of work ----------

export function issueChallenge() {
  const body = { id: randomBytes(12).toString('hex'), salt: randomBytes(16).toString('hex'), bits: LIMITS.powBits, exp: Date.now() + 5 * 60_000 };
  const encoded = b64(JSON.stringify(body));
  return { token: `${encoded}.${sign(encoded)}`, salt: body.salt, bits: body.bits };
}

const usedChallenges = new Map(); // id -> expiry, so a solved challenge can't be replayed

function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

export function verifyChallenge(token, nonce) {
  const [encoded, mac] = String(token ?? '').split('.');
  if (!encoded || !mac) return 'malformed';
  const expected = Buffer.from(sign(encoded));
  if (expected.length !== Buffer.from(mac).length || !timingSafeEqual(expected, Buffer.from(mac))) return 'bad_signature';
  const body = JSON.parse(Buffer.from(encoded, 'base64url').toString());
  if (Date.now() > body.exp) return 'expired';
  if (usedChallenges.has(body.id)) return 'replayed';
  const hash = createHash('sha256').update(`${body.salt}:${nonce}`).digest();
  if (leadingZeroBits(hash) < body.bits) return 'wrong_answer';
  usedChallenges.set(body.id, body.exp);
  return null;
}

// ---------- sessions ----------

const sessions = new Map(); // id -> { ip, created, lastSeen, turns, cost, messages }
const ipSessions = new Map(); // ip -> [timestamps]

export function createSession(ip) {
  const hourAgo = Date.now() - 3_600_000;
  const recent = (ipSessions.get(ip) ?? []).filter((t) => t > hourAgo);
  if (recent.length >= LIMITS.sessionsPerIpPerHour) return { error: 'too_many_sessions' };
  recent.push(Date.now());
  ipSessions.set(ip, recent);
  const id = randomBytes(16).toString('hex');
  sessions.set(id, { id, ip, created: Date.now(), lastSeen: Date.now(), turns: 0, cost: 0, messages: [], role: 'dispatcher' });
  return { id };
}

export const getSession = (id) => {
  const s = sessions.get(id);
  if (s) s.lastSeen = Date.now();
  return s;
};

// Housekeeping every 5 minutes: idle sessions expire after 30 minutes.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.lastSeen > 30 * 60_000) sessions.delete(id);
  for (const [id, exp] of usedChallenges) if (now > exp) usedChallenges.delete(id);
  for (const [ip, ts] of ipSessions) if (!ts.some((t) => t > now - 3_600_000)) ipSessions.delete(ip);
}, 5 * 60_000).unref();

// ---------- daily budget ----------

export function initUsage(db) {
  db.exec('CREATE TABLE IF NOT EXISTS usage_days (day TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0)');
}

const today = () => DateTime.utc().toISODate();

export function usageToday(db) {
  return db.prepare('SELECT calls, cost_usd FROM usage_days WHERE day = ?').get(today()) ?? { calls: 0, cost_usd: 0 };
}

/** Reason the AI can't be called right now, or null. */
export function aiBlocked(db) {
  if (!LIMITS.aiEnabled) return 'disabled';
  const u = usageToday(db);
  if (u.calls >= LIMITS.dailyCalls) return 'daily_call_limit';
  if (u.cost_usd >= LIMITS.dailyBudgetUsd) return 'daily_budget';
  return null;
}

export function recordUsage(db, costUsd) {
  db.prepare(`INSERT INTO usage_days (day, calls, cost_usd) VALUES (?, 1, ?)
    ON CONFLICT(day) DO UPDATE SET calls = calls + 1, cost_usd = cost_usd + excluded.cost_usd`).run(today(), costUsd);
}
