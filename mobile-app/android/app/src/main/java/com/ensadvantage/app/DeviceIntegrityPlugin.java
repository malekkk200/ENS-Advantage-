package com.ensadvantage.app;

import android.app.ActivityManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Debug;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * ═══════════════════════════════════════════════════════════════
 * DEVICE INTEGRITY (Android) — root / tamper detection
 * ───────────────────────────────────────────────────────────────
 * Registered as a LOCAL Capacitor plugin — no separate Gradle
 * module, no npm package, nothing to sync — just this one class,
 * annotated with @CapacitorPlugin and registered by name from
 * MainActivity.onCreate() (see the registerPlugin() call added
 * there). This is the standard, documented way to add a small
 * custom native plugin to a Capacitor app without ejecting or
 * publishing a package.
 *
 * Exposes isCompromised() to JS as
 * `window.Capacitor.Plugins.DeviceIntegrity.isCompromised()`,
 * consumed by js/deviceIntegrity.js — that file already falls back
 * to a much weaker JS-only heuristic if this plugin call ever fails
 * or isn't present, so nothing breaks if this file isn't wired up
 * yet on a given build.
 *
 * WHAT THIS ACTUALLY CHECKS: standard, widely-used, well-documented
 * heuristics — no single one of them is proof of root by itself
 * (custom ROMs and some legitimate OEM builds can trip one or two),
 * which is why isCompromised() only returns true once at least 2
 * independent signals agree, exactly mirroring the conservative
 * threshold already used by the JS-only fallback tier.
 *
 * HONEST LIMIT, stated once here: these are the same categories of
 * check every mainstream root-detection library (RootBeer, SafetyNet
 * predecessors, etc.) uses, and every one of them is defeatable by a
 * sufficiently motivated attacker — Magisk's DenyList/Zygisk hiding,
 * a repackaged build with this very check patched out, or a modified
 * ROM that never trips any of these paths at all. This raises the
 * cost of casual tampering meaningfully (it is real OS-level
 * evidence, not a spoofable JS variable); it is not, and cannot be
 * marketed as, an unbreakable barrier. Google's own attestation API
 * (Play Integrity) is the actual state of the art for this and would
 * be a stronger foundation than this file if hardware-backed
 * attestation is ever worth the added Play Services dependency and
 * server-side verification — deliberately out of scope here to keep
 * this addable without any new server component or SDK.
 *
 * ⚠️ BUILD/TEST CAVEAT: this file was written to the correct,
 * standard Capacitor 7 local-plugin shape, but has not been compiled
 * or run — this environment has no Android SDK/emulator/device to
 * verify against. Before shipping any build that GATES functionality
 * on isCompromised() (see materialCache.js), test on at least one
 * real non-rooted device to confirm it reports `rooted: false` and
 * doesn't false-positive — a false positive here silently costs a
 * paying student their offline access, which is a much worse failure
 * mode than under-detecting.
 * ═══════════════════════════════════════════════════════════════
 */
@CapacitorPlugin(name = "DeviceIntegrity")
public class DeviceIntegrityPlugin extends Plugin {

  // Common su binary locations across mainstream root solutions
  // (Magisk, SuperSU, older su-based root methods).
  private static final String[] SU_PATHS = {
    "/system/bin/su",
    "/system/xbin/su",
    "/sbin/su",
    "/system/su",
    "/su/bin/su",
    "/system/bin/.ext/.su",
    "/system/usr/we-need-root/su-backup",
    "/data/local/xbin/su",
    "/data/local/bin/su",
    "/data/local/su",
    "/cache/su",
    "/vendor/bin/su"
  };

  // Packages installed by mainstream root-management / root-hiding tools.
  private static final String[] ROOT_PACKAGES = {
    "com.topjohnwu.magisk",
    "eu.chainfire.supersu",
    "com.noshufou.android.su",
    "com.koushikdutta.superuser",
    "com.thirdparty.superuser",
    "com.yellowes.su",
    "com.zachspong.temprootremovejb",
    "com.ramdroid.appquarantine"
  };

  @PluginMethod
  public void isCompromised(PluginCall call) {
    JSArray signals = new JSArray();

    if (checkSuBinaries())         signals.put("su_binary_present");
    if (checkRootPackages())       signals.put("root_management_app_installed");
    if (checkTestKeysBuildTag())   signals.put("test_keys_build_tag");
    if (checkDebuggerAttached())   signals.put("debugger_attached");
    if (checkEmulator())           signals.put("emulator_detected");

    // Conservative threshold, matching js/deviceIntegrity.js's JS-only
    // tier: a single weak/ambiguous signal (e.g. test-keys on some
    // legitimate OEM/custom-ROM builds, or an emulator used by a
    // developer legitimately testing the app) never blocks a real
    // student by itself. Two or more independent signals agreeing is
    // treated as an actual finding.
    boolean rooted = signals.length() >= 2;

    JSObject result = new JSObject();
    result.put("rooted", rooted);
    result.put("signals", signals);
    call.resolve(result);
  }

  private boolean checkSuBinaries() {
    for (String path : SU_PATHS) {
      if (new File(path).exists()) return true;
    }
    return false;
  }

  private boolean checkRootPackages() {
    PackageManager pm = getContext().getPackageManager();
    for (String pkg : ROOT_PACKAGES) {
      try {
        pm.getPackageInfo(pkg, 0);
        return true; // no exception means the package is installed
      } catch (PackageManager.NameNotFoundException ignored) {
        // expected for every package NOT installed — keep checking the rest
      }
    }
    return false;
  }

  private boolean checkTestKeysBuildTag() {
    // Official, retail Android builds are signed with "release-keys".
    // "test-keys" means the build was signed with the AOSP test
    // certificate — the standard signal for a custom/dev build,
    // though a small number of legitimate custom ROMs also carry
    // this tag, which is exactly why this alone never gates anything
    // (see the >= 2 threshold above).
    String tags = Build.TAGS;
    return tags != null && tags.contains("test-keys");
  }

  private boolean checkDebuggerAttached() {
    return Debug.isDebuggerConnected() || Debug.waitingForDebugger();
  }

  private boolean checkEmulator() {
    // Standard emulator fingerprint checks — an emulator isn't
    // "rooted" in the traditional sense, but it's a device class this
    // app's offline-content protections were never meant to run
    // meaningfully on (an emulator disk image is trivially inspectable
    // regardless of what happens inside the app), so it's folded into
    // the same signal set at the same conservative threshold.
    return (Build.FINGERPRINT != null && (Build.FINGERPRINT.startsWith("generic")
              || Build.FINGERPRINT.startsWith("unknown")
              || Build.FINGERPRINT.contains("test-keys")))
        || (Build.MODEL != null && (Build.MODEL.contains("google_sdk")
              || Build.MODEL.contains("Emulator")
              || Build.MODEL.contains("Android SDK built for x86")))
        || (Build.MANUFACTURER != null && Build.MANUFACTURER.contains("Genymotion"))
        || (Build.BRAND != null && Build.BRAND.startsWith("generic") && Build.DEVICE != null && Build.DEVICE.startsWith("generic"))
        || "google_sdk".equals(Build.PRODUCT);
  }
}
