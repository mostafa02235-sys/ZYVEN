// End-to-end tests for the Frame Creator (custom profile frames made on the
// phone: no AI, no paid service) against a real local Supabase server, with
// two accounts in two browsers plus a second device for the same account.
// Run by .github/workflows/test-backend.yml after `supabase start`.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, APP_URL
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_ANON_KEY;
const APP = process.env.APP_URL || 'http://127.0.0.1:8080/index.html';
const OUT = 'tests/results';
mkdirSync(`${OUT}/screens`, { recursive: true });
const results = [];
let part = 'api';
const ok = (name, pass, detail = '') => { results.push({ part, name, pass: !!pass, detail: String(detail || '').slice(0, 300) }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail && !pass ? `  — ${detail}` : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = Date.now().toString(36).slice(-6);
const client = () => createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function apiTests() {
  part = 'api';
  const mk = n => ({ email: `fs_${n}_${run}@example.com`, username: `fs${n}_${run}`, name: `FS ${n}`, password: `Fs-${run}-${n}-123` });
  const A = mk('a'), B = mk('b');
  const ca = client(), cb = client(), anon = client();
  for (const [u, c] of [[A, ca], [B, cb]]) {
    const { data, error } = await c.auth.signUp({ email: u.email, password: u.password, options: { data: { username: u.username, display_name: u.name } } });
    u.id = data?.user?.id; ok(`sign up ${u.username}`, !error && data.session, error?.message);
  }
  const path = `${A.id}/frames/abcdefghij.png`;
  let r = await ca.storage.from('avatars').upload(path, PNG1, { contentType: 'image/png' });
  ok('frame file: saved in your own folder', !r.error, r.error?.message);
  r = await ca.storage.from('avatars').upload(path, PNG1, { contentType: 'image/png', upsert: true });
  ok('frame file: you can replace it (rename keeps the same file)', !r.error, r.error?.message);
  r = await cb.storage.from('avatars').upload(`${A.id}/frames/zzzzzzzzzz.png`, PNG1, { contentType: 'image/png' });
  ok('frame file: nobody can save into someone else’s folder', !!r.error);
  r = await cb.storage.from('avatars').upload(path, PNG1, { contentType: 'image/png', upsert: true });
  ok('frame file: nobody can overwrite someone else’s frame', !!r.error);
  r = await cb.storage.from('avatars').download(path);
  ok('frame file: signed-in people can load it (to draw it around your photo)', !r.error && r.data?.size > 0, r.error?.message);
  r = await anon.storage.from('avatars').download(path);
  ok('frame file: signed-out visitors cannot load it', !!r.error || !r.data);
  r = await ca.storage.from('avatars').upload(`${A.id}/frames/note.txt`, Buffer.from('hi'), { contentType: 'text/plain' });
  ok('frame file: only pictures are accepted', !!r.error);
  const code = 'c-abcdefghij-k330-ffe58a';
  r = await ca.from('profiles').update({ frame: code }).eq('id', A.id);
  ok('profile: a custom frame can be applied', !r.error, r.error?.message);
  r = await cb.rpc('get_profiles', { ids: [A.id] });
  ok('profile: other people see the custom frame', r.data?.[0]?.frame === code, JSON.stringify(r.data?.[0]?.frame));
  await cb.from('profiles').update({ frame: null }).eq('id', A.id);
  r = await cb.rpc('get_profiles', { ids: [A.id] });
  ok('profile: nobody else can change your frame', r.data?.[0]?.frame === code);
  r = await cb.storage.from('avatars').remove([path]);
  const still = await ca.storage.from('avatars').download(path);
  ok('frame file: nobody else can delete it', !still.error);
  r = await ca.storage.from('avatars').remove([path]);
  const gone = await ca.storage.from('avatars').download(path);
  ok('frame file: you can delete it', !r.error && !!gone.error);
  await ca.from('profiles').update({ frame: null }).eq('id', A.id);
}

async function makeImage(page, w, h, transparent) {
  const b64 = await page.evaluate(([w, h, t]) => {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const g = cv.getContext('2d');
    if (!t) { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); }
    g.fillStyle = '#e63946'; g.beginPath(); g.arc(w * .3, h * .5, h * .28, 0, 7); g.fill();
    g.fillStyle = '#1d4ed8'; g.fillRect(w * .55, h * .25, w * .3, h * .5);
    g.fillStyle = '#ffd60a'; g.beginPath(); g.arc(w * .7, h * .5, h * .12, 0, 7); g.fill();
    return cv.toDataURL(t ? 'image/png' : 'image/jpeg', .92).split(',')[1];
  }, [w, h, transparent]);
  return Buffer.from(b64, 'base64');
}
async function makeVideo(page, secs = 3) {
  const b64 = await page.evaluate(async secs => {
    const cv = document.createElement('canvas'); cv.width = 320; cv.height = 320; const g = cv.getContext('2d');
    const rec = new MediaRecorder(cv.captureStream(24), { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm' });
    const chunks = []; rec.ondataavailable = e => e.data.size && chunks.push(e.data); rec.start(200);
    const t0 = performance.now();
    await new Promise(res => { const step = () => { const t = (performance.now() - t0) / 1000; g.fillStyle = `hsl(${t * 120} 80% 50%)`; g.fillRect(0, 0, 320, 320); g.fillStyle = '#fff'; g.beginPath(); g.arc(160 + Math.sin(t * 3) * 100, 160, 40, 0, 7); g.fill(); if (t < secs) requestAnimationFrame(step); else res(); }; step(); });
    rec.stop(); await new Promise(r => rec.onstop = r);
    const buf = new Uint8Array(await new Blob(chunks).arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode(...buf.subarray(i, i + 32768));
    return btoa(s);
  }, secs);
  return Buffer.from(b64, 'base64');
}

async function uiTests() {
  part = 'app';
  const browser = await chromium.launch();
  const errors = [];
  const session = async label => {
    const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_|favicon|Failed to load resource/.test(m.text())) errors.push(`${label}: ${m.text()}`); });
    await page.goto(APP);
    return page;
  };
  const shot = (page, name) => page.screenshot({ path: `${OUT}/screens/fs-${name}.png` }).catch(() => {});
  const X = { name: 'Xavi Frames', username: `fsx_${run}`, email: `fsx_${run}@example.com`, password: `Fs-${run}-xx-123` };
  const Y = { name: 'Yuki Frames', username: `fsy_${run}`, email: `fsy_${run}@example.com`, password: `Fs-${run}-yy-123` };
  const signup = async (page, u) => {
    await page.waitForSelector('#gate:not([hidden]) #au-go', { timeout: 15000 });
    await page.click('text=Create an account');
    await page.fill('#au-name', u.name); await page.fill('#au-user', u.username);
    await page.fill('#au-email', u.email); await page.fill('#au-pass', u.password);
    await page.click('#au-go');
    await page.waitForSelector('#gate', { state: 'hidden', timeout: 20000 });
  };
  const signin = async (page, u) => {
    await page.waitForSelector('#gate:not([hidden]) #au-go', { timeout: 20000 });
    await page.fill('#au-email', u.email); await page.fill('#au-pass', u.password); await page.click('#au-go');
    await page.waitForSelector('#gate', { state: 'hidden', timeout: 20000 });
  };
  const restart = async (page, u) => {
    await page.reload();
    const gate = await page.waitForSelector('#gate:not([hidden]) #au-go', { timeout: 6000 }).catch(() => null);
    if (gate) await signin(page, u);
    await page.waitForFunction(() => Cloud.connected || Cloud.lastSync, null, { timeout: 20000 }).catch(() => {});
    await sleep(1500);
  };
  const rowX = '#chats-list .row:has(.row-name:text-is("Xavi Frames"))';
  const openStudio = async page => {
    await page.click('[data-action="tab"][data-tab="profile"]');
    await page.click('#tab-profile [data-action="fs-open"]');
    await page.waitForSelector('#fstudio.open #fs-big .av', { timeout: 10000 });
    await sleep(500);
  };
  const preview = (page, sel, ms = 25000) => page.waitForFunction(s => document.querySelectorAll(s).length > 0, sel, { timeout: ms }).then(() => true, () => false);
  const saved = page => page.waitForFunction(() => ui.fs && ui.fs.tab === 'library' && Array.isArray(ui.fs.lib) && !ui.fs.busy, null, { timeout: 30000 }).then(() => true, () => false);
  try {
    const px = await session('X'), py = await session('Y');
    await signup(px, X); await signup(py, Y);
    ok('two accounts sign up in two browsers', true);
    // A chat between them, so Y sees X's picture in the list
    const cx = client(); await cx.auth.signInWithPassword({ email: X.email, password: X.password });
    const { data: yrow } = await cx.rpc('search_profiles', { q: Y.username });
    const conv = (await cx.rpc('get_or_create_direct', { other: yrow[0].id })).data;
    await cx.from('messages').insert({ conversation_id: conv, kind: 'text', body: 'hi from X' });
    ok('a chat between them exists', !!conv);

    // ---- 1. Colours only, animated, save & apply
    await openStudio(px);
    ok('Frame Creator opens from Settings › Customization', true);
    ok('it says plainly that it’s not AI', /No AI/.test(await px.textContent('#fstudio .fs-honest')));
    ok('live preview uses your own avatar', await preview(px, '#fs-big .av.framed .fr-ov.cf .cf-base'));
    await px.click('[data-action="fs-set"][data-v="hex"]');
    await px.evaluate(() => { const r = document.querySelector('#fs-thick'); r.value = '60'; r.dispatchEvent(new Event('input', { bubbles: true })); });
    await px.evaluate(() => { const r = document.querySelector('#fs-glow'); r.value = '80'; r.dispatchEvent(new Event('input', { bubbles: true })); });
    await px.evaluate(() => { const r = document.querySelector('#fs-op'); r.value = '30'; r.dispatchEvent(new Event('input', { bubbles: true })); });
    ok('shape, thickness, glow and transparency change the design', await px.evaluate(() => ui.fs.spec.shape === 'hex' && ui.fs.spec.thick === 60 && ui.fs.spec.glow === 80 && ui.fs.spec.opacity === 70));
    await px.click('[data-action="fs-col"][data-v="#ffc15e"]');
    ok('colours can be picked', await px.evaluate(() => ui.fs.spec.colors[0] === '#ffc15e'));
    await px.click('[data-action="fs-anim-on"][data-v="anim"]');
    await px.click('[data-action="fs-anim"][data-v="o"]');
    await px.evaluate(() => { const r = document.querySelector('#fs-speed'); r.value = '5'; r.dispatchEvent(new Event('input', { bubbles: true })); });
    ok('animated preview shows orbiting particles', await preview(px, '#fs-big .fr-ov.cf.a-o.live .cf-pts i'));
    await shot(px, '01-create');
    await px.fill('#fs-name', 'Gold orbit');
    await px.click('[data-action="fs-save"][data-apply="1"]');
    ok('saving finishes and opens My frames', await saved(px));
    const code1 = await px.evaluate(() => state.profile.frame);
    ok('the frame is applied to your profile', /^c-[a-z0-9]{10}-o5\d0-[0-9a-f]{6}$/.test(code1 || ''), code1);
    const file = await px.evaluate(async () => {
      const p = CF.paths(state.profile.frame, Cloud.me), { data } = await sb.storage.from('avatars').download(p.base);
      const meta = await pngMeta(data), bm = await createImageBitmap(data), c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height;
      const g = c.getContext('2d'); g.drawImage(bm, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data, a = (x, y) => d[(y * c.width + x) * 4 + 3];
      let center = 0; for (let y = 90; y < 420; y += 3) for (let x = 90; x < 420; x += 3) if (Math.hypot(x - 256, y - 256) < 170) center = Math.max(center, a(x, y));
      return { w: c.width, type: data.type, center, corner: a(0, 0), ring: a(256, 256 - 200), name: meta?.name };
    });
    ok('the saved file is a 512 px PNG with a transparent background', file.w === 512 && /png/.test(file.type) && file.corner === 0, JSON.stringify(file));
    ok('the middle is fully transparent (your photo is never covered)', file.center === 0, String(file.center));
    ok('transparency setting is applied to the ring', file.ring > 120 && file.ring < 220, String(file.ring));
    ok('the name travels with the frame', file.name === 'Gold orbit');
    ok('My frames shows it, marked as on your profile', (await px.$$('#fs-body .fr-tile.on')).length === 1);
    await shot(px, '02-library');
    await px.click('[data-action="fs-close"]');
    ok('your own profile shows the frame', await preview(px, '#tab-profile .av.framed .fr-ov.cf .cf-base'));

    // ---- 2. The other person sees it
    await restart(py, Y);
    await py.click('[data-action="tab"][data-tab="chats"]');
    ok('the other person sees the custom frame in their chat list', await preview(py, `${rowX} .av.framed .fr-ov.cf .cf-base`));
    ok('…small list pictures stay still (battery)', !(await py.$(`${rowX} .fr-ov.cf.live`)));
    await py.click(rowX); await py.waitForSelector('#convo.open', { timeout: 10000 }); await sleep(800);
    ok('the frame shows in the chat header', await preview(py, '#convo-who .av.framed .fr-ov.cf .cf-base'));
    ok('the frame sits outside the photo circle', await py.$eval('#convo-who .av.framed', e => { const a = e.getBoundingClientRect(), f = e.querySelector('.fr-ov').getBoundingClientRect(); return f.width > a.width * 1.4 && Math.abs((f.x + f.width / 2) - (a.x + a.width / 2)) < 1; }).catch(() => false));
    await shot(py, '03-other-sees');
    // Pausing when the app isn't on screen
    const paused = await py.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); const on = document.documentElement.classList.contains('zv-away'); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); return on && !document.documentElement.classList.contains('zv-away'); });
    ok('animations pause when ZYVEN is in the background', paused);

    // ---- 3. Second device: same library
    const px2 = await session('X2'); await signin(px2, X); await sleep(1500);
    await openStudio(px2);
    await px2.click('[data-action="fs-tab"][data-v="library"]');
    await px2.waitForSelector('#fs-body .fr-tile', { timeout: 20000 }).catch(() => null);
    ok('your frames sync to another device', (await px2.$$eval('#fs-body .fr-tile span', e => e.map(x => x.textContent))).includes('Gold orbit'));
    await px2.context().close();

    // ---- 4. Picture: colours and cut-out stickers
    await openStudio(px);
    await px.setInputFiles('#fs-in', { name: 'shapes.jpg', mimeType: 'image/jpeg', buffer: await makeImage(px, 900, 600, false) });
    await px.waitForFunction(() => ui.fs.src && !ui.fs.busy, null, { timeout: 15000 });
    const pic = await px.evaluate(() => ({ kind: ui.fs.src.kind, pal: ui.fs.src.palette, fill: ui.fs.spec.fill }));
    ok('picture upload: colours are extracted locally', pic.kind === 'image' && pic.pal.length >= 3, JSON.stringify(pic));
    ok('picture upload: it is wrapped around the ring', pic.fill === 'wrap');
    await px.click('[data-action="fs-fill"][data-v="gradient"]');
    await px.check('[data-input="fs-cut"]');
    await px.waitForFunction(() => ui.fs.src.cutTrim, null, { timeout: 10000 }).catch(() => {});
    ok('cut-out finds the shapes on a plain background', await px.evaluate(() => ui.fs.src.cutRatio > 0.3 && !!ui.fs.src.cutTrim && ui.fs.spec.els > 0));
    await shot(px, '04-picture');
    await px.click('[data-action="fs-save"][data-apply="0"]');
    ok('saved without changing your profile frame', await saved(px) && await px.evaluate(c => state.profile.frame === c, code1));

    // ---- 5. Transparent PNG
    await px.click('[data-action="fs-new"]');
    await px.setInputFiles('#fs-in', { name: 'sticker.png', mimeType: 'image/png', buffer: await makeImage(px, 400, 400, true) });
    await px.waitForFunction(() => ui.fs.src && !ui.fs.busy, null, { timeout: 15000 });
    ok('transparent PNG: used as stickers around the ring', await px.evaluate(() => ui.fs.src.kind === 'png' && !!ui.fs.src.sticker && ui.fs.spec.els > 0));
    await px.click('[data-action="fs-save"][data-apply="0"]');
    ok('transparent PNG frame saved', await saved(px));

    // ---- 6. Video: real frames from the clip, looping
    await px.click('[data-action="fs-new"]');
    await px.setInputFiles('#fs-in', { name: 'clip.webm', mimeType: 'video/webm', buffer: await makeVideo(px, 3) });
    await px.waitForFunction(() => ui.fs.src && !ui.fs.busy, null, { timeout: 30000 }).catch(() => {});
    const v = await px.evaluate(() => ({ kind: ui.fs.src?.kind, frames: ui.fs.src?.frames?.length, anim: ui.fs.spec.anim, err: ui.fs.err }));
    ok('video upload: frames are taken from the clip on the phone', v.kind === 'video' && v.frames === 8, JSON.stringify(v));
    ok('video upload: becomes a video loop frame', v.anim === 'v');
    ok('video loop plays in the preview', await preview(px, '#fs-big .cf-vid i.run'));
    await shot(px, '05-video');
    await px.click('[data-action="fs-save"][data-apply="1"]');
    ok('video frame saved and applied', await saved(px));
    const code2 = await px.evaluate(() => state.profile.frame);
    ok('the profile now uses the video loop frame', /^c-[a-z0-9]{10}-v\d\d8-/.test(code2 || ''), code2);
    await restart(py, Y);
    await py.click('[data-action="tab"][data-tab="chats"]');
    await py.click(rowX); await py.waitForSelector('#convo.open', { timeout: 10000 }); await sleep(800);
    ok('the other person sees the video loop frame', await preview(py, '#convo-who .fr-ov.cf .cf-vid i'));

    // ---- 7. Library: filter, rename, edit, delete, remove
    await px.click('[data-action="fs-libtab"][data-v="video"]');
    ok('My frames: “From video” group', (await px.$$('#fs-body .fr-tile')).length === 1);
    await px.click('[data-action="fs-libtab"][data-v="animated"]');
    ok('My frames: “Animated” group', (await px.$$('#fs-body .fr-tile')).length === 2);
    await px.click('[data-action="fs-libtab"][data-v="all"]');
    ok('My frames: all 4 frames', (await px.$$('#fs-body .fr-tile')).length === 4);
    await px.click('#fs-body .fr-tile.on'); await px.waitForSelector('.overlay [data-action="fs-rename"]');
    await px.click('.overlay [data-action="fs-rename"]'); await px.waitForSelector('#fs-rn');
    await px.fill('#fs-rn', 'Party loop'); await px.click('form[data-form="fs-rename"] button[type=submit]');
    await px.waitForFunction(() => [...document.querySelectorAll('#fs-body .fr-tile span')].some(s => s.textContent === 'Party loop'), null, { timeout: 15000 }).catch(() => {});
    ok('rename', (await px.$$eval('#fs-body .fr-tile span', e => e.map(x => x.textContent))).includes('Party loop'));
    await px.click('#fs-body .fr-tile.on'); await px.waitForSelector('.overlay [data-action="fs-edit"]');
    await px.click('.overlay [data-action="fs-edit"]');
    await px.waitForFunction(() => ui.fs.tab === 'create' && ui.fs.editId && !ui.fs.busy, null, { timeout: 20000 });
    ok('edit reopens the design with the video frames', await px.evaluate(() => ui.fs.src?.frames?.length === 8 && ui.fs.spec.name === 'Party loop'));
    await px.click('[data-action="fs-set"][data-v="burst"]');
    await px.click('[data-action="fs-save"][data-apply="0"]');
    ok('edited frame saved', await saved(px));
    const code3 = await px.evaluate(() => state.profile.frame);
    ok('editing the applied frame keeps it applied (updated)', code3 && code3 !== code2 && /-v\d\d8-/.test(code3), code3);
    ok('the old version was removed (no duplicates)', (await px.$$('#fs-body .fr-tile')).length === 4);
    await px.click('#fs-body .fr-tile.on'); await px.waitForSelector('.overlay [data-action="fs-unapply"]');
    await px.click('.overlay [data-action="fs-unapply"]');
    await px.waitForFunction(() => state.profile.frame === null, null, { timeout: 15000 }).catch(() => {});
    ok('take the frame off your profile', await px.evaluate(() => state.profile.frame === null));
    await restart(py, Y);
    await py.click('[data-action="tab"][data-tab="chats"]'); await sleep(1500);
    ok('…and others stop seeing it', !(await py.$(`${rowX} .av.framed`)));
    await px.click('#fs-body .fr-tile >> nth=0'); await px.waitForSelector('.overlay [data-action="fs-apply"]');
    await px.click('.overlay [data-action="fs-apply"]');
    await px.waitForFunction(() => !!state.profile.frame, null, { timeout: 15000 }).catch(() => {});
    ok('restore: apply a saved frame again', await px.evaluate(() => !!state.profile.frame));
    await px.click('#fs-body .fr-tile.on'); await px.waitForSelector('.overlay [data-action="fs-del"]');
    await px.click('.overlay [data-action="fs-del"]');
    await px.click('[data-action="dlg-yes"]');
    await px.waitForFunction(() => state.profile.frame === null && ui.fs.lib.length === 3, null, { timeout: 15000 }).catch(() => {});
    ok('deleting the applied frame takes it off your profile', await px.evaluate(() => state.profile.frame === null && ui.fs.lib.length === 3));
    const left = await px.evaluate(async () => (await sb.storage.from('avatars').list(`${Cloud.me}/frames`, { limit: 100 })).data.map(f => f.name));
    ok('…and deletes its files', left.filter(n => /^[a-z0-9]{10}\.png$/.test(n)).length === 3, left.join(','));
    await shot(px, '06-library-after');
  } catch (e) {
    ok('Frame Creator app test run finished without crashing', false, e.message);
  }
  ok('no JavaScript errors in the app', errors.length === 0, errors.slice(0, 5).join(' | '));
  await browser.close();
}

try { await apiTests(); } catch (e) { ok('server test run finished without crashing', false, e.stack || e.message); }
try { await uiTests(); } catch (e) { ok('app tests could start', false, e.message); }

const failed = results.filter(r => !r.pass);
const md = [`# ZYVEN Frame Creator test results`, '', `${results.length - failed.length} passed, ${failed.length} failed`, '',
  ...['api', 'app'].flatMap(p => [`## ${p === 'api' ? 'Server rules' : 'App in two browsers'}`, '',
    ...results.filter(r => r.part === p).map(r => `- ${r.pass ? '✅' : '❌'} ${r.name}${r.pass ? '' : ` — ${r.detail}`}`), ''])].join('\n');
writeFileSync(`${OUT}/frames-e2e.md`, md);
writeFileSync(`${OUT}/frames-e2e.json`, JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
