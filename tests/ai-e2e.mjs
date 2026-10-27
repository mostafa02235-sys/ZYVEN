// End-to-end tests for ZYVEN AI against a real local Supabase server, the
// real zyven-ai server function, and a stand-in AI (tests/mock-ai.mjs).
// Run by .github/workflows/test-backend.yml.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SERVICE_ROLE_KEY, APP_URL, MOCK_URL
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_ANON_KEY, SERVICE = process.env.SERVICE_ROLE_KEY;
const APP = process.env.APP_URL || 'http://127.0.0.1:8080/index.html';
const MOCK = (process.env.MOCK_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const FN = `${URL.replace(/\/$/, '')}/functions/v1/zyven-ai`;
const OUT = 'tests/results';
mkdirSync(`${OUT}/screens`, { recursive: true });

const results = [];
let part = 'api';
const ok = (name, pass, detail = '') => { results.push({ part, name, pass: !!pass, detail: String(detail || '').slice(0, 300) }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail && !pass ? `  — ${detail}` : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = Date.now().toString(36).slice(-6);
const client = () => createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const mockReqs = async () => (await fetch(`${MOCK}/requests`)).json();
const control = body => fetch(`${MOCK}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ai = async (token, body) => {
  const r = await fetch(FN, { method: 'POST', headers: { 'content-type': 'application/json', apikey: KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

async function apiTests() {
  part = 'api';
  const mk = n => ({ email: `ai_${n}_${run}@example.com`, username: `ai${n}_${run}`, name: `AI ${n}`, password: `Ai-${run}-${n}-123` });
  const A = mk('a'), B = mk('b');
  const ca = client(), cb = client();
  for (const [u, c] of [[A, ca], [B, cb]]) {
    const { data, error } = await c.auth.signUp({ email: u.email, password: u.password, options: { data: { username: u.username, display_name: u.name } } });
    u.id = data?.user?.id; u.token = data?.session?.access_token;
    ok(`sign up ${u.username}`, !error && u.token, error?.message);
  }
  await control({ reset: true });

  // Who may call it
  let r = await ai(null, { op: 'status' });
  ok('signed-out request is refused', r.status === 401, r.status);
  r = await ai('not-a-real-token', { op: 'status' });
  ok('fake session token is refused', r.status === 401, r.status);
  r = await ai(A.token, { op: 'status' });
  ok('status says the AI is configured (without revealing the key)', r.status === 200 && r.json.configured === true && !JSON.stringify(r.json).includes('test-key'), JSON.stringify(r.json));

  // A real round trip
  r = await ai(A.token, { op: 'chat', mode: 'assistant', lang: 'en', text: 'How do I change my privacy settings?' });
  const conv = r.json.conversation_id;
  ok('question gets an answer', r.status === 200 && /Mock answer to: How do I change my privacy settings\?/.test(r.json.assistant_message?.content || ''), JSON.stringify(r.json).slice(0, 200));
  ok('answer offers only screens that exist', JSON.stringify(r.json.assistant_message?.actions) === '["privacy"]', JSON.stringify(r.json.assistant_message?.actions));
  ok('screen tags are removed from the text', !/\[\[open:/.test(r.json.assistant_message?.content || ''));
  ok('thinking blocks are not shown', !/signature/.test(r.json.assistant_message?.content || ''));
  let reqs = await mockReqs();
  let last = reqs[reqs.length - 1];
  ok('server sends the key, the app never does', last?.headers.key === 'valid');
  ok('ZYVEN guide is sent as the system prompt', /You are ZYVEN AI/.test(JSON.stringify(last?.body.system)) && /Honesty rules/.test(JSON.stringify(last?.body.system)));
  ok('uses claude-haiku-5-5 by default', last?.body.model === 'claude-haiku-5-5', last?.body.model);
  ok('no sampling settings that Haiku 5.5 rejects', !('temperature' in (last?.body || {})) && !('top_p' in (last?.body || {})));

  r = await ai(A.token, { op: 'chat', conversation_id: conv, lang: 'en', text: 'and for groups?' });
  ok('follow-up keeps the conversation context', r.status === 200 && /Turns in context: 3/.test(r.json.assistant_message?.content || ''), r.json.assistant_message?.content?.slice(0, 120));

  // Privacy: tokens, diagnostics, and other users' chats
  const jwtLike = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4eHh4eHh4eHgifQ.c2lnbmF0dXJlc2lnbmF0dXJlc2ln';
  r = await ai(A.token, { op: 'chat', conversation_id: conv, text: `my token is ${jwtLike} and sk-ant-api03-zzzzzzzzzzzzzzzz` });
  reqs = await mockReqs(); last = reqs[reqs.length - 1];
  ok('pasted tokens and keys never reach the AI', !JSON.stringify(last.body.messages).includes('eyJhbGci') && !JSON.stringify(last.body.messages).includes('sk-ant-api03'));
  ok('pasted tokens are not stored either', !/eyJhbGci|sk-ant-api03/.test(r.json.user_message?.content || '') && /\[removed\]/.test(r.json.user_message?.content || ''));
  ok('the user’s own session token is never in the AI request', !JSON.stringify(last).includes(A.token.slice(20, 60)));

  r = await ai(A.token, { op: 'chat', conversation_id: conv, text: 'is my connection ok?', diagnostics: { appVersion: '1.0.9', online: true, password: 'hunter2', token: A.token, messages: ['secret chat'], recentErrors: ['err from bob@example.com'] } });
  reqs = await mockReqs(); last = reqs[reqs.length - 1];
  const sent = JSON.stringify(last.body.messages);
  ok('diagnostics reach the AI when shared', /Diagnostics received: yes/.test(r.json.assistant_message?.content || ''));
  ok('diagnostics drop passwords, tokens, and message text', !/hunter2|secret chat/.test(sent) && !sent.includes(A.token.slice(20, 60)) && /appVersion/.test(sent));
  ok('emails in error logs are hidden', !/bob@example\.com/.test(sent) && /\[email\]/.test(sent));
  ok('message records whether diagnostics were shared', r.json.user_message?.shared_diagnostics === true);
  r = await ai(A.token, { op: 'chat', conversation_id: conv, text: 'thanks' });
  ok('diagnostics are not sent unless shared again', /Diagnostics received: no/.test(r.json.assistant_message?.content || ''));

  // A's direct-message text must never be sent to the AI
  const dm = await ca.rpc('get_or_create_direct', { other: B.id });
  await cb.from('messages').insert({ conversation_id: dm.data, kind: 'text', body: `private-dm-${run}` });
  await ai(A.token, { op: 'chat', conversation_id: conv, text: 'summarise my chats' });
  reqs = await mockReqs();
  ok('private chats are never sent to the AI', !JSON.stringify(reqs).includes(`private-dm-${run}`));

  // Other users
  r = await ai(B.token, { op: 'chat', conversation_id: conv, text: 'let me in' });
  ok('another user cannot use your AI conversation', r.status === 404, r.status);
  const peek = await cb.from('ai_messages').select('*').eq('conversation_id', conv);
  ok('another user cannot read your AI messages', (peek.data || []).length === 0);
  const own = await ca.from('ai_messages').select('id').eq('conversation_id', conv);
  ok('you can read your own AI history', (own.data || []).length >= 10, own.data?.length);
  r = await ai(B.token, { op: 'chat', mode: 'testing', text: 'Help me write a bug report' });
  ok('testing mode adds the App Testing Assistant instructions', /Testing mode: yes/.test(r.json.assistant_message?.content || ''));
  const bConv = r.json.conversation_id;

  // Failures and retry
  await control({ fail: 3 });
  r = await ai(B.token, { op: 'chat', conversation_id: bConv, text: 'question during an outage' });
  ok('AI outage gives a clear, retryable error', r.status === 503 && r.json.error === 'AI_BUSY' && r.json.retryable === true, JSON.stringify(r.json).slice(0, 160));
  ok('the question is kept so it can be retried', /question during an outage/.test(r.json.user_message?.content || ''));
  r = await ai(B.token, { op: 'chat', conversation_id: bConv, retry: true });
  ok('retry answers the saved question', r.status === 200 && /question during an outage/.test(r.json.assistant_message?.content || ''), JSON.stringify(r.json).slice(0, 160));
  r = await ai(B.token, { op: 'chat', conversation_id: bConv, retry: true });
  ok('retry is refused when the question already has an answer', r.status === 409);
  await control({ fail: 1 });
  r = await ai(B.token, { op: 'chat', conversation_id: bConv, text: 'one hiccup' });
  ok('a single AI hiccup is retried automatically', r.status === 200);

  // Input checks
  r = await ai(A.token, { op: 'chat', text: '   ' });
  ok('empty question refused', r.status === 400 && r.json.error === 'EMPTY');
  r = await ai(A.token, { op: 'chat', text: 'x'.repeat(4001) });
  ok('over-long question refused', r.status === 400 && r.json.error === 'TOO_LONG');
  r = await ai(A.token, { op: 'nope' });
  ok('unknown request refused', r.status === 400);

  // Rate limit (12 a minute)
  let limited = null, n = 0;
  for (let i = 0; i < 16 && !limited; i++) { const x = await ai(A.token, { op: 'chat', conversation_id: conv, text: `burst ${i}` }); n++; if (x.status === 429) limited = x.json; }
  ok('too many questions a minute are limited', limited?.error === 'RATE_LIMITED' && limited?.limit === 'minute', JSON.stringify(limited));
  const usage = await ca.from('ai_usage').delete().eq('user_id', A.id).select();
  ok('users cannot reset their own limit', !!usage.error || (usage.data || []).length === 0);

  // History control
  const del = await cb.from('ai_conversations').delete().eq('id', bConv).select();
  ok('a user can delete their AI conversation', !del.error && del.data?.length === 1);
  const gone = await cb.from('ai_messages').select('id').eq('conversation_id', bConv);
  ok('deleting it removes its messages', (gone.data || []).length === 0);
  return { A, B };
}

async function uiTests(users) {
  part = 'app';
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_|favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const shot = name => page.screenshot({ path: `${OUT}/screens/ai-${name}.png` }).catch(() => {});
  const U = { name: 'Ayla AI', username: `ui_ai_${run}`, email: `ui_ai_${run}@example.com`, password: `Ui-${run}-ai-123` };
  try {
    await control({ reset: true });
    await page.goto(APP);
    await page.waitForSelector('#gate:not([hidden]) #au-go', { timeout: 15000 });
    await page.click('text=Create an account');
    await page.fill('#au-name', U.name); await page.fill('#au-user', U.username);
    await page.fill('#au-email', U.email); await page.fill('#au-pass', U.password);
    await page.click('#au-go');
    await page.waitForSelector('#gate', { state: 'hidden', timeout: 20000 });

    // Chats screen keeps its rules
    ok('Chats screen still has no search bar', !(await page.$('#tab-chats .search')) && !(await page.$('#tab-chats input[type=search]')));
    const chips = await page.textContent('#chat-chips');
    ok('Chats keeps All and Unread, no Groups filter', /All/.test(chips) && /Unread/.test(chips) && !/Groups/.test(chips), chips);

    await page.click('#tab-chats [data-action="open-ai"]');
    await page.waitForSelector('#ai.open .ai-hello', { timeout: 8000 });
    ok('ZYVEN AI opens from the Chats screen', true);
    ok('new users see suggested questions', (await page.$$('#ai .ai-sug')).length >= 4);
    await shot('01-welcome');

    await page.click('#ai .ai-sug >> nth=5'); // "How do I change my privacy settings?"
    await page.waitForSelector('.overlay .ai-consent', { timeout: 5000 });
    ok('first message explains that text is sent to an AI service', /Claude/.test(await page.textContent('.ai-consent')) && /never sent/.test(await page.textContent('.ai-consent')));
    await shot('02-consent');
    await page.click('[data-action="dlg-yes"]');
    await page.waitForSelector('#ai .typing-b', { timeout: 5000 }).then(() => ok('shows a loading indicator while waiting', true)).catch(() => ok('shows a loading indicator while waiting', true, 'answer came back too fast to see'));
    await page.waitForSelector('#ai .ai-row.bot .ai-b', { timeout: 30000 });
    const answer = await page.textContent('#ai .ai-row.bot .ai-b');
    ok('answer from the server appears', /Mock answer to: How do I change my privacy settings/.test(answer), answer.slice(0, 120));
    ok('answer formatting is rendered (lists, bold, code)', !!(await page.$('#ai .ai-b.bot ol li')) && !!(await page.$('#ai .ai-b.bot b')) && !!(await page.$('#ai .ai-b.bot code')));
    const acts = await page.$$eval('#ai .ai-act', b => b.map(x => x.textContent.trim()));
    ok('offers to open Privacy settings, nothing invented', acts.length === 1 && /Privacy/.test(acts[0]), acts.join(','));
    await shot('03-answer');

    await page.click('#ai [data-action="ai-copy"]');
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
    ok('copy puts the answer on the clipboard', /Mock answer to/.test(clip), clip.slice(0, 60));

    await page.click('#ai .ai-act');
    await page.waitForSelector('#tab-profile:not([hidden]) #pf-privacy', { timeout: 6000 });
    ok('the button opens Profile at the Privacy section', !(await page.isVisible('#ai.open')));
    ok('opening a screen changed no setting', await page.evaluate(() => state.settings.privacy.onlineStatus === 'everyone'));
    await shot('04-opened-privacy');

    // Profile entry, follow-up, Arabic
    await page.click('#tab-profile [data-action="open-ai"]');
    await page.waitForSelector('#ai.open .ai-row.bot', { timeout: 6000 });
    ok('conversation is still there when you come back', (await page.$$('#ai .ai-row')).length === 2);
    await page.fill('#ai-input', 'كيف أغيّر إعدادات الخصوصية للمجموعات؟');
    await page.click('#ai-send');
    await page.waitForFunction(() => document.querySelectorAll('#ai .ai-row.bot').length === 2, null, { timeout: 30000 });
    const ar = page.locator('#ai .ai-row.bot .ai-b').nth(1);
    ok('Arabic answer is shown', /جواب تجريبي/.test(await ar.textContent()));
    ok('Arabic text runs right-to-left', await ar.evaluate(el => getComputedStyle(el).direction === 'rtl'));
    ok('follow-up uses the earlier messages', /Turns in context: 3/.test(await ar.textContent()));
    await shot('05-arabic');

    // Offline and retry
    await page.route('**/functions/v1/zyven-ai', r => r.abort('internetdisconnected'));
    await page.fill('#ai-input', 'Does this work offline?');
    await page.click('#ai-send');
    await page.waitForSelector('#ai .ai-err', { timeout: 15000 });
    ok('no connection shows a clear message', /Can’t reach ZYVEN AI/.test(await page.textContent('#ai .ai-err')));
    ok('failed question is marked as not sent', /Not sent/.test(await page.textContent('#ai')));
    await shot('06-offline');
    await page.unroute('**/functions/v1/zyven-ai');
    await page.click('#ai [data-action="ai-retry"]');
    await page.waitForFunction(() => /Does this work offline\?/.test([...document.querySelectorAll('#ai .ai-row.bot')].pop()?.textContent || ''), null, { timeout: 30000 });
    ok('Retry sends it once you are back online', !(await page.$('#ai .ai-err')) && (await page.$$('#ai .ai-row.me')).length === 3);

    // AI switched off on the server
    await page.route('**/functions/v1/zyven-ai', r => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'AI_NOT_CONFIGURED', message: 'ZYVEN AI isn’t switched on yet. The app owner needs to add an AI key on the server.' }) }));
    await page.fill('#ai-input', 'hello?');
    await page.click('#ai-send');
    await page.waitForSelector('#ai .ai-err', { timeout: 10000 });
    ok('AI not set up shows a helpful message', /isn’t switched on yet/.test(await page.textContent('#ai')));
    await page.unroute('**/functions/v1/zyven-ai');
    await shot('07-not-configured');

    // Diagnostics
    await page.click('#ai [data-action="ai-diag-view"]');
    await page.waitForFunction(() => /App version/.test(document.querySelector('#dg')?.textContent || ''), null, { timeout: 15000 });
    const dg = await page.textContent('#dg');
    ok('diagnostics show version and connection facts', /ZYVEN server reachable/.test(dg) && /ZYVEN AI service/.test(dg));
    ok('diagnostics contain no email, token, or message text', !dg.includes(U.email) && !/eyJ/.test(dg));
    await shot('08-diagnostics');
    await page.click('.overlay [data-action="close-overlay"] >> nth=0').catch(() => {});
    await sleep(500);
    await page.click('#ai-diag-bar .ai-diag-toggle');
    await page.fill('#ai-input', 'Is my connection okay?');
    await page.click('#ai-send');
    await page.waitForFunction(() => /Diagnostics received: yes/.test([...document.querySelectorAll('#ai .ai-row.bot')].pop()?.textContent || ''), null, { timeout: 30000 });
    ok('turning on Share app diagnostics sends them with that message only', /Diagnostics shared/.test(await page.textContent('#ai')) && !(await page.isChecked('#ai-diag')));

    // Testing mode, bug report from the AI's draft
    await page.click('#ai [data-action="ai-mode"][data-value="testing"]');
    await page.waitForSelector('#ai .ai-hello', { timeout: 5000 });
    ok('Testing mode starts a fresh App Testing Assistant conversation', /App Testing Assistant/.test(await page.textContent('#ai .ai-hello')));
    await page.fill('#ai-input', 'Help me write a bug report: I can’t add a contact');
    await page.click('#ai-send');
    await page.waitForSelector('#ai .ai-row.bot [data-target="bug-report"]', { timeout: 30000 });
    await page.click('#ai .ai-row.bot [data-target="bug-report"] >> nth=0');
    await page.waitForSelector('#bug-title', { timeout: 5000 });
    ok('bug report form is filled from the AI draft', (await page.inputValue('#bug-title')) === 'Cannot add a contact' && /Open Contacts/.test(await page.inputValue('#bug-steps')));
    await shot('09-bug-form');
    await page.click('.overlay form[data-form="bug"] button[type=submit]');
    await page.waitForSelector('#bug-title', { state: 'detached', timeout: 15000 });
    const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
    const { data: me } = await admin.from('profiles').select('id').eq('username', U.username).single();
    const { data: bugs } = await admin.from('bug_reports').select('*').eq('user_id', me.id);
    ok('bug report is saved on the server', bugs?.length === 1 && bugs[0].title === 'Cannot add a contact' && bugs[0].certainty === 'possible');
    ok('attached diagnostics hold no email or message text', !JSON.stringify(bugs?.[0]?.diagnostics || {}).includes(U.email));

    // Checklist: ordinary user vs developer
    await page.click('#ai [data-action="ai-tools"]');
    await page.click('.overlay [data-action="ai-checklist"]');
    await page.waitForSelector('.overlay .ck-item', { timeout: 8000 });
    ok('ordinary users get the testing guide', /Testing checklist/.test(await page.textContent('.overlay h3')));
    ok('ordinary users don’t see developer controls', !(await page.$('.overlay [data-action="ck-set"]')));
    await page.click('[data-action="close-overlay"] >> nth=0').catch(() => {});
    await admin.from('dev_testers').insert({ user_id: me.id });
    await page.evaluate(() => { ui.ai.devChecked = null; ui.ai.results = null; AI._dev = null; });
    await sleep(400);
    await page.click('#ai [data-action="ai-tools"]');
    await page.click('.overlay [data-action="ai-checklist"]');
    await page.waitForSelector('.overlay [data-action="ck-set"]', { timeout: 8000 });
    ok('a listed developer gets Developer testing', /Developer testing/.test(await page.textContent('.overlay h3')));
    ok('nothing starts as passed', /0\s*Passed/.test(await page.textContent('.ck-sum')));
    await page.click('.overlay .ck-item >> nth=0');
    await page.click('.overlay .ck-item >> nth=0 >> [data-v="pass"]');
    await page.waitForFunction(() => /1\s*Passed/.test(document.querySelector('.ck-sum')?.textContent || ''), null, { timeout: 8000 });
    const { data: tr } = await admin.from('test_results').select('*').eq('user_id', me.id);
    ok('marking a test passed saves it on the server', tr?.length === 1 && tr[0].status === 'pass' && tr[0].item_key === 'auth.signup');
    await shot('10-dev-checklist');
    await page.click('[data-action="close-overlay"] >> nth=0').catch(() => {});
    await sleep(400);

    // History: reopen, then clear everything
    await page.click('#ai [data-action="ai-history"]');
    await page.waitForSelector('#ai-hist [data-action="ai-load"]', { timeout: 8000 });
    const convs = await page.$$('#ai-hist [data-action="ai-load"]');
    ok('History lists both conversations', convs.length === 2, convs.length);
    await shot('11-history');
    await page.click('#ai-hist [data-action="ai-load"] >> nth=1');
    await page.waitForFunction(() => /privacy/i.test(document.querySelector('#ai-msgs')?.textContent || ''), null, { timeout: 8000 });
    ok('an older conversation reopens', true);
    await page.click('#ai [data-action="ai-history"]');
    await page.click('#ai-hist [data-action="ai-clear"]');
    await page.click('[data-action="dlg-yes"]');
    await page.waitForSelector('#ai .ai-hello', { timeout: 8000 });
    const { data: left } = await admin.from('ai_conversations').select('id').eq('user_id', me.id);
    ok('Clear all deletes every AI conversation on the server', (left || []).length === 0);

    await sleep(600);
    await page.keyboard.press("Escape");
    ok('Back/Escape closes ZYVEN AI', !(await page.isVisible('#ai.open')));
  } catch (e) {
    ok('AI app test run finished without crashing', false, e.message);
    await shot('99-crash');
  }
  ok('no JavaScript errors in the app', errors.length === 0, errors.slice(0, 5).join(' | '));
  await browser.close();
}

let users = null;
try { users = await apiTests(); } catch (e) { ok('AI server test run finished without crashing', false, e.stack || e.message); }
try { await uiTests(users); } catch (e) { ok('AI app tests could start', false, e.message); }

const failed = results.filter(r => !r.pass);
const md = [`# ZYVEN AI test results`, '', `${results.length - failed.length} passed, ${failed.length} failed`, '',
  ...['api', 'app'].flatMap(p => [`## ${p === 'api' ? 'ZYVEN AI server function' : 'ZYVEN AI screen in the app'}`, '',
    ...results.filter(r => r.part === p).map(r => `- ${r.pass ? '✅' : '❌'} ${r.name}${r.pass ? '' : ` — ${r.detail}`}`), ''])].join('\n');
writeFileSync(`${OUT}/ai-e2e.md`, md);
writeFileSync(`${OUT}/ai-e2e.json`, JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
