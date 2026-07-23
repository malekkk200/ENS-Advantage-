# ENS Advantage — Mobile Apps (Android + iOS)

Native wrappers around the live website (Capacitor). Neither is a
separate copy of the app — `capacitor.config.json` points the WebView
straight at `https://ens-advantage.vercel.app`, so whatever is live on
the website is instantly what's in both apps. Same Supabase backend,
same login, same uploads, same everything. There is nothing to "keep
in sync" — there's only one app, wrapped three ways (web, Android, iOS).

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

## Why I couldn't finish this for you end-to-end

Building and signing the actual installable Android `.apk`/`.aab` or
iOS `.ipa` requires platform SDKs (Android Studio/Gradle, or Xcode on
an actual Mac) and network access to Google's/Apple's servers — none
of which are available in the sandboxed environment I'm running in (it
only allows npm/GitHub/PyPI domains, and iOS builds specifically are
an Apple restriction: Xcode only runs on macOS, full stop, regardless
of environment). Everything up to that point is done and committed:
the Capacitor projects for both platforms, `FLAG_SECURE`, the
screenshot/recording Swift code, all launcher icons and splash screens
generated from your logo. The build step needs to happen on your
machine (Android: any OS with Android Studio; iOS: a Mac with Xcode).

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

## Publishing

- **Google Play**: one-time $25 registration at https://play.google.com/console/signup, upload the signed `.aab`.
- **App Store**: $99/year Apple Developer membership, submit the archive via App Store Connect. Review typically takes 1–3 days.

## Regenerating icons/splash screens (both platforms)

If the logo changes:
```bash
cp /path/to/new-logo.png assets/icon.png
npx capacitor-assets generate \
  --iconBackgroundColor '#ffffff' --iconBackgroundColorDark '#0f1f3d' \
  --splashBackgroundColor '#ffffff' --splashBackgroundColorDark '#0f1f3d'
```
(omit `--android`/`--ios` to regenerate both at once)

## Files that matter here

- `capacitor.config.json` — points both apps at the live site
- `android/app/src/main/java/com/ensadvantage/app/MainActivity.java` — `FLAG_SECURE`
- `ios/App/App/SecureViewController.swift` — recording black-out + screenshot reporting
- `ios/App/App/Base.lproj/Main.storyboard` — wired to use `SecureViewController`
- `android/app/src/main/res/mipmap-*/`, `ios/App/App/Assets.xcassets/` — icons/splash (generated from your logo)
- Website-side pieces this depends on: `js/nativeBridge.js` (receives the native call) and `supabase/functions/log-screenshot-event/` (logs it) — both already deployed with the website, not something you need to do anything about here.

