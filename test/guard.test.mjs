import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, getSession } from '../guard.mjs';

test('a session knows its own id, so per-session keys never collide', () => {
  const a = getSession(createSession('10.0.0.1').id);
  const b = getSession(createSession('10.0.0.2').id);
  assert.ok(a.id && b.id);
  assert.notEqual(a.id, b.id);
});

test('sessions per IP are capped', () => {
  for (let i = 0; i < 6; i++) assert.ok(createSession('10.9.9.9').id);
  assert.equal(createSession('10.9.9.9').error, 'too_many_sessions');
});
