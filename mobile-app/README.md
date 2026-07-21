# ENS Advantage — Android App

A native Android wrapper around the live website (Capacitor). It is
**not** a separate copy of the app — `capacitor.config.json` points
the WebView straight at `https://ens-advantage.vercel.app`, so
whatever is live on the website is instantly what's in the app. Same
Supabase backend, same login, same uploads, same everything. There is
nothing to "keep in sync" — there's only one app, wrapped two ways.

## What this adds beyond the PWA

The PWA (installable from the website itself) can't block screenshots
on any platform — browsers give web pages no such API. This native
Android build can, using a real OS-level flag:

- **`MainActivity.java`** sets `WindowManager.LayoutParams.FLAG_SECURE`.
  This is enforced by Android itself, not app-level trickery:
  - Screenshots of the app come back black / fail
  - Screen recording and screen-sharing show black instead of content
  - The app's card in the Recent Apps switcher is hidden (blank instead
    of a content thumbnail)

**This has no iOS equivalent.** Apple provides no API to block
screenshots — only to detect one after the fact and react (e.g. blur
the screen briefly). If you build an iOS version later via Capacitor,
budget for "detect and blur," not "block."

## Why I couldn't finish this for you end-to-end

Building and signing the actual installable `.apk`/`.aab` requires the
Android SDK, Gradle, and network access to Google's Maven repository —
none of which are available in the sandboxed environment I'm running
in (it only allows npm/GitHub/PyPI domains). Everything up to that
point — the Capacitor project, `FLAG_SECURE`, all launcher icons and
splash screens generated from your logo — is done and committed. The
build step needs to happen on your machine or in CI.

## Building it yourself

1. Install [Android Studio](https://developer.android.com/studio) (includes the SDK).
2. Clone the repo, then:
   ```bash
   cd mobile-app
   npm install
   npx cap sync android
   npx cap open android
   ```
3. Android Studio opens the `android/` project. To test on a device/emulator: **Run ▶**.
4. To produce a real installable build: **Build → Generate Signed Bundle / APK**.
   - Choose **Android App Bundle (.aab)** if you're publishing to Google Play (required format).
   - Choose **APK** if you just want to sideload it directly onto a phone for now.
   - You'll need to create a signing keystore the first time — Android Studio walks you through it. **Back that keystore file up somewhere safe outside git** (a password manager or private cloud folder). If you lose it, you can never publish an update to the same Play Store listing again.

## Publishing to Google Play

- One-time $25 registration: https://play.google.com/console/signup
- Upload the signed `.aab`, fill in the store listing (your `assets/logo.jpg` already doubles as a fine icon/feature-graphic starting point), and submit for review.

## Regenerating icons/splash screens

If the logo changes, regenerate everything from the new file:
```bash
cp /path/to/new-logo.png assets/icon.png
npx capacitor-assets generate --android \
  --iconBackgroundColor '#ffffff' --iconBackgroundColorDark '#0f1f3d' \
  --splashBackgroundColor '#ffffff' --splashBackgroundColorDark '#0f1f3d'
```

## Files that matter here

- `capacitor.config.json` — points the app at the live site
- `android/app/src/main/java/com/ensadvantage/app/MainActivity.java` — `FLAG_SECURE`
- `android/app/src/main/res/mipmap-*/` — launcher icons (generated from your logo)
- `android/app/src/main/res/drawable*/splash.png` — splash screens (generated from your logo)
