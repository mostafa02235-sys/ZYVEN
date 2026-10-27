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
const capRuntime = join(root, 'node_modules', '@capacitor', 'core', 'dist', 'capacitor.js');
let capTag = '';
if (existsSync(capRuntime)) {
  copyFileSync(capRuntime, join(out, 'capacitor.js'));
  capTag = '<script src="capacitor.js"></script>';
} else {
  console.warn('build-web: @capacitor/core is not installed, so capacitor.js was not copied. Run "npm install" first for an Android build.');
}

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
console.log(`build-web: wrote www/index.html (${kb} KB)${capTag ? ' and www/capacitor.js' : ''}`);
