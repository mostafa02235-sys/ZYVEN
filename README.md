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
- **APK:** a signed release build (`ZYVEN.apk`), built automatically by GitHub Actions

---

## Download the app

On your Android phone, open:

**https://github.com/mostafa02235-sys/ZYVEN/releases/latest/download/ZYVEN.apk**

Tap the downloaded file → **Install** (allow installs from this source if
asked; if Play Protect warns, tap **More details → Install anyway**).

> If an older ZYVEN is installed, uninstall it first (see *Limitations*).

---

## Your server

ZYVEN is connected to the Supabase project **uztkmmwegwyjfqphcxkg**
(`https://uztkmmwegwyjfqphcxkg.supabase.co`). The database, security rules,
storage, and realtime are already set up there, and the app’s public
address and key are in `zyven.config.json`.

Two settings can only be changed in the Supabase dashboard:

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

### Using a different Supabase project
1. Create a project, open **SQL Editor → New query**, paste
   [`supabase/migrations/20261027000000_zyven_init.sql`](supabase/migrations/20261027000000_zyven_init.sql), and **Run**.
2. Do the two settings above.
3. Put its **Project URL** and **anon public** key into `zyven.config.json`
   (or into the GitHub secrets `SUPABASE_URL` and `SUPABASE_ANON_KEY`, which
   take priority). Never use the `service_role` key or a `sb_secret_` key;
   the build stops if it sees one.
4. **Actions → Build ZYVEN Android APK → Run workflow**.

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

Every change pushed to `main` builds a new APK at the same download link,
with a higher version number. With the permanent signing key set (below),
just install it over the old one. Your chats live on the server either way.

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
    name: Build ZYVEN.apk
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
          if { [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_ANON_KEY" ]; } && [ ! -f zyven.config.json ]; then
            echo "::warning title=Server not connected::No server address found (secrets or zyven.config.json). The APK will open on a 'Server not connected' screen. See README → Connect your server."
          fi
          npm run build

      - name: Create the Android project (first build only)
        run: |
          if [ -d android ]; then
            echo "android/ is already in the repository; keeping it."
          else
            npx cap add android
          fi

      - name: Apply ZYVEN settings (name, app ID, version, permissions, icons, splash)
        env:
          ZYVEN_VERSION_CODE: ${{ github.run_number }}
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

      - name: Prepare the signing key
        env:
          KEYSTORE_B64: ${{ secrets.ZYVEN_KEYSTORE_BASE64 }}
          KEYSTORE_PASSWORD: ${{ secrets.ZYVEN_KEYSTORE_PASSWORD }}
        run: |
          KS="$RUNNER_TEMP/zyven-release.jks"
          if [ -n "$KEYSTORE_B64" ] && [ -n "$KEYSTORE_PASSWORD" ]; then
            echo "$KEYSTORE_B64" | base64 -d > "$KS"
            PW="$KEYSTORE_PASSWORD"
            echo "Using your permanent ZYVEN signing key."
          else
            PW=$(openssl rand -hex 24)
            keytool -genkeypair -keystore "$KS" -storetype PKCS12 -storepass "$PW" -keypass "$PW" -alias zyven \
              -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=ZYVEN" > /dev/null
            echo "::warning title=Temporary signing key::The ZYVEN_KEYSTORE_BASE64 / ZYVEN_KEYSTORE_PASSWORD secrets are not set, so this APK is signed with a one-time key. It installs fine, but the next build can't update it in place (uninstall first). See README → Permanent signing key."
          fi
          echo "::add-mask::$PW"
          echo "ZYVEN_KEYSTORE=$KS" >> "$GITHUB_ENV"
          echo "ZYVEN_KEYSTORE_PASSWORD=$PW" >> "$GITHUB_ENV"
          echo "ZYVEN_KEY_ALIAS=zyven" >> "$GITHUB_ENV"

      - name: Build the release APK
        working-directory: android
        run: |
          chmod +x gradlew
          ./gradlew assembleRelease --no-daemon --stacktrace

      - name: Check the APK and name it ZYVEN.apk
        run: |
          APK=android/app/build/outputs/apk/release/app-release.apk
          if [ ! -f "$APK" ]; then
            echo "::error::The signed release APK was not created at $APK"
            ls -R android/app/build/outputs/apk || true
            exit 1
          fi
          cp "$APK" ZYVEN.apk
          BT=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -n 1)
          "$BT/apksigner" verify --print-certs ZYVEN.apk | head -n 3
          "$BT/aapt" dump badging ZYVEN.apk | tee badging.txt | head -n 3
          grep -q "package: name='com.zyven.messaging'" badging.txt || { echo "::error::Wrong app ID in the APK"; exit 1; }
          grep -q "application-label:'ZYVEN'" badging.txt || { echo "::error::App name in the APK is not ZYVEN"; exit 1; }
          if grep -q "application-debuggable" badging.txt; then echo "::error::The APK is still a debug build"; exit 1; fi
          rm -f "$ZYVEN_KEYSTORE"
          ls -lh ZYVEN.apk
          echo "### ZYVEN.apk (release, version 1.0.${{ github.run_number }}) built ($(du -h ZYVEN.apk | cut -f1))" >> "$GITHUB_STEP_SUMMARY"

      - name: Upload ZYVEN.apk
        uses: actions/upload-artifact@v5
        with:
          name: ZYVEN-apk
          path: ZYVEN.apk
          if-no-files-found: error
          retention-days: 30

      - name: Publish ZYVEN.apk as a direct download link
        if: github.ref == 'refs/heads/main'
        env:
          GH_TOKEN: ${{ github.token }}
          GH_REPO: ${{ github.repository }}
        run: |
          gh release delete latest --yes --cleanup-tag || true
          gh release create latest ZYVEN.apk \
            --target "${{ github.sha }}" \
            --title "ZYVEN 1.0.${{ github.run_number }}" \
            --notes "Tap ZYVEN.apk below to download, then open it on your Android phone to install." \
            --latest
          echo "Direct download: https://github.com/${{ github.repository }}/releases/latest/download/ZYVEN.apk" >> "$GITHUB_STEP_SUMMARY"
```

## If a build fails

Open the failed run, click the job, and expand the step with the red ❌.
Most problems are a missing file or a mistyped secret name. Click **Re-run
jobs → Re-run all jobs** to try again.

---

## Permanent signing key

`ZYVEN.apk` is a **release** build, signed with a key. With a permanent key,
every new build installs as an **update** over the old one (no uninstalling).

Add two repository secrets (**Settings → Secrets and variables → Actions →
New repository secret**): `ZYVEN_KEYSTORE_PASSWORD` and
`ZYVEN_KEYSTORE_BASE64`, using the values from your private
`ZYVEN-signing-key.txt` file. Keep that file safe and never upload it to the
repository: anyone with it could sign apps as ZYVEN.

Without these secrets the build still works, but each APK gets a one-time key,
so you must uninstall the old app before installing a new one.

## Limitations

- **Not on Google Play yet:** the APK installs directly on Android. Publishing
  on the Play Store also needs an `.aab` bundle and a Play Console account.
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
| `.github/workflows/build-android.yml` | Builds the signed release APK and publishes the download link |
| `.github/workflows/test-backend.yml` | Runs the tests on a temporary Supabase server |
| `zyven.config.json` | The server’s public address and anon key (safe to publish) |
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
