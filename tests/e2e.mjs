// End-to-end tests for ZYVEN against a real (local) Supabase server.
// Run by .github/workflows/test-backend.yml after `supabase start`.
//
// Part 1 talks to the server the way the app does (supabase-js + anon key)
// with three separate accounts. Part 2 drives the real app (www/) in two
// separate browser sessions with Playwright.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, MAIL_URL (Mailpit/Inbucket), APP_URL
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_ANON_KEY;
const MAIL = (process.env.MAIL_URL || 'http://127.0.0.1:54324').replace(/\/$/, '');
const APP = process.env.APP_URL || 'http://127.0.0.1:8080/index.html';
const OUT = 'tests/results';
mkdirSync(`${OUT}/screens`, { recursive: true });

const results = [];
const ok = (name, pass, detail = '') => { results.push({ part: part, name, pass: !!pass, detail: String(detail || '').slice(0, 300) }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail && !pass ? `  — ${detail}` : ''}`); };
let part = 'api';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 12000, step = 250) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { /* retry */ } await sleep(step); } return null; };
const run = Date.now().toString(36).slice(-6);
const client = () => createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const expectErr = async (name, p, re) => {
  try { const r = await p; const e = r?.error; ok(name, e && (!re || re.test(`${e.message} ${e.code || ''}`)), e ? e.message : 'no error'); }
  catch (e) { ok(name, !re || re.test(e.message), e.message); }
};

async function mailCode(email) {
  // Mailpit (current Supabase CLI)
  const code = await until(async () => {
    const r = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    if (r.ok) {
      const j = await r.json();
      const id = j.messages?.[0]?.ID; if (!id) return null;
      const m = await (await fetch(`${MAIL}/api/v1/message/${id}`)).json();
      return (`${m.Text || ''} ${m.HTML || ''}`.match(/\b(\d{6,10})\b/) || [])[1];
    }
    // Inbucket (older CLI)
    const box = email.split('@')[0];
    const list = await (await fetch(`${MAIL}/api/v1/mailbox/${box}`)).json();
    const last = list?.[list.length - 1]; if (!last) return null;
    const m = await (await fetch(`${MAIL}/api/v1/mailbox/${box}/${last.id}`)).json();
    return (`${m.body?.text || ''} ${m.body?.html || ''}`.match(/\b(\d{6,10})\b/) || [])[1];
  }, 20000, 1000);
  return code;
}

async function apiTests() {
  part = 'api';
  const mk = n => ({ email: `zyv_${n}_${run}@example.com`, username: `${n}_${run}`, name: `Test ${n.toUpperCase()}`, password: `Pw-${run}-${n}-123` });
  const A = mk('a'), B = mk('b'), C = mk('c');
  const ca = client(), cb = client(), cc = client();
  for (const [u, c] of [[A, ca], [B, cb], [C, cc]]) {
    const { data, error } = await c.auth.signUp({ email: u.email, password: u.password, options: { data: { username: u.username, display_name: u.name } } });
    ok(`sign up ${u.username}`, !error && data.session, error?.message);
    u.id = data?.user?.id; u.token = data?.session?.access_token;
  }
  ok('each account has a unique id', A.id && B.id && C.id && new Set([A.id, B.id, C.id]).size === 3);
  const { data: prof } = await ca.from('profiles').select('id,username,display_name').eq('id', A.id).maybeSingle();
  ok('profile row created at sign-up', prof?.username === A.username && prof.display_name === A.name);
  await expectErr('duplicate email rejected', client().auth.signUp({ email: A.email, password: 'another-pass-123', options: { data: { username: `dup_${run}`, display_name: 'Dup' } } }), /registered|exists/i);
  await expectErr('duplicate username rejected', client().auth.signUp({ email: `zyv_dup_${run}@example.com`, password: 'another-pass-123', options: { data: { username: A.username, display_name: 'Dup' } } }), /Database error|USERNAME_TAKEN/i);
  ok('username_available sees taken name', (await client().rpc('username_available', { name: A.username })).data === false);
  await expectErr('wrong password rejected', client().auth.signInWithPassword({ email: A.email, password: 'wrong-password' }), /Invalid login/i);

  // search
  const s1 = (await ca.rpc('search_profiles', { q: B.username.slice(0, 4) })).data || [];
  ok('search finds a real registered user', s1.some(p => p.id === B.id));
  ok('search never returns yourself', !((await ca.rpc('search_profiles', { q: A.username })).data || []).some(p => p.id === A.id));
  ok('search with no match returns nothing (no invented people)', ((await ca.rpc('search_profiles', { q: `nobody_${run}_zz` })).data || []).length === 0);
  const anonSearch = await client().rpc('search_profiles', { q: 'a' });
  ok('signed-out visitors cannot search', !!anonSearch.error);

  // contacts
  ok('add contact', !(await ca.from('contacts').insert({ contact_id: B.id })).error);
  await expectErr('duplicate contact rejected', ca.from('contacts').insert({ contact_id: B.id }), /duplicate|23505/);
  await expectErr('cannot add yourself', ca.from('contacts').insert({ contact_id: A.id }), /check|23514/);
  ok('contacts are private', ((await cb.from('contacts').select('*')).data || []).length === 0);

  // conversation
  const d1 = await ca.rpc('get_or_create_direct', { other: B.id });
  const d2 = await ca.rpc('get_or_create_direct', { other: B.id });
  const d3 = await cb.rpc('get_or_create_direct', { other: A.id });
  ok('direct chat created', !d1.error && d1.data, d1.error?.message);
  ok('no duplicate direct chats (either side)', d1.data === d2.data && d1.data === d3.data);
  await expectErr('cannot open a chat with yourself', ca.rpc('get_or_create_direct', { other: A.id }), /SELF/);
  const conv = d1.data;

  // realtime delivery
  const got = [];
  await cb.realtime.setAuth(B.token); await cc.realtime.setAuth(C.token);
  const ch = cb.channel('t-b').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, e => got.push(e.new));
  await new Promise(res => ch.subscribe(st => { if (st === 'SUBSCRIBED') res(); }));
  const spy = []; // C must never get A↔B messages
  const chc = cc.channel('t-c').on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, e => spy.push(e.new));
  await new Promise(res => chc.subscribe(st => { if (st === 'SUBSCRIBED') res(); }));
  await sleep(6000); // let the server finish registering both listeners
  const ins = await ca.from('messages').insert({ conversation_id: conv, kind: 'text', body: 'hello from A' }).select('id,created_at,sender_id').single();
  ok('A sends a message', !ins.error && ins.data.sender_id === A.id, ins.error?.message);
  const live = await until(() => got.find(m => m.id === ins.data?.id), 25000);
  ok('B receives it in real time', !!live && live.body === 'hello from A');
  await sleep(3000);
  ok('outsider C gets no realtime event for it', !spy.some(m => m.conversation_id === conv));
  ok('B can load the message history', ((await cb.from('messages').select('id').eq('conversation_id', conv)).data || []).length === 1);
  ok('outsider C cannot read it', ((await cc.from('messages').select('id').eq('conversation_id', conv)).data || []).length === 0);
  await expectErr('outsider C cannot post into it', cc.from('messages').insert({ conversation_id: conv, kind: 'text', body: 'intruder' }), /row-level|42501/);
  await expectErr('cannot send as another person', ca.from('messages').insert({ conversation_id: conv, sender_id: B.id, kind: 'text', body: 'spoof' }), /row-level|42501|permission/);
  ok('outsider C cannot see the members', ((await cc.from('conversation_members').select('user_id').eq('conversation_id', conv)).data || []).length === 0);

  // receipts, reactions, edit, delete
  await cb.rpc('mark_read', { conv });
  const rr = await until(async () => ((await ca.from('conversation_members').select('user_id,read_at').eq('conversation_id', conv)).data || []).find(r => r.user_id === B.id && r.read_at), 5000);
  ok('A sees B’s read receipt', !!rr);
  const rx = await cb.rpc('toggle_reaction', { msg: ins.data.id, emoji: '❤️' });
  ok('B reacts', !rx.error && (rx.data?.['❤️'] || []).includes(B.id), rx.error?.message);
  await expectErr('B cannot edit A’s message', cb.rpc('edit_message', { msg: ins.data.id, new_body: 'changed' }), /CANNOT_EDIT/);
  await expectErr('B cannot delete A’s message', cb.rpc('delete_message', { msg: ins.data.id }), /CANNOT_DELETE/);
  ok('A edits own message', !(await ca.rpc('edit_message', { msg: ins.data.id, new_body: 'hello from A (edited)' })).error);

  // storage
  const path = `${conv}/${crypto.randomUUID()}/note.txt`;
  const up = await ca.storage.from('chat-media').upload(path, new Blob(['private file'], { type: 'text/plain' }), { contentType: 'text/plain' });
  ok('A uploads a file into the chat', !up.error, up.error?.message);
  const dl = await cb.storage.from('chat-media').download(path);
  ok('B can download it', !dl.error && (await dl.data.text()) === 'private file', dl.error?.message);
  const dlc = await cc.storage.from('chat-media').download(path);
  ok('outsider C cannot download it', !!dlc.error);
  const upc = await cc.storage.from('chat-media').upload(`${conv}/${crypto.randomUUID()}/x.txt`, new Blob(['x']), { contentType: 'text/plain' });
  ok('outsider C cannot upload into the chat', !!upc.error);
  const signed = await cb.storage.from('chat-media').createSignedUrls([path], 60);
  ok('members get signed links', !signed.error && /^https?:\/\//.test(signed.data?.[0]?.signedUrl || ''), signed.error?.message);
  const del = await ca.rpc('delete_message', { msg: ins.data.id });
  const after = (await cb.from('messages').select('body,deleted_at').eq('id', ins.data.id).single()).data;
  ok('delete for everyone clears the text for B too', !del.error && after?.deleted_at && after.body === null);

  // blocking
  ok('B blocks A', !(await cb.from('blocks').insert({ blocked_id: A.id })).error);
  await expectErr('blocked: A can no longer message B', ca.from('messages').insert({ conversation_id: conv, kind: 'text', body: 'still there?' }), /row-level|42501/);
  await cb.from('blocks').delete().eq('blocked_id', A.id);
  ok('after unblock A can message again', !(await ca.from('messages').insert({ conversation_id: conv, kind: 'text', body: 'back again' })).error);

  // groups
  const g = await ca.rpc('create_group', { group_title: `G ${run}`, group_description: '', group_pic: { kind: 'hue', hue: 95 }, member_ids: [B.id] });
  ok('create group', !g.error && g.data, g.error?.message);
  await expectErr('non-admin cannot add members', cb.rpc('add_members', { conv: g.data, member_ids: [C.id] }), /ADMINS_ONLY/);
  ok('admin adds C', !(await ca.rpc('add_members', { conv: g.data, member_ids: [C.id] })).error);
  ok('C now sees the group', ((await cc.from('conversations').select('id').eq('id', g.data)).data || []).length === 1);
  ok('C still cannot see the A–B chat', ((await cc.from('messages').select('id').eq('conversation_id', conv)).data || []).length === 0);

  // password reset by email code
  const rs = await client().auth.resetPasswordForEmail(A.email);
  ok('password reset email requested', !rs.error, rs.error?.message);
  const code = await mailCode(A.email);
  ok('reset email contains a code', !!code, code ? '' : 'no code found in mailbox');
  if (code) {
    const cr = client();
    const v = await cr.auth.verifyOtp({ email: A.email, token: code, type: 'recovery' });
    ok('reset code accepted', !v.error && v.data.session, v.error?.message);
    const np = `New-${run}-pass!`;
    ok('new password saved', !(await cr.auth.updateUser({ password: np })).error);
    ok('sign in with new password', !(await client().auth.signInWithPassword({ email: A.email, password: np })).error);
    await expectErr('old password no longer works', client().auth.signInWithPassword({ email: A.email, password: A.password }), /Invalid login/i);
  }
  const so = await cc.auth.signOut();
  ok('sign out', !so.error && !(await cc.auth.getSession()).data.session);
  await ca.removeAllChannels(); await cb.removeAllChannels(); await cc.removeAllChannels();
}

async function uiTests() {
  part = 'app';
  const browser = await chromium.launch();
  const errors = [];
  const session = async label => {
    const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_|favicon|Failed to load resource/.test(m.text())) errors.push(`${label}: ${m.text()}`); });
    await page.goto(APP);
    return page;
  };
  const shot = (page, name) => page.screenshot({ path: `${OUT}/screens/${name}.png` }).catch(() => {});
  const X = { name: 'Xavier UI', username: `ui_x_${run}`, email: `ui_x_${run}@example.com`, password: `Ui-${run}-xx-123` };
  const Y = { name: 'Yasmin UI', username: `ui_y_${run}`, email: `ui_y_${run}@example.com`, password: `Ui-${run}-yy-123` };
  const signup = async (page, u) => {
    await page.waitForSelector('#gate:not([hidden]) #au-go', { timeout: 15000 });
    await page.click('text=Create an account');
    await page.fill('#au-name', u.name); await page.fill('#au-user', u.username);
    await page.fill('#au-email', u.email); await page.fill('#au-pass', u.password);
    await page.click('#au-go');
    await page.waitForSelector('#gate', { state: 'hidden', timeout: 20000 });
  };
  try {
    const px = await session('X'), py = await session('Y');
    await shot(px, '01-sign-in-screen');
    await signup(px, X); ok('X creates an account in the app', true);
    await signup(py, Y); ok('Y creates an account in the app', true);
    await px.waitForTimeout(1500);
    const emptyText = await px.textContent('#chats-list');
    ok('new account starts with no chats and no fake people', /No conversations yet/.test(emptyText) && !/Layla|Omar|Maya|Jonas/.test(await px.textContent('body')));
    await shot(px, '02-new-account-empty');

    // X finds Y and adds them
    await px.click('[data-action="tab"][data-tab="contacts"]');
    await px.click('#tab-contacts [data-action="add-contact"]');
    await px.fill('#find-search', 'nobody_matches_this_zz');
    await px.waitForSelector('#find-list .empty', { timeout: 10000 });
    ok('search with no match shows an empty state', /No one found/.test(await px.textContent('#find-list')));
    await px.fill('#find-search', Y.username);
    await px.waitForSelector('#find-list [data-action="contact-add"]', { timeout: 10000 });
    await shot(px, '03-find-people');
    await px.click('#find-list [data-action="contact-add"]');
    await px.waitForSelector('#find-list .tag', { timeout: 10000 });
    ok('X adds Y as a contact', true);
    await px.click('#find-list [data-action="open-dm"]');
    await px.waitForSelector('#convo.open', { timeout: 15000 });
    await px.fill('#composer', 'Hello from X');
    await px.keyboard.press('Enter');
    await px.waitForFunction(() => [...document.querySelectorAll('.mrow.me')].some(r => r.textContent.includes('Hello from X') && !r.querySelector('.tick-pend,.tick-fail')), null, { timeout: 15000 });
    ok('X sends a message (confirmed by the server)', true);

    // Y receives it live
    const row = await py.waitForSelector('#chats-list .row:has-text("Hello from X")', { timeout: 20000 }).catch(() => null);
    ok('Y sees the new chat appear without reloading', !!row);
    await shot(py, '04-y-chat-list');
    if (row) {
      await py.locator('#chats-list .row', { hasText: 'Hello from X' }).first().click();
      await py.waitForSelector('.mrow.them:has-text("Hello from X")', { timeout: 10000 });
      ok('Y opens it and reads the message', true);
      await py.fill('#composer', 'Hi X, got it');
      await py.keyboard.press('Enter');
      const back = await px.waitForSelector('.mrow.them:has-text("Hi X, got it")', { timeout: 20000 }).catch(() => null);
      ok('X receives Y’s reply live', !!back);
      const read = await px.waitForSelector('.mrow.me .read', { timeout: 20000 }).catch(() => null);
      ok('X sees the read receipt', !!read);
      await shot(px, '05-x-conversation');
      await shot(py, '06-y-conversation');

      // photo through storage
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAJElEQVR4nGNgoBAwMjAw/Gdg+M9AihJGBgaG/2iA/ZjqhgYQAADy1gcHw8bXXAAAAABJRU5ErkJggg==', 'base64');
      await px.setInputFiles('#img-in', { name: 'dot.png', mimeType: 'image/png', buffer: png });
      const img = await py.waitForFunction(() => [...document.querySelectorAll('.mrow.them .media')].some(m => /url\("?https?:/.test(m.style.background)), null, { timeout: 25000 }).catch(() => null);
      ok('photo uploads and arrives for Y', !!img);
    }

    // a group
    await px.click('[data-action="back"]');
    await px.click('[data-action="tab"][data-tab="groups"]');
    await px.click('#tab-groups [data-action="create-group"]');
    await px.fill('#group-name', `UI group ${run}`);
    await px.click(`#gd-list .pick`);
    await px.click('#gd-submit');
    await px.waitForSelector('#convo.open', { timeout: 20000 });
    await px.fill('#composer', 'Welcome to the group');
    await px.keyboard.press('Enter');
    await py.click('[data-action="back"]').catch(() => {});
    await py.click('[data-action="tab"][data-tab="groups"]');
    const grow = await py.waitForSelector(`#groups-list .row:has-text("UI group ${run}")`, { timeout: 20000 }).catch(() => null);
    ok('Y sees the group X created', !!grow);
    await shot(py, '07-y-groups');

    // sign out and back in: history comes back from the server
    await py.click('[data-action="tab"][data-tab="profile"]');
    await py.click('#tab-profile [data-action="logout"]');
    await py.click('[data-action="logout-confirm"]');
    await py.waitForSelector('#gate:not([hidden]) #au-go', { timeout: 10000 });
    ok('Y signs out', true);
    await py.fill('#au-email', Y.email); await py.fill('#au-pass', 'definitely-wrong');
    await py.click('#au-go');
    await py.waitForFunction(() => /Wrong email or password/.test(document.querySelector('#au-err')?.textContent || ''), null, { timeout: 10000 });
    ok('wrong password shows a clear error', true);
    await shot(py, '08-wrong-password');
    await py.fill('#au-pass', Y.password); await py.click('#au-go');
    await py.waitForSelector('#gate', { state: 'hidden', timeout: 20000 });
    await py.click('[data-action="tab"][data-tab="chats"]');
    const again = await py.waitForSelector('#chats-list .row', { timeout: 20000 }).catch(() => null);
    ok('after signing in again, chats load from the server', !!again);
    await shot(py, '09-y-signed-in-again');
  } catch (e) {
    ok('app test run finished without crashing', false, e.message);
  }
  ok('no JavaScript errors in the app', errors.length === 0, errors.slice(0, 5).join(' | '));
  await browser.close();
}

try { await apiTests(); } catch (e) { ok('server test run finished without crashing', false, e.stack || e.message); }
try { await uiTests(); } catch (e) { ok('app tests could start', false, e.message); }

const failed = results.filter(r => !r.pass);
const md = [`# ZYVEN end-to-end test results`, '', `${results.length - failed.length} passed, ${failed.length} failed`, '',
  ...['api', 'app'].flatMap(p => [`## ${p === 'api' ? 'Server (accounts, privacy, realtime, storage)' : 'App in two browsers'}`, '',
    ...results.filter(r => r.part === p).map(r => `- ${r.pass ? '✅' : '❌'} ${r.name}${r.pass ? '' : ` — ${r.detail}`}`), ''])].join('\n');
writeFileSync(`${OUT}/e2e.md`, md);
writeFileSync(`${OUT}/e2e.json`, JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
