# ZYVEN

ZYVEN is a messaging app with an AMOLED-black design, customizable message
bubbles, stickers, voice messages, and groups. People create real accounts,
find each other by username, and chat live between phones. Messages, files,
and profiles are stored on your own **Supabase** server.

- **App name:** ZYVEN · **Android app ID:** `com.zyven.messaging`
- **App code:** plain HTML/CSS/JavaScript in `src/app.html`, packaged for
  Android with [Capacitor 7](https://capacitorjs.com)
- **Server:** [Supabase](https://supabase.com) (accounts, database, file
  storage, realtime). Setup is one SQL file: `supabase/migrations/…_zyven_init.sql`
- **APK:** built automatically by GitHub Actions

---

## Download the app

On your Android phone, open:

**https://github.com/mostafa02235-sys/ZYVEN/releases/latest/download/ZYVEN-debug.apk**

Tap the downloaded file → **Install** (allow installs from this source if
asked; if Play Protect warns, tap **More details → Install anyway**).

> The app only works after its server is connected (next section). Until
> then it opens on a “Server not connected” screen.

---

## Connect your server (once, about 10 minutes)

### 1. Create a Supabase project
1. Go to [supabase.com](https://supabase.com) and sign up (free plan is fine).
2. Click **New project**. Pick a name (e.g. `zyven`), a region near you, and
   a database password. Keep that password to yourself. ZYVEN never needs it.
3. Wait until the project says it’s ready.

### 2. Create the ZYVEN database
1. Open this file on GitHub:
   [`supabase/migrations/20261027000000_zyven_init.sql`](supabase/migrations/20261027000000_zyven_init.sql)
   and click the **Copy raw file** button (two overlapping squares).
2. In Supabase, open **SQL Editor** (left menu) → **New query**.
3. Paste, then click **Run**. You should see “Success. No rows returned”.
   Run it only once; a second run says things “already exist”.

### 3. Two sign-in settings
In Supabase, go to **Authentication**:
1. **Sign In / Providers → Email**: turn **off** “Confirm email”, then
   **Save**. People can then use the app right after signing up. (If you
   leave it on, they must click a link in an email before their first sign-in.)
2. **Emails → Reset Password** (under Templates): replace the message body
   with the contents of [`supabase/templates/recovery.html`](supabase/templates/recovery.html)
   and **Save**. This puts the 6-digit reset code into the email, which the app asks for.

> Supabase’s built-in email service only sends a few emails per hour, which is
> fine for testing. For real use, add your own email provider in
> **Authentication → Emails → SMTP Settings**.

### 4. Copy your server’s two public values
In Supabase: **Project Settings → API Keys** (or the **Connect** button):
- **Project URL**, like `https://abcdefgh.supabase.co`
- **anon public** key (a long text starting with `eyJ`), or the
  **publishable** key (starting with `sb_publishable_`)

Both are meant to be inside apps; your data is protected by the database
rules from step 2. **Never** use the `service_role` key or a `sb_secret_`
key. The build stops if it sees one.

### 5. Give them to GitHub
In your GitHub repository: **Settings → Secrets and variables → Actions →
New repository secret**. Add two secrets:

| Name | Value |
|---|---|
| `SUPABASE_URL` | your Project URL |
| `SUPABASE_ANON_KEY` | your anon public (or publishable) key |

### 6. Build the connected app
**Actions** tab → **Build ZYVEN Android APK** → **Run workflow** → **Run
workflow**. When it shows a green tick (about 5–10 minutes), download the APK
from the link at the top of this page and install it. If an older ZYVEN is
installed, uninstall it first (see *Limitations*).

---

## What works

| Works for real | Not built yet |
|---|---|
| Sign up with email and password, sign in, sign out, reset a forgotten password with an emailed code, change password | Voice and video calls |
| Unique username, display name, bio, colour, and profile photo, editable any time | Notifications while the app is closed (push) |
| Searching real registered people by @username or name, adding contacts | End-to-end encryption |
| Private chats and group chats between different phones, delivered live | A moderation team for reports |
| Text, photos, videos, files, voice messages, stickers (including your own), locations | |
| Replies, edits, delete for everyone / for me, reactions, pins, forwarding | |
| Sending, sent, delivered, read, and “not sent · retry” states | |
| Typing indicators, online status, last seen | |
| Group admins, adding/removing members, leaving, group info and picture | |
| Blocking, reporting, disappearing messages | |
| Privacy for online status, last seen, profile photo, read receipts | |
| Your theme, bubble design, stickers, saved messages (kept on the phone) | |

There are no sample people or demo chats: a new account starts empty.

### How your data is protected
- Every table has **row-level security**: people can only read conversations
  they are members of, and only change what the rules allow (e.g. only the
  sender can edit; only admins can add members). The app’s key cannot get
  around these rules.
- Photos, videos, voice messages, and files are stored privately. Only
  members of the chat get short-lived download links.
- Passwords are handled by Supabase Auth (stored hashed, never in plain text).
- Messages are protected by these access rules but are **not** end-to-end
  encrypted: whoever runs the Supabase project could read them.

### Permissions on the phone
- **Microphone:** asked the first time you record a voice message.
- **Location:** asked only when you share your location.
- Photos, videos, and files use Android’s own picker, so no storage permission is needed.

---

## Automatic tests

Every change runs **Test ZYVEN backend** (Actions tab). It starts a private,
temporary Supabase server on GitHub, loads the database, and checks:

- 78 database rules (outsiders can’t read, post, react, pin, upload, or
  download in other people’s chats; blocked people can’t message; group
  admin rules; disappearing messages; no fake system messages or backdating)
- accounts, search, contacts, live delivery between two accounts, file
  storage permissions, password reset by email code
- the real app in two separate browsers: both sign up, one finds and adds
  the other, they chat live, see read receipts, share a photo, create a
  group, sign out and back in

The report appears on the run’s summary page and in the `test-results` branch.

---

## Updating the app on your phone

Every change pushed to `main` builds a new APK at the same download link.
Your chats live on the server, so reinstalling loses nothing except the
settings kept on the phone (theme, bubble design, stickers, saved messages:
use **Profile → Account → Back up settings** first if you want to keep them).

---

## If the .github folder is missing

Create the build file by hand: **Add file → Create new file**, name it
exactly `.github/workflows/build-android.yml`, paste the contents below, and
click **Commit changes**.

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

      - name: Build the web app (with your Supabase server address)
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}
        run: |
          if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_ANON_KEY" ]; then
            echo "::warning title=Server not connected::The SUPABASE_URL and SUPABASE_ANON_KEY secrets are not set. The APK will open on a 'Server not connected' screen. See README → Connect your server."
          fi
          npm run build

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

## If a build fails

Open the failed run, click the job, and expand the step with the red ❌.
Most problems are a missing file or a mistyped secret name. Click **Re-run
jobs → Re-run all jobs** to try again.

---

## Limitations

- **Debug build:** `ZYVEN-debug.apk` is for installing yourself. Google Play
  needs a release build signed with your own private key.
- **Updates need a reinstall:** each GitHub build signs the APK with a new
  temporary key, so Android won’t install a new build over an old one.
  Uninstall the old ZYVEN, then install the new APK and sign in.
- **Push notifications** (alerts while the app is closed) need Firebase Cloud
  Messaging and a server function. Not set up yet.
- **Email sending** on Supabase’s free built-in service is limited to a few
  emails per hour. Add your own SMTP provider for real use.
- **Fonts** load from the internet; offline, the phone’s fonts are used.

---

## Project structure

| Path | What it is |
|---|---|
| `src/app.html` | The ZYVEN app: screens, styles, logic, and the server connection (section “4b. CLOUD”) |
| `supabase/migrations/` | The database: tables, security rules, functions, storage, realtime |
| `supabase/templates/recovery.html` | Password-reset email with the 6-digit code |
| `scripts/build-web.mjs` | Builds `www/` and writes your public server values into it |
| `scripts/configure-android.mjs` | App name, ID, permissions, black bars, icons, splash |
| `scripts/make-icons.py` | Redraws icons from the logo |
| `tests/` | Database rule tests and two-account end-to-end tests |
| `.github/workflows/build-android.yml` | Builds the APK and publishes the download link |
| `.github/workflows/test-backend.yml` | Runs the tests on a temporary Supabase server |
| `.env.example` | Placeholder values for building on your own computer |

### Building on your own computer (optional)
Requires Node.js 20+, JDK 21, and the Android SDK. Copy `.env.example` to
`.env` and fill in your two public values, then:

```
npm install
npm run build
npx cap add android
npm run android:configure
npx cap sync android
cd android && ./gradlew assembleDebug
```
