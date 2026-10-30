// Runs ZYVEN on a real Android emulator (the actual APK, inside Android's
// WebView) and tests the Frame Creator there against a local Supabase server.
// Run by .github/workflows/test-android.yml inside the emulator job.
//
// What is real here: the Android system, the app's WebView, its canvas/video
// decoding, uploads to the server, and rendering. What is driven by the test:
// the native file picker can't be tapped by automation, so test pictures and a
// test MP4 are handed to the same function the picker calls (studioLoad).
//
// Env: SUPABASE_URL (as seen from this machine), SUPABASE_ANON_KEY, ASSETS_URL
// (as seen from the emulator, serves tests/assets), APK
import { _android as android } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const OUT = 'tests/results';
mkdirSync(`${OUT}/screens`, { recursive: true });
const results = [];
const ok = (name, pass, detail = '') => { results.push({ name, pass: !!pass, detail: String(detail || '').slice(0, 300) }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail && !pass ? `  — ${detail}` : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = Date.now().toString(36).slice(-6);
const PKG = 'com.zyven.messaging';
const ASSETS = process.env.ASSETS_URL;

let device, page;
/* Never hang the job: give up after 15 minutes with a report. */
const watchdog = setTimeout(() => { ok('Android test run finished in time', false, 'stopped after 15 minutes'); finish(); }, 15 * 60e3);
const shot = async name => { try { writeFileSync(`${OUT}/screens/android-${name}.png`, await device.screenshot()); } catch (e) {} };
const until = (fn, arg, ms = 20000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);

try {
  execSync(`adb install -r -g "${process.env.APK}"`, { stdio: 'inherit' });
  [device] = await android.devices();
  ok('emulator found', !!device, 'no device');
  const info = await device.shell('getprop ro.build.version.release').then(String);
  const wv = await device.shell('dumpsys package com.google.android.webview | grep versionName | head -1').then(String).catch(() => '');
  console.log(`Android ${info.trim()}, WebView ${wv.trim()}`);
  const openApp = async () => {
    for (let i = 0; i < 3; i++) {
      await device.shell(`am start -n ${PKG}/.MainActivity`);
      try {
        for (let k = 0; k < 60 && !String(await device.shell(`pidof ${PKG}`)).trim(); k++) await sleep(1000);
        return await device.webView({ pkg: PKG }, { timeout: 60000 });
      } catch (e) {
        console.log(`WebView not ready yet (${i + 1}/3): ${e.message.split('\n')[0]}`);
        console.log('pid:', String(await device.shell(`pidof ${PKG}`)).trim(), 'webviews:', device.webViews().map(w => w.pkg()).join(',') || 'none', 'sockets:', String(await device.shell('cat /proc/net/unix | grep -a devtools_remote')).trim().slice(0, 300)); await device.shell(`am force-stop ${PKG}`); await sleep(3000); }
    }
    throw new Error('The app’s WebView never became reachable');
  };
  const webview = await openApp();
  page = await webview.page();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  ok('ZYVEN opens on Android', await until(() => !!document.querySelector('#gate #au-go'), null, 60000));
  await shot('01-open');

  // Sign up
  const U = { name: 'Droid Frames', username: `dr_${run}`, email: `dr_${run}@example.com`, password: `Dr-${run}-123x` };
  await page.click('text=Create an account');
  await page.fill('#au-name', U.name); await page.fill('#au-user', U.username);
  await page.fill('#au-email', U.email); await page.fill('#au-pass', U.password);
  await page.click('#au-go');
  ok('sign up works inside the Android app', await until(() => document.querySelector('#gate')?.hidden || getComputedStyle(document.querySelector('#gate')).display === 'none', null, 30000));
  await until(() => !!Cloud.me, null, 20000);

  // Open Frame Creator from Settings
  await page.click('[data-action="tab"][data-tab="profile"]');
  await page.click('#tab-profile [data-action="fs-open"]');
  ok('Frame Creator opens', await until(() => !!document.querySelector('#fstudio.open #fs-big .fr-ov.cf .cf-base'), null, 15000));
  await shot('02-studio');

  // A picture, processed on the phone
  const loadAsset = async (name, type) => page.evaluate(async ([u, n, t]) => {
    const r = await fetch(u); const b = await r.blob();
    await studioLoad(new File([b], n, { type: t }));
    return { kind: ui.fs.src?.kind, frames: ui.fs.src?.frames?.length || 0, pal: ui.fs.src?.palette?.length || 0, err: ui.fs.err };
  }, [`${ASSETS}/${name}`, name, type]);
  const pic = await loadAsset('shapes.jpg', 'image/jpeg');
  ok('picture: colours extracted on the phone', pic.kind === 'image' && pic.pal >= 3, JSON.stringify(pic));
  await page.evaluate(() => { studioSet('fill', 'gradient'); });
  await page.evaluate(() => { const c = document.querySelector('[data-input="fs-cut"]'); c.checked = true; c.dispatchEvent(new Event('input', { bubbles: true })); });
  ok('picture: subject cut out on the phone', await until(() => ui.fs.src?.cutRatio > 0.3 && ui.fs.spec.els > 0, null, 15000));
  await page.evaluate(() => { studioSet('shape', 'scallop'); studioSet('anim', 'k'); ui.fs.spec.name = 'Android sparkle'; });
  ok('animated preview runs in Android WebView', await until(() => { const i = document.querySelector('#fs-big .cf-pts i'); return i && getComputedStyle(i).animationName === 'cfTw'; }, null, 15000));
  await shot('03-picture');
  await page.click('[data-action="fs-save"][data-apply="1"]');
  ok('save & apply works on Android', await until(() => ui.fs?.tab === 'library' && Array.isArray(ui.fs.lib) && !!state.profile.frame, null, 40000));
  const f1 = await page.evaluate(async () => {
    const p = CF.paths(state.profile.frame, Cloud.me), { data } = await sb.storage.from('avatars').download(p.base);
    const bm = await createImageBitmap(data), c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height;
    const g = c.getContext('2d'); g.drawImage(bm, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data, a = (x, y) => d[(y * c.width + x) * 4 + 3];
    let center = 0; for (let y = 90; y < 420; y += 3) for (let x = 90; x < 420; x += 3) if (Math.hypot(x - 256, y - 256) < 170) center = Math.max(center, a(x, y));
    return { w: c.width, center, corner: a(0, 0), code: state.profile.frame };
  });
  ok('saved frame is a transparent 512 px PNG with a clear middle', f1.w === 512 && f1.center === 0 && f1.corner === 0, JSON.stringify(f1));
  await shot('04-library');

  // Someone else sees it (server check from outside the phone)
  const other = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  await other.auth.signUp({ email: `dro_${run}@example.com`, password: `Dro-${run}-123x`, options: { data: { username: `dro_${run}`, display_name: 'Other' } } });
  const found = await other.rpc('search_profiles', { q: U.username });
  ok('other people get the frame with the profile', found.data?.[0]?.frame === f1.code, JSON.stringify(found.data?.[0]?.frame || found.error));
  const owner = found.data?.[0]?.id, id = /^c-([a-z0-9]{10})/.exec(f1.code)?.[1];
  const dl = await other.storage.from('avatars').download(`${owner}/frames/${id}.png`);
  ok('…and can load the frame picture', !dl.error && dl.data?.size > 1000, dl.error?.message);

  // A real MP4 video, decoded by Android's WebView
  await page.click('[data-action="fs-new"]');
  const vid = await loadAsset('clip.mp4', 'video/mp4');
  ok('MP4 video: 8 frames taken on the phone', vid.kind === 'video' && vid.frames === 8, JSON.stringify(vid));
  ok('video loop preview plays on Android', await until(() => { const i = document.querySelector('#fs-big .cf-vid i.run'); return i && getComputedStyle(i).animationName === 'cfVid'; }, null, 15000));
  await shot('05-video');
  await page.click('[data-action="fs-save"][data-apply="1"]');
  ok('video frame saved and applied on Android', await until(() => ui.fs?.tab === 'library' && /^c-[a-z0-9]{10}-v\d\d8-/.test(state.profile.frame || ''), null, 60000));
  await page.click('[data-action="fs-close"]');
  ok('profile shows the video loop frame', await until(() => !!document.querySelector('#tab-profile .fr-ov.cf .cf-vid i'), null, 15000));
  await shot('06-profile');

  // Restart the app: still there
  await device.shell(`am force-stop ${PKG}`); await sleep(1500);
  const wv2 = await openApp(); page = await wv2.page();
  ok('after restarting the app, the frame is still on the profile', await until(() => /^c-/.test(state?.profile?.frame || ''), null, 40000));
  await shot('07-restart');
  ok('no JavaScript errors in the app', errors.length === 0, errors.slice(0, 5).join(' | '));
} catch (e) {
  ok('Android test run finished without crashing', false, e.stack || e.message);
  await shot('error');
}

function finish() {
const failed = results.filter(r => !r.pass);
writeFileSync(`${OUT}/android-e2e.md`, [`# ZYVEN on Android (emulator) — Frame Creator`, '', `${results.length - failed.length} passed, ${failed.length} failed`, '',
  ...results.map(r => `- ${r.pass ? '✅' : '❌'} ${r.name}${r.pass ? '' : ` — ${r.detail}`}`)].join('\n'));
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
clearTimeout(watchdog);
try { device?.close(); } catch (e) {}
process.exit(failed.length ? 1 : 0);
}
finish();
