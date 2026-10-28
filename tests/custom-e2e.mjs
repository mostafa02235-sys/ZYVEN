// End-to-end tests for photos, chat wallpapers (photo, colour, video),
// profile picture crop, and profile frames — against a real local Supabase
// server, with two accounts in two separate browsers.
// Run by .github/workflows/test-backend.yml after `supabase start`.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SERVICE_ROLE_KEY, APP_URL
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_ANON_KEY, SERVICE = process.env.SERVICE_ROLE_KEY;
const APP = process.env.APP_URL || 'http://127.0.0.1:8080/index.html';
const OUT = 'tests/results';
mkdirSync(`${OUT}/screens`, { recursive: true });
const results = [];
let part = 'api';
const ok = (name, pass, detail = '') => { results.push({ part, name, pass: !!pass, detail: String(detail || '').slice(0, 300) }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail && !pass ? `  — ${detail}` : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = Date.now().toString(36).slice(-6);
const client = () => createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const admin = SERVICE ? createClient(URL, SERVICE, { auth: { persistSession: false } }) : null;
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

async function apiTests() {
  part = 'api';
  const mk = n => ({ email: `cz_${n}_${run}@example.com`, username: `cz${n}_${run}`, name: `CZ ${n}`, password: `Cz-${run}-${n}-123` });
  const A = mk('a'), B = mk('b'), C = mk('c');
  const ca = client(), cb = client(), cc = client();
  for (const [u, c] of [[A, ca], [B, cb], [C, cc]]) {
    const { data, error } = await c.auth.signUp({ email: u.email, password: u.password, options: { data: { username: u.username, display_name: u.name } } });
    u.id = data?.user?.id; ok(`sign up ${u.username}`, !error && data.session, error?.message);
  }
  // Frames
  let r = await ca.from('profiles').update({ frame: 'gold' }).eq('id', A.id);
  ok('frame: you can pick a frame', !r.error, r.error?.message);
  r = await cb.rpc('get_profiles', { ids: [A.id] });
  ok('frame: other people see your frame', r.data?.[0]?.frame === 'gold', JSON.stringify(r.data?.[0] || r.error));
  r = await cb.rpc('search_profiles', { q: A.username });
  ok('frame: search results include the frame', r.data?.[0]?.frame === 'gold');
  await cb.from('profiles').update({ frame: 'comic' }).eq('id', A.id);
  r = await cb.rpc('get_profiles', { ids: [A.id] });
  ok('frame: nobody else can change your frame', r.data?.[0]?.frame === 'gold');
  r = await ca.from('profiles').update({ frame: 'DROP TABLE' }).eq('id', A.id);
  ok('frame: invalid frame names are rejected', !!r.error);

  // Photo messages with a thumbnail
  const conv = (await ca.rpc('get_or_create_direct', { other: B.id })).data;
  const mid = crypto.randomUUID();
  const up1 = await ca.storage.from('chat-media').upload(`${conv}/${mid}/photo.jpg`, jpeg, { contentType: 'image/jpeg' });
  const up2 = await ca.storage.from('chat-media').upload(`${conv}/${mid}/thumb.jpg`, jpeg, { contentType: 'image/jpeg' });
  ok('photo: full size and thumbnail upload to the chat folder', !up1.error && !up2.error, up1.error?.message || up2.error?.message);
  const ins = await ca.from('messages').insert({ id: mid, conversation_id: conv, kind: 'image', body: 'caption', meta: { path: `${conv}/${mid}/photo.jpg`, thumb_path: `${conv}/${mid}/thumb.jpg`, ratio: 1 } });
  ok('photo: message saved with both files', !ins.error, ins.error?.message);
  const sB = await cb.storage.from('chat-media').createSignedUrls([`${conv}/${mid}/photo.jpg`, `${conv}/${mid}/thumb.jpg`], 60);
  ok('photo: the other person can open both', !sB.error && sB.data.every(d => d.signedUrl));
  const dl = sB.data?.[1]?.signedUrl ? await fetch(sB.data[1].signedUrl) : null;
  ok('photo: the thumbnail really downloads', dl?.ok === true);
  const sC = await cc.storage.from('chat-media').createSignedUrls([`${conv}/${mid}/photo.jpg`], 60);
  ok('photo: outsiders cannot open private photos', !!sC.error || !sC.data?.[0]?.signedUrl);
  const hist = await cb.from('messages').select('id,meta').eq('id', mid).single();
  ok('photo: stays in history for the receiver', hist.data?.meta?.thumb_path?.endsWith('thumb.jpg'));

  // Wallpapers
  const wpath = `${A.id}/${crypto.randomUUID()}.jpg`;
  const wu = await ca.storage.from('wallpapers').upload(wpath, jpeg, { contentType: 'image/jpeg' });
  ok('wallpaper: upload into your own folder', !wu.error, wu.error?.message);
  const wbad = await ca.storage.from('wallpapers').upload(`${B.id}/sneaky.jpg`, jpeg, { contentType: 'image/jpeg' });
  ok('wallpaper: cannot upload into someone else’s folder', !!wbad.error);
  const wtxt = await ca.storage.from('wallpapers').upload(`${A.id}/note.txt`, Buffer.from('hi'), { contentType: 'text/plain' });
  ok('wallpaper: only image and video files are accepted', !!wtxt.error);
  const ws = await ca.from('chat_wallpapers').upsert({ user_id: A.id, conversation_id: conv, kind: 'image', path: wpath, settings: { zoom: 1.4, x: .3, y: .6, dim: .4, bright: .9 } }, { onConflict: 'user_id,conversation_id' }).select().single();
  ok('wallpaper: saved for a chat', !ws.error && ws.data?.kind === 'image', ws.error?.message);
  const wsB = await cb.from('chat_wallpapers').select('*');
  ok('wallpaper: other people can’t see it', (wsB.data || []).length === 0);
  const wfB = await cb.storage.from('wallpapers').createSignedUrl(wpath, 60);
  ok('wallpaper: other people can’t open the file', !!wfB.error || !wfB.data?.signedUrl);
  const wsC = await cc.from('chat_wallpapers').insert({ user_id: C.id, conversation_id: conv, kind: 'color', color: '#000000' });
  ok('wallpaper: only for chats you’re in', !!wsC.error);
  // Second device for A sees the same wallpaper
  const a2 = client(); await a2.auth.signInWithPassword({ email: A.email, password: A.password });
  const wsA2 = await a2.from('chat_wallpapers').select('*').eq('conversation_id', conv).single();
  ok('wallpaper: syncs to your other devices', wsA2.data?.path === wpath && wsA2.data?.settings?.zoom === 1.4);
  return { conv };
}

/* ---------- The app in two browsers ---------- */
async function makeImage(page, w, h, label, type = 'image/jpeg') {
  const b64 = await page.evaluate(([w, h, label, type]) => {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const g = cv.getContext('2d');
    const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, '#3b2a8a'); gr.addColorStop(1, '#ff7a59'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 400; i++) { g.fillStyle = `hsl(${i * 7} 70% 60% / .5)`; g.fillRect(Math.random() * w, Math.random() * h, 30, 30); }
    g.fillStyle = '#fff'; g.font = `bold ${Math.round(h / 6)}px sans-serif`; g.fillText(label, w * .1, h * .55);
    return cv.toDataURL(type, .95).split(',')[1];
  }, [w, h, label, type]);
  return Buffer.from(b64, 'base64');
}
async function makeVideo(page, secs = 3) {
  const b64 = await page.evaluate(async secs => {
    const cv = document.createElement('canvas'); cv.width = 320; cv.height = 568; const g = cv.getContext('2d');
    const stream = cv.captureStream(24);
    const rec = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm' });
    const chunks = []; rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    rec.start(200);
    const t0 = performance.now();
    await new Promise(res => { const step = () => { const t = (performance.now() - t0) / 1000; g.fillStyle = `hsl(${t * 120} 70% 40%)`; g.fillRect(0, 0, 320, 568); g.fillStyle = '#fff'; g.beginPath(); g.arc(160 + Math.sin(t * 3) * 100, 284, 40, 0, 7); g.fill(); if (t < secs) requestAnimationFrame(step); else res(); }; step(); });
    rec.stop(); await new Promise(r => rec.onstop = r);
    const blob = new Blob(chunks, { type: 'video/webm' });
    const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode(...buf.subarray(i, i + 32768));
    return btoa(s);
  }, secs);
  return Buffer.from(b64, 'base64');
}

async function uiTests() {
  part = 'app';
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  const session = async label => {
    const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_|favicon|Failed to load resource/.test(m.text())) errors.push(`${label}: ${m.text()}`); });
    await page.goto(APP);
    return page;
  };
  const shot = (page, name) => page.screenshot({ path: `${OUT}/screens/cz-${name}.png` }).catch(() => {});
  const X = { name: 'Xena Custom', username: `czx_${run}`, email: `czx_${run}@example.com`, password: `Cz-${run}-xx-123` };
  const Y = { name: 'Yara Custom', username: `czy_${run}`, email: `czy_${run}@example.com`, password: `Cz-${run}-yy-123` };
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
  const openChatWith = async (page, text) => {
    await page.click('[data-action="tab"][data-tab="chats"]').catch(() => {});
    const exact = page.locator(`#chats-list .row:has(.row-name:text-is("${text}"))`);
    await (await exact.count() ? exact : page.locator('#chats-list .row', { hasText: text })).first().click();
    await page.waitForSelector('#convo.open', { timeout: 10000 });
    await sleep(600);
  };
  const sentImages = page => page.$$eval('.mrow.me .media', els => els.filter(e => !e.querySelector('.up-ring,.up-fail')).length);
  try {
    const px = await session('X'), py = await session('Y');
    await signup(px, X); await signup(py, Y);
    ok('two accounts sign up in two browsers', true);
    await px.click('[data-action="tab"][data-tab="contacts"]');
    await px.click('#tab-contacts [data-action="add-contact"]');
    await px.fill('#find-search', Y.username);
    await px.waitForSelector('#find-list [data-action="contact-add"]', { timeout: 15000 });
    await px.click('#find-list [data-action="contact-add"]');
    await px.waitForSelector('#find-list .tag', { timeout: 10000 });
    await px.click('#find-list [data-action="open-dm"]');
    await px.waitForSelector('#convo.open', { timeout: 15000 });
    await px.fill('#composer', `hello ${run}`); await px.keyboard.press('Enter');
    await py.waitForSelector(`#chats-list .row:has-text("hello ${run}")`, { timeout: 25000 });
    await openChatWith(py, `hello ${run}`);
    ok('X and Y are in a chat', true);

    /* ---------- Photos ---------- */
    ok('camera option is available (opens the phone camera on Android)', await px.$eval('#cam-in', e => e.getAttribute('capture') === 'environment' && e.accept === 'image/*'));
    ok('gallery picker allows several photos', await px.$eval('#img-in', e => e.multiple));
    const big = await makeImage(px, 4000, 3000, 'BIG');
    const small = await makeImage(px, 900, 1200, 'TALL');
    const wide = await makeImage(px, 1600, 900, 'WIDE', 'image/png');
    // Cancel before sending
    await px.setInputFiles('#img-in', [{ name: 'big.jpg', mimeType: 'image/jpeg', buffer: big }]);
    await px.waitForSelector('#pp.open .pp-img', { timeout: 15000 });
    ok('a preview appears before sending', true);
    await px.click('[data-action="pp-close"]');
    await sleep(800);
    ok('cancelling sends nothing', (await px.$$('.mrow.me .media')).length === 0 && !(await px.$('#pp')));
    // Three photos, remove one, send two with a caption
    await px.setInputFiles('#img-in', [{ name: 'big.jpg', mimeType: 'image/jpeg', buffer: big }, { name: 'tall.jpg', mimeType: 'image/jpeg', buffer: small }, { name: 'wide.png', mimeType: 'image/png', buffer: wide }]);
    await px.waitForSelector('#pp-send:not([disabled])', { timeout: 20000 });
    ok('three photos are prepared', (await px.$$('#pp-strip .pp-th.ready')).length === 3);
    const info = await px.textContent('#pp-info');
    await px.click('#pp-strip .pp-th >> nth=0');
    const info0 = await px.textContent('#pp-info');
    ok('large photos are compressed, keeping the shape', /2560×1920/.test(info0) && /→/.test(info0), info0);
    await px.click('#pp-strip .pp-th >> nth=2');
    await px.click('[data-action="pp-remove"]');
    ok('a photo can be removed before sending', (await px.$$('#pp-strip .pp-th.ready')).length === 2, info);
    await px.fill('#pp-cap', `two photos ${run}`);
    await shot(px, '01-photo-preview');
    // Slow the upload so the progress is visible
    const cdp = await px.context().newCDPSession(px);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 50, downloadThroughput: 4e6, uploadThroughput: 250e3 });
    await px.click('#pp-send');
    const prog = await px.waitForSelector('.mrow.me .media .up-pct', { timeout: 8000 }).catch(() => null);
    ok('upload progress is shown on the photo', !!prog);
    await shot(px, '02-upload-progress');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await px.waitForFunction(() => document.querySelectorAll('.mrow.me .media').length === 2 && !document.querySelector('.mrow.me .media .up-ring'), null, { timeout: 60000 });
    ok('both photos finish sending', (await sentImages(px)) === 2);
    await py.waitForFunction(() => [...document.querySelectorAll('.mrow.them .media')].filter(m => /thumb\.jpg/.test(m.style.background)).length === 2, null, { timeout: 30000 });
    ok('the receiver gets both, shown from small thumbnails', true);
    const ratios = await py.$$eval('.mrow.them .media', els => els.map(e => +(e.style.aspectRatio || '0').toString().slice(0, 5)));
    ok('aspect ratios are kept (4:3 and 3:4)', ratios.some(r => Math.abs(r - 1.333) < .01) && ratios.some(r => Math.abs(r - .75) < .01), ratios.join(','));
    ok('the caption arrives', await py.isVisible(`.mrow.them:has-text("two photos ${run}")`));
    await shot(py, '03-y-received');
    // Full screen + zoom
    await py.click('.mrow.them .media >> nth=0');
    await py.waitForSelector('#viewer:not([hidden]) #vw-img', { timeout: 8000 });
    await py.waitForFunction(() => /photo\./.test(document.querySelector('#vw-img')?.src || ''), null, { timeout: 20000 });
    ok('tapping opens the full-size photo', true);
    const zb = await py.$eval('#vw-zoom', e => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
    await py.mouse.dblclick(zb[0], zb[1]); await sleep(400);
    ok('double-tap zooms in', (await py.getAttribute('#vw-zoom', 'data-scale')) === '2.50');
    await py.mouse.wheel(0, -400); await sleep(200);
    ok('pinch/scroll zoom goes further', +(await py.getAttribute('#vw-zoom', 'data-scale')) > 2.5);
    await shot(py, '04-zoomed');
    await py.mouse.dblclick(zb[0], zb[1]); await sleep(300);
    ok('double-tap again zooms back out', (await py.getAttribute('#vw-zoom', 'data-scale')) === '1.00');
    await py.click('[data-action="viewer-close"]');
    // Upload failure and retry
    await px.route('**/storage/v1/object/chat-media/**', r => r.abort('internetdisconnected'));
    await px.setInputFiles('#img-in', [{ name: 'tall.jpg', mimeType: 'image/jpeg', buffer: small }]);
    await px.waitForSelector('#pp-send:not([disabled])', { timeout: 15000 });
    await px.click('#pp-send');
    await px.waitForSelector('.mrow.me .media .up-fail', { timeout: 20000 });
    ok('a failed upload says “Tap to retry”', true);
    await shot(px, '05-upload-failed');
    await px.unroute('**/storage/v1/object/chat-media/**');
    await sleep(800);
    await px.click('.mrow.me .media:has(.up-fail)');
    const sheet = await px.waitForSelector('.overlay [data-action="msg-retry"]', { timeout: 4000 }).catch(() => null);
    if (!sheet) {
      const why = await px.evaluate(() => { const m = document.querySelector('.mrow.me .media:has(.up-fail)'); const r = m?.getBoundingClientRect(); const at = r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null; return `top=${at?.className || at?.tagName} id=${at?.id || ''} overlayHidden=${document.querySelector('#overlay').hidden} pp=${!!document.querySelector('#pp')} viewer=${!document.querySelector('#viewer').hidden}`; });
      ok('tapping a failed photo opens “Try again”', false, why);
      await shot(px, '05b-tap-failed');
      await px.keyboard.press('Escape'); await sleep(400);
      await px.click('.mrow.me .media:has(.up-fail)');
      await px.waitForSelector('.overlay [data-action="msg-retry"]', { timeout: 6000 });
    } else ok('tapping a failed photo opens “Try again”', true);
    await px.click('.overlay [data-action="msg-retry"]');
    await px.waitForFunction(() => !document.querySelector('.mrow.me .media .up-fail,.mrow.me .media .up-ring') && document.querySelectorAll('.mrow.me .media').length === 3, null, { timeout: 30000 });
    ok('retry sends it', true);
    await py.waitForFunction(() => document.querySelectorAll('.mrow.them .media').length === 3, null, { timeout: 30000 });
    ok('the retried photo arrives', true);
    await restart(py, Y);
    await openChatWith(py, 'Xena Custom');
    await py.waitForFunction(() => document.querySelectorAll('.mrow.them .media').length === 3, null, { timeout: 20000 });
    ok('photos are still there after restarting the app', true);

    /* ---------- Wallpapers ---------- */
    const layerKind = page => page.$eval('#cw-layer', e => e.hidden ? 'none' : (e.dataset.kind || 'none'));
    await px.click('[data-action="chat-actions-open"]');
    await px.click('.overlay [data-action="wp-open"]');
    await px.waitForSelector('#wallpaper.open #wp-tabs', { timeout: 8000 });
    await px.click('#wp-tabs [data-v="color"]');
    await px.click('.wp-col[data-v="#1A1033"]');
    await shot(px, '06-wallpaper-colour');
    await px.click('#wp-apply');
    await px.waitForFunction(() => !document.querySelector('#wallpaper.open'), null, { timeout: 15000 });
    ok('a colour wallpaper applies to the chat', (await layerKind(px)) === 'color' && /26, 16, 51/.test(await px.$eval('#cw-layer .cw-fill', e => getComputedStyle(e).backgroundColor)));
    ok('the message list stays readable on top', await px.$eval('#msgs', e => e.classList.contains('has-cw')));
    // Photo wallpaper with zoom, position, overlay
    const wallPic = await makeImage(px, 1080, 1920, 'WALL');
    await px.click('[data-action="chat-actions-open"]');
    await px.click('.overlay [data-action="wp-open"]');
    await px.waitForSelector('#wallpaper.open #wp-tabs', { timeout: 8000 });
    await px.click('#wp-tabs [data-v="photo"]');
    await px.setInputFiles('#wp-img', { name: 'wall.jpg', mimeType: 'image/jpeg', buffer: wallPic });
    await px.waitForSelector('#wp-prev img.cw-media', { timeout: 10000 });
    ok('the photo is previewed before applying', true);
    const box = await px.$eval('#wp-prev', e => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
    await px.evaluate(() => { const z = document.querySelector('#wp-zoom'); z.value = '1.8'; z.dispatchEvent(new Event('input', { bubbles: true })); const d = document.querySelector('#wp-dim'); d.value = '0.5'; d.dispatchEvent(new Event('input', { bubbles: true })); });
    await px.mouse.move(box[0], box[1]); await px.mouse.down(); await px.mouse.move(box[0] + 60, box[1] + 40, { steps: 6 }); await px.mouse.up();
    const s = await px.evaluate(() => ({ ...ui.wp.s }));
    ok('zoom, reposition, and dark overlay can be adjusted', s.zoom === 1.8 && s.dim === .5 && s.x < .5 && s.y < .5, JSON.stringify(s));
    await shot(px, '07-wallpaper-photo-edit');
    await px.click('#wp-apply');
    await px.waitForFunction(() => !document.querySelector('#wallpaper.open'), null, { timeout: 30000 });
    await px.waitForSelector('#cw-layer img.cw-media', { timeout: 10000 });
    ok('the photo wallpaper appears behind the messages', (await layerKind(px)) === 'image');
    ok('the overlay keeps text readable', /0\.5/.test(await px.$eval('#cw-layer .cw-dim', e => e.style.background)));
    await shot(px, '08-wallpaper-photo');
    // Another chat keeps the default
    await px.click('[data-action="back"]');
    await px.click('[data-action="tab"][data-tab="groups"]');
    await px.click('#tab-groups [data-action="create-group"]');
    await px.fill('#group-name', `Walls ${run}`);
    await px.click('#gd-list .pick');
    await px.click('#gd-submit');
    await px.waitForSelector('#convo.open', { timeout: 20000 });
    await sleep(800);
    ok('a different chat keeps the default background', (await layerKind(px)) === 'none');
    // Restart: the wallpaper is still there
    await restart(px, X);
    await openChatWith(px, 'Yara Custom');
    await px.waitForSelector('#cw-layer img.cw-media', { timeout: 15000 }).catch(() => null);
    ok('the wallpaper is still there after restarting', (await layerKind(px)) === 'image');
    const s2 = await px.evaluate(() => Walls.get(ui.openChatId)?.s);
    ok('its zoom and position were saved', s2?.zoom === 1.8 && s2?.dim === .5, JSON.stringify(s2));
    // Video wallpaper
    const vid = await makeVideo(px, 3);
    ok('a test video was recorded', vid.length > 2000, vid.length);
    await px.click('[data-action="chat-actions-open"]');
    await px.click('.overlay [data-action="wp-open"]');
    await px.waitForSelector('#wallpaper.open #wp-tabs', { timeout: 8000 });
    await px.click('#wp-tabs [data-v="video"]');
    await px.setInputFiles('#wp-vid', { name: 'bad.avi', mimeType: 'video/x-msvideo', buffer: Buffer.from('nope') });
    await px.waitForFunction(() => /aren’t supported/.test(document.querySelector('#wp-err')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
    ok('unsupported video formats are refused with a clear message', /aren’t supported/.test(await px.textContent('#wp-err')));
    await px.setInputFiles('#wp-vid', { name: 'wall.webm', mimeType: 'video/webm', buffer: vid });
    await px.waitForSelector('#wp-prev video', { timeout: 15000 });
    ok('the video is previewed before applying', true);
    ok('the preview is muted', await px.$eval('#wp-prev video', v => v.muted && v.volume === 0));
    ok('the editor says sound is off', /Sound off/.test(await px.textContent('#wp-panel')));
    await shot(px, '09-wallpaper-video-edit');
    await px.click('#wp-apply');
    await px.waitForFunction(() => !document.querySelector('#wallpaper.open'), null, { timeout: 60000 });
    await px.waitForSelector('#cw-layer video', { timeout: 15000 });
    await sleep(1500);
    const v1 = await px.$eval('#cw-layer video', v => ({ t: v.currentTime, muted: v.muted, paused: v.paused, poster: !!v.getAttribute('poster') }));
    await sleep(1200);
    const v2 = await px.$eval('#cw-layer video', v => v.currentTime).catch(() => -1);
    ok('the video plays behind the chat', !v1.paused && v2 !== v1.t, JSON.stringify(v1) + ' ' + v2);
    ok('the wallpaper video is silent', v1.muted);
    ok('a still frame is saved as a fallback', v1.poster);
    await shot(px, '10-wallpaper-video');
    await px.click('[data-action="back"]');
    await sleep(600);
    ok('the video stops when the chat is closed', !(await px.$('#cw-layer video')));
    await openChatWith(px, `Walls ${run}`);
    ok('switching chats shows each chat’s own background', (await layerKind(px)) === 'none');
    await px.click('[data-action="back"]');
    await openChatWith(px, 'Yara Custom');
    await px.waitForSelector('#cw-layer video', { timeout: 15000 }).catch(() => null);
    ok('…and the video comes back in its chat', (await layerKind(px)) === 'video');
    await px.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await sleep(300);
    ok('the video pauses when the app goes to the background', await px.$eval('#cw-layer video', v => v.paused));
    await px.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    // Restore default
    await px.click('[data-action="chat-actions-open"]');
    await px.click('.overlay [data-action="wp-open"]');
    await px.waitForSelector('#wallpaper.open #wp-tabs', { timeout: 8000 });
    await px.click('#wp-tabs [data-v="default"]');
    await px.click('#wp-apply');
    await px.waitForFunction(() => !document.querySelector('#wallpaper.open'), null, { timeout: 15000 });
    await sleep(500);
    ok('Default restores the ZYVEN background', (await layerKind(px)) === 'none');
    if (admin) {
      const { data: me } = await admin.from('profiles').select('id').eq('username', X.username).single();
      const { data: rows } = await admin.from('chat_wallpapers').select('*').eq('user_id', me.id);
      ok('…and removes it from the server', (rows || []).length === 0);
      const { data: files } = await admin.storage.from('wallpapers').list(me.id);
      ok('old wallpaper files are cleaned up', (files || []).length === 0, (files || []).map(f => f.name).join(','));
    }

    /* ---------- Profile picture crop + frames ---------- */
    await px.click('[data-action="back"]');
    await px.click('[data-action="tab"][data-tab="profile"]');
    await px.click('#tab-profile [data-action="edit-profile"] >> nth=0');
    const face = await makeImage(px, 1200, 800, 'ME');
    await px.setInputFiles('#pfp-in', { name: 'me.jpg', mimeType: 'image/jpeg', buffer: face });
    await px.waitForSelector('#crop.open #crop-img', { timeout: 8000 });
    ok('choosing a profile picture opens crop and reposition', true);
    await px.evaluate(() => { const z = document.querySelector('#crop-zoom'); z.value = '2'; z.dispatchEvent(new Event('input', { bubbles: true })); });
    await shot(px, '11-crop');
    await px.click('[data-action="crop-done"]');
    await sleep(500);
    ok('the cropped photo shows in the preview before saving', await px.$eval('#pf-preview .av', e => /url\("?data:image\/jpeg/.test(e.style.background)));
    await px.click('.overlay form[data-form="profile"] button[type=submit]');
    await px.waitForFunction(() => !!state.profile.photoPath, null, { timeout: 20000 });
    ok('the new profile picture is saved', true);
    await px.click('#tab-profile [data-action="open-frames"]');
    await px.waitForSelector('#frames.open .fr-tile', { timeout: 8000 });
    ok('the frame screen lists original frames', (await px.$$('#frames .fr-tile')).length >= 20);
    await px.click('#fr-tabs [data-v="animated"]');
    ok('frames have categories', (await px.$$('#frames .fr-tile')).length === 2);
    await px.click('#fr-tabs [data-v="all"]');
    await px.click('#frames .fr-tile[data-v="gold"]');
    ok('picking a frame shows a live preview first', /Preview · not applied yet/.test(await px.textContent('#fr-hero')) && !!(await px.$('#fr-hero .av.framed')));
    await shot(px, '12-frames');
    await px.click('[data-action="fr-apply"]');
    await px.waitForFunction(() => state.profile.frame === 'gold', null, { timeout: 15000 });
    ok('applying the frame saves it', true);
    await px.click('[data-action="fr-close"]');
    ok('your own avatar shows the frame', !!(await px.$('#tab-profile .hero .av.framed')));
    await restart(px, X);
    ok('the frame is still there after restarting', await px.evaluate(() => state.profile.frame === 'gold'));
    // The other person sees the new photo and frame
    await restart(py, Y);
    await py.click('[data-action="tab"][data-tab="chats"]');
    await py.waitForSelector('#chats-list .row:has(.row-name:text-is("Xena Custom")) .av.framed', { timeout: 20000 }).catch(() => null);
    ok('the other person sees the frame in their chat list', !!(await py.$('#chats-list .row:has(.row-name:text-is("Xena Custom")) .av.framed')));
    ok('…around the new profile picture', await py.$eval('#chats-list .row:has(.row-name:text-is("Xena Custom")) .av', e => /url\("?https?:/.test(e.style.background)).catch(() => false));
    await shot(py, '13-y-sees-frame');
    await openChatWith(py, 'Xena Custom');
    ok('the frame shows in the chat header too', !!(await py.$('#convo-who .av.framed')));
    ok('the frame sits outside the photo circle', await py.$eval('#convo-who .av.framed', e => { const a = e.getBoundingClientRect(), f = e.querySelector('.fr-ov').getBoundingClientRect(); return f.width > a.width * 1.4 && Math.abs((f.x + f.width / 2) - (a.x + a.width / 2)) < 1; }));
    // Remove frame
    await px.click('[data-action="tab"][data-tab="profile"]');
    await px.click('#tab-profile [data-action="open-frames"]');
    await px.waitForSelector('#frames.open [data-action="fr-remove"]', { timeout: 8000 });
    await px.click('[data-action="fr-remove"]');
    await px.waitForFunction(() => state.profile.frame === null, null, { timeout: 15000 });
    await px.click('[data-action="fr-close"]');
    await restart(py, Y);
    await py.click('[data-action="tab"][data-tab="chats"]');
    await sleep(1500);
    ok('removing the frame removes it for others too', !(await py.$('#chats-list .row:has(.row-name:text-is("Xena Custom")) .av.framed')));
    ok('the original photo is unchanged by frames', await py.$eval('#chats-list .row:has(.row-name:text-is("Xena Custom")) .av', e => /url\("?https?:/.test(e.style.background)).catch(() => false));
    // A server that hasn't had the customization update yet: chats must still load.
    {
      const ctx = await browser.newContext({ viewport: { width: 393, height: 852 } });
      const po = await ctx.newPage();
      po.on('pageerror', e => errors.push(`old-server: ${e.message}`));
      await po.route(/\/rest\/v1\/profiles\?select=[^&]*frame/, r => r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: '42703', message: 'column profiles.frame does not exist', details: null, hint: null }) }));
      await po.route(/\/rest\/v1\/chat_wallpapers/, r => r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.chat_wallpapers' in the schema cache" }) }));
      await po.goto(APP);
      await signin(po, X);
      const rows = await po.waitForSelector('#chats-list .row', { timeout: 20000 }).catch(() => null);
      ok('on a server without the update, chats still load', !!rows);
      await ctx.close();
    }
  } catch (e) {
    ok('customization app test run finished without crashing', false, e.message);
  }
  ok('no JavaScript errors in the app', errors.length === 0, errors.slice(0, 5).join(' | '));
  await browser.close();
}

try { await apiTests(); } catch (e) { ok('server test run finished without crashing', false, e.stack || e.message); }
try { await uiTests(); } catch (e) { ok('app tests could start', false, e.message); }

const failed = results.filter(r => !r.pass);
const md = [`# ZYVEN photos, wallpapers & frames test results`, '', `${results.length - failed.length} passed, ${failed.length} failed`, '',
  ...['api', 'app'].flatMap(p => [`## ${p === 'api' ? 'Server rules' : 'App in two browsers'}`, '',
    ...results.filter(r => r.part === p).map(r => `- ${r.pass ? '✅' : '❌'} ${r.name}${r.pass ? '' : ` — ${r.detail}`}`), ''])].join('\n');
writeFileSync(`${OUT}/custom-e2e.md`, md);
writeFileSync(`${OUT}/custom-e2e.json`, JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
