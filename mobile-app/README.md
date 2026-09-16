# ENS Advantage — Native Apps (Android + iOS + Windows/macOS)

Native wrappers around the same web app (Capacitor + Electron). Not a
separate copy: all four platforms load the exact same bundled
`www/` — one Capacitor project, one shared UI/logic layer, wrapped
four ways (web, Android, iOS, Windows/macOS). `capacitor.config.json`
has no `server.url` — the site is bundled into each app at build time
(via `npx cap sync <platform>`), not loaded live over the network, so
each app works fully offline and isn't affected by the live website
being temporarily down. Same Supabase backend, same login, same
uploads either way — updating the bundled UI/logic across all
platforms just means bumping `www/` and re-syncing each one.

## What these add beyond the PWA

The PWA (installable from the website itself) can't block or detect
screenshots on any platform — browsers give web pages no such API.
These native builds can, but very differently on each platform:

### Android — real blocking
`MainActivity.java` sets `WindowManager.LayoutParams.FLAG_SECURE`.
This is enforced by Android itself, not app-level trickery:
- Screenshots come back black / fail
- Screen recording and screen-sharing show black instead of content
- The app's card in the Recent Apps switcher is hidden (blank instead
  of a content thumbnail)

### iOS — recording can be blacked out; a single screenshot cannot be blocked, only reported
Apple gives no API to prevent a screenshot — none exists, for any app,
on any iOS version. `SecureViewController.swift` does the best
available two things:
- **Screen recording**: `UIScreen.isCaptured` fires the instant
  recording/AirPlay-mirroring starts. We cover the WebView with solid
  black for as long as it's true. This part is real and works like
  the Android case.
- **A single screenshot**: `userDidTakeScreenshotNotification` fires
  only *after* iOS has already saved the image to Photos — there is no
  way to intercept it earlier, by anyone, ever. We can't blank the
  image. What we do instead: immediately call back into the web app
  (`window.__ensReportSecurityEvent`, wired to `js/nativeBridge.js` →
  the `log-screenshot-event` Edge Function → the `security_logs`
  table), tagging the event to that student's account, and show a
  brief on-screen notice. This doesn't prevent anything — it's the
  record that makes manual account review/termination possible after
  a leak, which is the actual enforcement lever for a subscription
  platform (see the conversation this was designed around: screenshots
  can never be fully blocked on any platform by physically
  photographing the screen with a second device — the realistic goal
  is raising the cost of leaking, not making it impossible).

### Windows / macOS — no screenshot/recording blocking, and secure storage is weaker than on mobile
Electron has no OS-level equivalent to Android's `FLAG_SECURE` or
iOS's `UIScreen.isCaptured` — this build does **not** block or detect
screenshots/recording on desktop. Also worth knowing: this project's
secure-storage plugin (`@aparajita/capacitor-secure-storage`, used by
`js/secureStorage.js`) has no dedicated Electron implementation, so it
falls back to its web implementation — which works (backed by
`localStorage`, not a stub), but that means data saved through it on
desktop is **not** OS-keychain-encrypted the way it is on Android/iOS,
just stored like any other web app's local storage.

## Why some of this still needs you

Android's signed `.apk`/`.aab` are built automatically by
`.github/workflows/build-android.yml` on every push — nothing to run
locally for that one. iOS's `.ipa` and a real macOS `.dmg`/Windows
`.exe` are different: they need Apple/Windows code-signing
credentials that only you can provide (an Apple Developer Program
membership + certificate for iOS/macOS notarization, and a code-signing
certificate for Windows to avoid a SmartScreen warning) — nothing in
this sandbox can substitute for those. What's already done and
verified without them:
- **iOS**: the Xcode project (`ios/App/`), `FLAG_SECURE`-equivalent
  Swift code, launcher icons/splash — all committed. No CI workflow
  for it yet (unlike Android) — ask if you want `build-ios.yml` added
  once you have Apple credentials to put in GitHub Secrets.
- **Windows/macOS**: the Electron project (`electron/`) is scaffolded,
  configured, and its packaging pipeline was verified end-to-end in
  this sandbox (icon conversion, asset bundling, `.asar` packing all
  confirmed working) — just not the final `.exe`/`.dmg` step itself,
  since that specifically needs a Windows or macOS machine
  (`.github/workflows/build-desktop.yml` does that on GitHub's own
  Windows/macOS runners on every push). Unsigned by default: both
  installers will work, but Windows will show a SmartScreen "unknown
  publisher" warning and macOS will refuse to open the app until the
  user right-clicks → Open once, unless you add signing secrets (see
  that workflow file for exactly which ones).

## Building it yourself

### Android
1. Install [Android Studio](https://developer.android.com/studio) (includes the SDK).
2. ```bash
   cd mobile-app
   npm install
   npx cap sync android
   npx cap open android
   ```
3. Android Studio opens the `android/` project. To test: **Run ▶**.
4. To produce a real installable build: **Build → Generate Signed Bundle / APK**.
   - **Android App Bundle (.aab)** for Google Play (required format).
   - **APK** to sideload directly for now.
   - Back up the signing keystore somewhere safe outside git — losing it means you can never publish an update to the same Play listing again.

### iOS
1. You need a Mac with [Xcode](https://apps.apple.com/app/xcode/id497799835) installed, and a paid [Apple Developer Program](https://developer.apple.com/programs/) membership ($99/year — required even for personal device testing beyond 7 days).
2. ```bash
   cd mobile-app
   npm install
   npx cap sync ios
   npx cap open ios
   ```
3. Xcode opens `ios/App/App.xcworkspace`. First build: set your Team under **Signing & Capabilities**.
4. To test on a real iPhone: plug it in, select it as the run target, **Run ▶**. (Simulators can't test screenshot/recording detection meaningfully — use a real device.)
5. To publish: **Product → Archive**, then **Distribute App** through Xcode Organizer to TestFlight or the App Store.

### Windows / macOS (Electron)
The normal path is CI, not local — `.github/workflows/build-desktop.yml`
builds both on every push to `mobile-app/**` and uploads the installer
as a downloadable workflow artifact (Actions tab → the run → Artifacts).
Local build, if you want one:
1. ```bash
   cd mobile-app
   npm install          # also installs electron/'s own deps via postinstall
   npx cap sync @capawesome/capacitor-electron
   cd electron
   npm run pack          # tsc -> vendor plugins -> electron-builder
   ```
2. Output lands in `electron/dist/` — an `.exe` (Windows) or `.dmg`
   (macOS), whichever OS you ran this on. electron-builder cross-builds
   Windows from Linux/macOS via Wine, but **not** macOS `.dmg` from
   anything other than real macOS — Apple's tooling for that
   (`hdiutil`) only exists on macOS itself.
3. To sign (removes the SmartScreen/Gatekeeper warnings): set the
   environment variables electron-builder looks for before step 1
   (`CSC_LINK`/`CSC_KEY_PASSWORD` for both; macOS notarization also
   needs `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`) — or
   add the same as GitHub Secrets for the CI workflow to pick up
   automatically. Full reference: https://www.electron.build/code-signing

## Publishing

- **Google Play**: one-time $25 registration at https://play.google.com/console/signup, upload the signed `.aab`.
- **App Store**: $99/year Apple Developer membership, submit the archive via App Store Connect. Review typically takes 1–3 days.

## Regenerating icons/splash screens (all platforms)

If the logo changes:
```bash
cp /path/to/new-logo.png assets/icon.png
npx capacitor-assets generate \
  --iconBackgroundColor '#ffffff' --iconBackgroundColorDark '#0f1f3d' \
  --splashBackgroundColor '#ffffff' --splashBackgroundColorDark '#0f1f3d'
```
(omit `--android`/`--ios` to regenerate both at once)

`capacitor-assets` doesn't cover Electron. For Windows/macOS, copy the
same source icon into the electron project — a single 1024x1024 PNG is
all electron-builder needs; it converts it to `.icns`/`.ico` itself at
package time:
```bash
cp assets/icon.png electron/assets/icon.png
```

## Files that matter here

- `capacitor.config.json` — shared config (appId/appName/webDir) for all four platform projects below
- `android/app/src/main/java/com/ensadvantage/app/MainActivity.java` — `FLAG_SECURE`
- `ios/App/App/SecureViewController.swift` — recording black-out + screenshot reporting
- `ios/App/App/Base.lproj/Main.storyboard` — wired to use `SecureViewController`
- `android/app/src/main/res/mipmap-*/`, `ios/App/App/Assets.xcassets/` — icons/splash (generated from your logo)
- `electron/capacitor.electron.config.ts` — window size, splash screen, per-plugin overrides
- `electron/electron-builder.config.js` — packaging: targets (nsis/dmg), app category, icon/asset bundling
- `electron/assets/icon.png` — source icon for Windows/macOS (copied from `assets/icon.png`; see regeneration note above)
- `.github/workflows/build-desktop.yml` — builds the Windows/macOS installers on GitHub's runners
- Website-side pieces this depends on: `js/nativeBridge.js` (receives the native call) and `supabase/functions/log-screenshot-event/` (logs it) — both already deployed with the website, not something you need to do anything about here.

