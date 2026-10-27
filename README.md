# ZYVEN

ZYVEN is a messaging app with an AMOLED-black design, customizable message
bubbles, stickers, voice messages, groups, and privacy settings. This
repository packages it as an Android app and builds the installable APK for
you on GitHub, so you don't need Android Studio or a terminal.

- **App name:** ZYVEN
- **Android app ID:** `com.zyven.messaging`
- **Built with:** plain HTML/CSS/JavaScript (one file, `src/app.html`) wrapped
  for Android with [Capacitor 7](https://capacitorjs.com)
- **Output:** `ZYVEN-debug.apk`, built by GitHub Actions

---

## Download ZYVEN (easiest)

Open this link on your Android phone. It downloads the newest APK directly:

**https://github.com/mostafa02235-sys/ZYVEN/releases/latest/download/ZYVEN-debug.apk**

Then tap the downloaded file → **Install** (allow installs from this source if asked).
Every new build replaces the file at that same link.

## Get your APK in 10 steps (no terminal needed)

### 1. Get the project files
Download `zyven-android-project.zip` and **extract it** (Windows: right-click →
*Extract All*; Mac: double-click). You get a folder named `zyven` with these
items inside:

```
.github/          ← contains the build instructions for GitHub (important!)
.gitignore
README.md
capacitor.config.json
package.json
resources/
scripts/
src/
```

> **Mac users:** folders whose names start with a dot (`.github`, `.gitignore`)
> are hidden in Finder. Press **Cmd + Shift + .** (period) in the folder to show them.

### 2. Create a GitHub repository
1. Sign in at [github.com](https://github.com) (create a free account if needed).
2. Click **+** (top right) → **New repository**.
3. Name it `zyven`. Choose **Private** (recommended) or Public.
4. Leave "Add a README" **unticked**. Click **Create repository**.

### 3. Upload the files
1. On the new, empty repository page, click the link **uploading an existing file**.
2. Open the extracted `zyven` folder on your computer, select **everything inside
   it** (including `.github` and `.gitignore`), and drag it onto the GitHub page.
   Drag the *contents*, not the `zyven` folder itself.
3. Wait until all files are listed, then click **Commit changes**.
4. Check that the repository now shows a `.github` folder. If it doesn't, see
   [If the .github folder is missing](#if-the-github-folder-is-missing) below.

### 4. Find the workflow
Click the **Actions** tab at the top of your repository. You'll see
**Build ZYVEN Android APK** in the list on the left. (If GitHub asks you to
enable workflows, click the green button to enable them.)

### 5. Run the workflow
Uploading the files already starts a build automatically. To start one
yourself: click **Build ZYVEN Android APK** → **Run workflow** (right side) →
**Run workflow**.

### 6. Check whether the build succeeded
Each run shows an icon:
- 🟡 yellow circle = still running (takes about 5–10 minutes)
- ✅ green tick = success
- ❌ red cross = failed (see [If the build fails](#if-the-build-fails))

### 7. Open the successful run
Click the run with the green tick.

### 8. Download the APK
Scroll to the bottom of the run page to **Artifacts** and click
**ZYVEN-debug-apk**. A ZIP file downloads.

### 9. Extract it
GitHub always wraps artifacts in a ZIP. Extract it to get **`ZYVEN-debug.apk`**.
(On the phone, the Files app can extract ZIPs too: tap the ZIP → *Extract*.)

### 10. Install on your Android phone
1. Copy `ZYVEN-debug.apk` to your phone (USB cable, Google Drive, email to
   yourself, or download the artifact directly on the phone's browser while
   signed in to GitHub).
2. Tap the APK file. Android will ask to allow installing apps from this
   source (for example *Files* or *Chrome*): tap **Settings** → turn on
   **Allow from this source** → go back → **Install**.
3. If **Google Play Protect** warns about an unknown app, tap
   **More details → Install anyway**. This is normal for apps not from the Play
   Store; the debug APK is signed with a temporary development key.
4. Open **ZYVEN** from your home screen.

**Updating later:** each GitHub build signs the APK with a new temporary key,
so Android usually won't install a new build over an old one. Use **Back up
data** in the app, uninstall the old ZYVEN, install the new APK, then
**Restore from backup**. (See *Limitations*.)

---

## If the .github folder is missing

Some computers hide or skip it when uploading. Create the file by hand:

1. In your repository click **Add file → Create new file**.
2. In the name box type exactly: `.github/workflows/build-android.yml`
   (typing the `/` creates the folders).
3. Paste the complete contents below, then click **Commit changes**.

```yaml
name: Build ZYVEN Android APK

# Runs every time you upload (push) changes to the main branch,
# and whenever you press "Run workflow" on the Actions tab.
on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: write  # lets the build publish the APK as a direct download

jobs:
  build:
    name: Build ZYVEN-debug.apk
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - name: Check out the repository
        uses: actions/checkout@v5

      - name: Set up Node.js
        uses: actions/setup-node@v5
        with:
          node-version: 22

      - name: Install dependencies
        run: |
          if [ -f package-lock.json ]; then npm ci; else npm install; fi

      - name: Build the web app
        run: npm run build

      - name: Create the Android project (first build only)
        run: |
          if [ -d android ]; then
            echo "android/ is already in the repository; keeping it."
          else
            npx cap add android
          fi

      - name: Apply ZYVEN settings (name, app ID, permissions, icons, splash)
        run: npm run android:configure

      - name: Copy the web app into the Android project
        run: npx cap sync android

      - name: Set up Java 21
        uses: actions/setup-java@v5
        with:
          distribution: temurin
          java-version: 21
          cache: gradle

      - name: Set up the Android SDK
        run: |
          # GitHub's Ubuntu machines come with the Android SDK; use it if present.
          SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
          SDKM=$(ls "$SDK"/cmdline-tools/latest/bin/sdkmanager "$SDK"/cmdline-tools/*/bin/sdkmanager 2>/dev/null | head -n 1)
          if [ -z "$SDKM" ]; then
            echo "Android SDK not found; installing it."
            SDK="$HOME/android-sdk"
            mkdir -p "$SDK/cmdline-tools"
            curl -sSfL -o /tmp/cmdtools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
            unzip -q /tmp/cmdtools.zip -d "$SDK/cmdline-tools"
            mv "$SDK/cmdline-tools/cmdline-tools" "$SDK/cmdline-tools/latest"
            SDKM="$SDK/cmdline-tools/latest/bin/sdkmanager"
          fi
          echo "Android SDK: $SDK"
          echo "ANDROID_HOME=$SDK" >> "$GITHUB_ENV"
          echo "ANDROID_SDK_ROOT=$SDK" >> "$GITHUB_ENV"
          yes | "$SDKM" --sdk_root="$SDK" --licenses > /dev/null || true
          "$SDKM" --sdk_root="$SDK" "platform-tools" "platforms;android-35" "build-tools;35.0.0" > /dev/null
          echo "sdk.dir=$SDK" > android/local.properties

      - name: Build the debug APK
        working-directory: android
        run: |
          chmod +x gradlew
          ./gradlew assembleDebug --no-daemon --stacktrace

      - name: Check the APK and name it ZYVEN-debug.apk
        run: |
          APK=android/app/build/outputs/apk/debug/app-debug.apk
          if [ ! -f "$APK" ]; then
            echo "::error::The APK was not created at $APK"
            exit 1
          fi
          cp "$APK" ZYVEN-debug.apk
          AAPT=$(ls "$ANDROID_HOME"/build-tools/*/aapt 2>/dev/null | sort -V | tail -n 1)
          if [ -n "$AAPT" ]; then
            "$AAPT" dump badging ZYVEN-debug.apk | tee badging.txt | head -n 5
            grep -q "package: name='com.zyven.messaging'" badging.txt || { echo "::error::Wrong app ID in the APK"; exit 1; }
            grep -q "application-label:'ZYVEN'" badging.txt || { echo "::error::App name in the APK is not ZYVEN"; exit 1; }
          fi
          ls -lh ZYVEN-debug.apk
          echo "### ZYVEN-debug.apk built ($(du -h ZYVEN-debug.apk | cut -f1))" >> "$GITHUB_STEP_SUMMARY"

      - name: Upload ZYVEN-debug.apk
        uses: actions/upload-artifact@v5
        with:
          name: ZYVEN-debug-apk
          path: ZYVEN-debug.apk
          if-no-files-found: error
          retention-days: 30

      - name: Upload the dependency lockfile
        if: hashFiles('package-lock.json') != ''
        uses: actions/upload-artifact@v5
        with:
          name: package-lock
          path: package-lock.json
          retention-days: 30

      - name: Publish ZYVEN-debug.apk as a direct download link
        if: github.ref == 'refs/heads/main'
        env:
          GH_TOKEN: ${{ github.token }}
          GH_REPO: ${{ github.repository }}
        run: |
          gh release delete latest --yes --cleanup-tag || true
          gh release create latest ZYVEN-debug.apk \
            --target "${{ github.sha }}" \
            --title "ZYVEN (latest build)" \
            --notes "Tap ZYVEN-debug.apk below to download, then open it on your Android phone to install." \
            --latest
          echo "Direct download: https://github.com/${{ github.repository }}/releases/latest/download/ZYVEN-debug.apk" >> "$GITHUB_STEP_SUMMARY"
```

---

## If the build fails

1. Open the failed run, click the **Build ZYVEN-debug.apk** job, and expand the
   step with the red ❌ to read the error.
2. Most first-time failures are a missing file from the upload. Compare your
   repository with the file list in step 1.
3. Click **Re-run jobs → Re-run all jobs** to try again (occasional download
   hiccups on GitHub's side fix themselves).

---

## What works in the Android app

Everything in ZYVEN runs **on your phone only**. There is no server yet, so
messages never leave the device.

| Works for real, on the device | Simulated (demo only) | Needs a backend (not built yet) |
|---|---|---|
| The whole interface: Chats (All / Unread), Contacts, Groups, Profile | Other people, their replies, typing indicators, online status | Sending messages to real people |
| Sending, replying, editing, deleting, reacting, pinning, forwarding, saved messages | Delivered/read ticks | Accounts and sign-in |
| Bubble designs, Default design, colors, radius, spacing, text size, per-chat styles | Group members other than you | Syncing between devices |
| Stickers: creating, animated stickers, sending | Disappearing messages for other people | Push notifications |
| Photos, videos, files: picking and previewing | | Media storage in the cloud |
| Voice messages: real microphone recording, playback, pause, progress | | Voice/video calls (not planned yet) |
| Location sharing (real GPS position) | | |
| Profile, privacy, notification, and theme settings | | |
| Back up and restore all data (Profile → account sheet) | | |

Data is saved inside the app on the phone. Uninstalling the app deletes it,
so use **Back up data** first.

### Moving data from the Claude Artifact version
The Artifact and the Android app store data separately. In the Artifact, use
**Back up data** to save a `.json` file, put it on your phone, then in the
Android app use **Restore from backup**.

### Permissions
ZYVEN asks only when a feature needs it:
- **Microphone** — the first time you record a voice message.
- **Location** — only when you share your location.
- Photos, videos, and files use Android's own file picker, so no storage
  permission is needed.
- Vibration and internet (for the optional web font) are granted automatically.

If you tap "Don't allow" by mistake: **Settings → Apps → ZYVEN → Permissions**.

---

## Making ZYVEN a real multi-user messenger (future work)

To message real people, ZYVEN needs a backend. That means:
1. **User accounts** (sign-up, sign-in, phone or email verification).
2. **A database** for users, chats, and messages.
3. **Real-time sync** so messages arrive instantly on every device.
4. **Access rules** so each person can read only their own chats.
5. **Media storage** for photos, videos, voice messages, and stickers.
6. **Push notifications** (Firebase Cloud Messaging on Android).
7. Ideally **end-to-end encryption**.

Services such as Firebase or Supabase provide most of this. Their keys must
be configured through GitHub **Secrets**, never written into the code.

---

## Limitations

- **Debug build:** `ZYVEN-debug.apk` is for installing and testing yourself.
  It can't be uploaded to the Google Play Store, which needs a *release* build
  signed with your own private key (kept in GitHub Secrets).
- **Signing key changes:** each debug build is signed with a key GitHub
  creates for that run. If Android refuses to install an update over an older
  copy ("App not installed" / package conflict), back up your data,
  uninstall the old app, then install the new APK and restore.
- **Fonts:** the app's web fonts load from the internet. Offline, it uses the
  phone's built-in fonts; everything else works offline.
- **No lockfile yet:** dependencies are pinned to Capacitor 7.x
  (`^7.0.0` in `package.json`). Each build also uploads a `package-lock`
  artifact; upload that `package-lock.json` file to the repository to lock
  the exact versions for future builds.

---

## Project structure (for the curious)

| Path | What it is |
|---|---|
| `src/app.html` | The ZYVEN app itself: all screens, styles, and logic |
| `scripts/build-web.mjs` | Turns `src/app.html` into the web bundle (`www/`) that goes inside the APK |
| `scripts/configure-android.mjs` | Applies the ZYVEN name, app ID, permissions, black bars, icons, and splash to the Android project |
| `scripts/make-icons.py` | Redraws the icons from the logo (only needed if the logo changes) |
| `resources/` | ZYVEN logo (`logo.svg`, `icon-1024.png`) and the generated Android icons/splash |
| `capacitor.config.json` | App name, app ID, and Android settings |
| `package.json` | Dependencies and build commands |
| `.github/workflows/build-android.yml` | The GitHub Actions build |

The `android/` project is generated fresh by Capacitor during each build
(`npx cap add android`), then customised by `configure-android.mjs`. If you
later want to edit the Android project by hand, commit the generated
`android/` folder; the workflow will then use it as-is.

### Building on your own computer (optional)
Requires Node.js 20+, JDK 21, and the Android SDK:

```
npm install
npm run build
npx cap add android
npm run android:configure
npx cap sync android
cd android && ./gradlew assembleDebug
```
