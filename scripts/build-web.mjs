// Builds the web app that Capacitor packages into the Android APK.
//
// src/app.html is the ZYVEN app itself, the same file that runs as the Claude
// Artifact. The Artifact viewer wraps that file in a page <head> with a few
// base styles; this script does the same, so the app behaves identically on
// Android. Output: www/index.html (+ www/capacitor.js when installed).
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src', 'app.html');
const out = join(root, 'www');
const fail = msg => { console.error(`build-web: ${msg}`); process.exit(1); };

if (!existsSync(src)) fail('src/app.html is missing.');
const app = readFileSync(src, 'utf8');
const config = JSON.parse(readFileSync(join(root, 'capacitor.config.json'), 'utf8'));

// Lift <title> and stylesheet <link>s out of the app body into the <head>.
const headTags = [];
let body = app.replace(/<title>[\s\S]*?<\/title>|<link\b[^>]*>/gi, m => { headTags.push(m); return ''; });
if (!headTags.some(t => /^<title>/i.test(t))) headTags.unshift(`<title>${config.appName}</title>`);
if (!/<script>[\s\S]*<\/script>/.test(body)) fail('src/app.html has no inline <script>.');

// Capacitor's browser runtime lets the plain-JS app call native plugins
// (Filesystem, Share) without a bundler. It comes from npm install.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const vendor = [
  ['@capacitor/core/dist/capacitor.js', 'capacitor.js', 'Capacitor'],
  ['@supabase/supabase-js/dist/umd/supabase.js', 'supabase.js', 'Supabase client'],
];
const scriptTags = [];
for (const [from, to, label] of vendor) {
  const file = join(root, 'node_modules', from);
  if (existsSync(file)) { copyFileSync(file, join(out, to)); scriptTags.push(`<script src="${to}"></script>`); }
  else console.warn(`build-web: ${label} (${from}) is not installed. Run "npm install" first.`);
}

// Server connection. Only the PUBLIC values go into the app: the project
// URL and the anon/publishable key. They come from environment variables
// (GitHub Actions secrets) or a local .env file, never from the source code.
function readEnvFile() {
  const f = join(root, '.env');
  if (!existsSync(f)) return {};
  const vals = {};
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) vals[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return vals;
}
const envFile = readEnvFile();
const supabaseUrl = (process.env.SUPABASE_URL || envFile.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const supabaseAnonKey = (process.env.SUPABASE_ANON_KEY || envFile.SUPABASE_ANON_KEY || '').trim();
if (supabaseAnonKey) {
  if (/^sb_secret_/.test(supabaseAnonKey)) fail('SUPABASE_ANON_KEY is a SECRET key (sb_secret_…). Use the publishable/anon key instead. Never put a secret key in the app.');
  const parts = supabaseAnonKey.split('.');
  if (parts.length === 3) {
    let role = '';
    try { role = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).role || ''; } catch (e) { /* not a JWT */ }
    if (role === 'service_role') fail('SUPABASE_ANON_KEY is the service_role key. Use the anon (public) key instead. The service_role key must never be in the app.');
  }
}
if (supabaseUrl && !/^https:\/\/[^\s/]+$|^http:\/\/(127\.0\.0\.1|localhost|10\.0\.2\.2)(:\d+)?$/.test(supabaseUrl)) fail(`SUPABASE_URL doesn't look like a Supabase project URL: ${supabaseUrl}`);
const connected = !!(supabaseUrl && supabaseAnonKey);
if (!connected) console.warn('build-web: SUPABASE_URL / SUPABASE_ANON_KEY are not set. The app will build, but it will show "Server not connected" instead of the sign-in screen.');
writeFileSync(join(out, 'config.js'), `window.ZYVEN_CONFIG = ${JSON.stringify(connected ? { supabaseUrl, supabaseAnonKey } : {})};\n`);
scriptTags.push('<script src="config.js"></script>');
const capTag = scriptTags.join('\n');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="theme-color" content="#000000">
<meta name="color-scheme" content="dark light">
${headTags.join('\n')}
<style>
/* Base styles the Artifact viewer provides; keeps the app identical on Android. */
:root{box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
html,body{margin:0;background:#000000}
body{font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overscroll-behavior:none}
img{max-width:100%}
[hidden]{display:none!important}
</style>
${capTag}
</head>
<body>
${body.trim()}
</body>
</html>
`;
writeFileSync(join(out, 'index.html'), html);

// Sanity checks so a broken build fails here, not on the phone.
if (!html.includes(`appName: '${config.appName}'`)) fail(`the app's CONFIG.appName is not "${config.appName}".`);
const kb = Math.round(Buffer.byteLength(html) / 1024);
console.log(`build-web: wrote www/index.html (${kb} KB) with ${scriptTags.length} scripts; server ${connected ? `connected to ${supabaseUrl}` : 'NOT connected'}`);
