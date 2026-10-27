// Applies ZYVEN's Android settings to the Capacitor Android project.
// Run after "npx cap add android" (and safe to run again any time):
//   - app name ZYVEN and app ID from capacitor.config.json
//   - permissions the app actually uses (microphone, location, vibration)
//   - black status and navigation bars, black splash, resize-on-keyboard
//   - ZYVEN launcher icons and splash images from resources/android/res
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(root, 'capacitor.config.json'), 'utf8'));
const APP_ID = cfg.appId, APP_NAME = cfg.appName;
const main = join(root, 'android', 'app', 'src', 'main');
const res = join(main, 'res');
const fail = msg => { console.error(`configure-android: ${msg}`); process.exit(1); };
const done = [];

if (!existsSync(join(main, 'AndroidManifest.xml'))) fail('android/ is missing. Run "npx cap add android" first.');

/* 1. App ID in Gradle (cap add sets it; this keeps it consistent if the config changes). */
const gradlePath = join(root, 'android', 'app', 'build.gradle');
if (!existsSync(gradlePath)) fail('android/app/build.gradle is missing.');
let gradle = readFileSync(gradlePath, 'utf8');
if (!/applicationId\s+"[^"]+"/.test(gradle)) fail('applicationId not found in android/app/build.gradle.');
gradle = gradle.replace(/applicationId\s+"[^"]+"/, `applicationId "${APP_ID}"`).replace(/namespace\s*=?\s*"[^"]+"/, m => m.replace(/"[^"]+"/, `"${APP_ID}"`));
// Version: every build gets a higher versionCode so Android installs it as an update.
const vCode = Math.max(1, parseInt(process.env.ZYVEN_VERSION_CODE || '1', 10) || 1);
const vName = process.env.ZYVEN_VERSION_NAME || `1.0.${vCode}`;
if (!/versionCode\s+\d+/.test(gradle) || !/versionName\s+"[^"]*"/.test(gradle)) fail('versionCode/versionName not found in android/app/build.gradle.');
gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${vCode}`).replace(/versionName\s+"[^"]*"/, `versionName "${vName}"`);
// Release signing: the key file and password come from the build's
// environment (GitHub secrets), never from the repository.
if (!gradle.includes('ZYVEN_KEYSTORE')) {
  if (!/\n(\s*)buildTypes\s*\{/.test(gradle)) fail('buildTypes block not found in android/app/build.gradle.');
  gradle = gradle.replace(/\n(\s*)buildTypes\s*\{/, (m, ind) => `
${ind}signingConfigs {
${ind}    zyven {
${ind}        def ks = System.getenv("ZYVEN_KEYSTORE")
${ind}        if (ks) {
${ind}            storeFile file(ks)
${ind}            storePassword System.getenv("ZYVEN_KEYSTORE_PASSWORD")
${ind}            keyAlias(System.getenv("ZYVEN_KEY_ALIAS") ?: "zyven")
${ind}            keyPassword System.getenv("ZYVEN_KEYSTORE_PASSWORD")
${ind}        }
${ind}    }
${ind}}
${ind}buildTypes {`);
  if (!/\brelease\s*\{/.test(gradle)) fail('release build type not found in android/app/build.gradle.');
  gradle = gradle.replace(/\brelease\s*\{/, 'release {\n            if (System.getenv("ZYVEN_KEYSTORE")) { signingConfig signingConfigs.zyven }');
}
writeFileSync(gradlePath, gradle);
done.push(`applicationId ${APP_ID}, version ${vName} (${vCode}), release signing from environment`);

/* 2. Names shown on the home screen and in Android settings. */
writeFileSync(join(res, 'values', 'strings.xml'), `<?xml version='1.0' encoding='utf-8'?>
<resources>
    <string name="app_name">${APP_NAME}</string>
    <string name="title_activity_main">${APP_NAME}</string>
    <string name="package_name">${APP_ID}</string>
    <string name="custom_url_scheme">${APP_ID}</string>
</resources>
`);
done.push(`label ${APP_NAME}`);

/* 3. Permissions and keyboard behaviour. */
const manifestPath = join(main, 'AndroidManifest.xml');
let manifest = readFileSync(manifestPath, 'utf8');
const PERMS = [
  ['android.permission.INTERNET', 'fonts and links'],
  ['android.permission.RECORD_AUDIO', 'voice messages; asked the first time you record'],
  ['android.permission.MODIFY_AUDIO_SETTINGS', 'voice message recording quality'],
  ['android.permission.ACCESS_COARSE_LOCATION', 'location sharing; asked only when you share'],
  ['android.permission.ACCESS_FINE_LOCATION', 'precise location sharing; asked only when you share'],
  ['android.permission.VIBRATE', 'the optional vibrate-on-message setting'],
];
for (const [p, why] of PERMS) {
  if (!manifest.includes(`"${p}"`)) {
    if (!manifest.includes('</manifest>')) fail('AndroidManifest.xml has no closing </manifest> tag.');
    manifest = manifest.replace('</manifest>', `    <!-- ${why} -->\n    <uses-permission android:name="${p}" />\n</manifest>`);
  }
}
const act = manifest.match(/<activity\b[^>]*>/);
if (!act) fail('No <activity> found in AndroidManifest.xml.');
if (!/windowSoftInputMode/.test(act[0])) manifest = manifest.replace(act[0], act[0].replace('<activity', '<activity\n            android:windowSoftInputMode="adjustResize"'));
writeFileSync(manifestPath, manifest);
done.push(`permissions ${PERMS.map(p => p[0].split('.').pop()).join(', ')}`);

/* 4. Black system bars and splash (AMOLED). Style names match Capacitor's template. */
writeFileSync(join(res, 'values', 'colors.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="colorPrimary">#000000</color>
    <color name="colorPrimaryDark">#000000</color>
    <color name="colorAccent">#FFFFFF</color>
    <color name="zyvenBlack">#000000</color>
</resources>
`);
const appTheme = `
    <style name="AppTheme" parent="Theme.AppCompat.NoActionBar">
        <item name="colorPrimary">@color/colorPrimary</item>
        <item name="colorPrimaryDark">@color/colorPrimaryDark</item>
        <item name="colorAccent">@color/colorAccent</item>
        <item name="android:windowBackground">@color/zyvenBlack</item>
        <item name="android:statusBarColor">@color/zyvenBlack</item>
        <item name="android:navigationBarColor">@color/zyvenBlack</item>
        <item name="android:windowLightStatusBar">false</item>
    </style>`;
const noBar = extra => `
    <style name="AppTheme.NoActionBar" parent="Theme.AppCompat.NoActionBar">
        <item name="windowActionBar">false</item>
        <item name="windowNoTitle">true</item>
        <item name="android:background">@null</item>
        <item name="android:windowBackground">@color/zyvenBlack</item>
        <item name="android:statusBarColor">@color/zyvenBlack</item>
        <item name="android:navigationBarColor">@color/zyvenBlack</item>
        <item name="android:windowLightStatusBar">false</item>${extra}
    </style>`;
const launch = `
    <style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="android:background">@drawable/splash</item>
        <item name="windowSplashScreenBackground">@color/zyvenBlack</item>
        <item name="windowSplashScreenAnimatedIcon">@mipmap/ic_launcher_foreground</item>
        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>
    </style>`;
writeFileSync(join(res, 'values', 'styles.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<resources>${appTheme}${noBar('')}${launch}\n</resources>\n`);
// Android 15: keep the app below the status bar instead of drawing under it.
mkdirSync(join(res, 'values-v35'), { recursive: true });
writeFileSync(join(res, 'values-v35', 'styles.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<resources>${noBar('\n        <item name="android:windowOptOutEdgeToEdgeEnforcement">true</item>')}\n</resources>\n`);
done.push('black status/navigation bars and splash');

/* 5. Icons and splash images. */
const assets = join(root, 'resources', 'android', 'res');
if (!existsSync(assets)) fail('resources/android/res is missing.');
let copied = 0;
const walk = dir => readdirSync(dir).forEach(name => {
  const p = join(dir, name);
  if (statSync(p).isDirectory()) return walk(p);
  const dest = join(res, relative(assets, p));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(p, dest); copied++;
});
walk(assets);
done.push(`${copied} icon and splash files`);

console.log(`configure-android: ${APP_NAME} (${APP_ID})\n  - ${done.join('\n  - ')}`);
