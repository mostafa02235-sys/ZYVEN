// Unit tests for the ZYVEN AI server helpers. Run: node --test tests/ai-helpers.test.mjs
// (Node 22.18+ runs the .ts helpers directly.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, cleanDiagnostics, extractActions, buildHistory } from '../supabase/functions/zyven-ai/helpers.ts';
import { ACTIONS, SYSTEM_PROMPT, TESTING_PROMPT } from '../supabase/functions/zyven-ai/prompt.ts';

test('redact removes tokens and API keys', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const out = redact(`my token ${jwt} and sk-ant-api03-abcdefghijklmnop and sb_secret_abcdefghijklmn`);
  assert.ok(!out.includes('eyJ'));
  assert.ok(!out.includes('sk-ant-'));
  assert.ok(!out.includes('sb_secret_'));
  assert.equal((out.match(/\[removed\]/g) || []).length, 3);
  assert.equal(redact('How do I make a group?'), 'How do I make a group?');
});

test('diagnostics keep only the allowed fields', () => {
  const d = cleanDiagnostics({
    appVersion: '1.0.0', online: true, serverLatencyMs: 123.7, platform: 'android',
    password: 'hunter2', accessToken: 'eyJx', messages: ['hi'], chats: 'lots', email: 'a@b.c',
    recentErrors: ['12:00:01 Can’t reach the server', 'sent by bob@example.com', 42],
  });
  assert.deepEqual(Object.keys(d).sort(), ['appVersion', 'online', 'platform', 'recentErrors', 'serverLatencyMs']);
  assert.equal(d.serverLatencyMs, 124);
  assert.deepEqual(d.recentErrors, ['12:00:01 Can’t reach the server', 'sent by [email]']);
  assert.equal(cleanDiagnostics(null), null);
  assert.equal(cleanDiagnostics([1, 2]), null);
  assert.equal(cleanDiagnostics({ password: 'x' }), null);
});

test('only real screens become buttons', () => {
  const r = extractActions('Go to Profile → Privacy.\n\n[[open:privacy]]\n[[open:delete-account]]\n[[open:privacy]]');
  assert.deepEqual(r.actions, ['privacy']);
  assert.equal(r.text, 'Go to Profile → Privacy.');
  const many = extractActions('x [[open:chats]] [[open:groups]] [[open:profile]] [[open:saved]]');
  assert.equal(many.actions.length, 3);
});

test('every action the prompt offers exists', () => {
  for (const k of Object.keys(ACTIONS)) assert.match(SYSTEM_PROMPT, new RegExp(`- ${k}: `));
  assert.match(TESTING_PROMPT, /Never say a test passed/);
  assert.match(SYSTEM_PROMPT, /Never claim you did, checked, or tested something/);
});

test('history is trimmed and starts with the user', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
  const h = buildHistory(rows);
  assert.ok(h.length <= 24);
  assert.equal(h[0].role, 'user');
  assert.equal(h[h.length - 1].content, 'm39');
  const big = [{ role: 'user', content: 'a'.repeat(20000) }, { role: 'assistant', content: 'b'.repeat(20000) }, { role: 'user', content: 'latest' }];
  const t = buildHistory(big);
  assert.equal(t.length, 1); assert.equal(t[0].content, 'latest');
  const dup = buildHistory([{ role: 'user', content: 'q1' }, { role: 'user', content: 'q1 again' }]);
  assert.equal(dup.length, 1); assert.match(dup[0].content, /q1 again/);
});
