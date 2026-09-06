import Foundation
import UIKit
import Capacitor

/**
 * ═══════════════════════════════════════════════════════════════
 * DEVICE INTEGRITY (iOS) — jailbreak / tamper detection
 * ───────────────────────────────────────────────────────────────
 * Local Capacitor plugin using the modern (Capacitor 3+) pure-Swift
 * `CAPBridgedPlugin` protocol — no separate Objective-C bridge (.m)
 * file needed, unlike older Capacitor plugin templates. Registered
 * from SecureViewController.capacitorDidLoad() (see that file) since
 * a locally-bundled plugin like this one isn't auto-discovered the
 * way an npm-installed plugin's podspec is.
 *
 * Exposes isCompromised() to JS as
 * `window.Capacitor.Plugins.DeviceIntegrity.isCompromised()`,
 * consumed by js/deviceIntegrity.js — that file already falls back
 * to a much weaker JS-only heuristic if this plugin call ever fails
 * or isn't present, so nothing breaks if this file isn't wired up
 * yet on a given build.
 *
 * WHAT THIS CHECKS — the same standard, widely-documented jailbreak
 * heuristics used by mainstream detection libraries (IOSSecuritySuite,
 * DTTJailbreakDetection, etc.):
 *   - Well-known jailbreak file paths (Cydia, Substrate, common
 *     jailbreak-tool binaries)
 *   - Ability to write outside the app's sandbox (only possible with
 *     jailbreak-granted elevated filesystem permissions)
 *   - The `cydia://` URL scheme being openable (requires the
 *     `LSApplicationQueriesSchemes` entry added to Info.plist
 *     alongside this file)
 *   - A debugger currently attached, via the classic sysctl
 *     P_TRACED flag check
 *
 * Same conservative threshold as the Android plugin and the JS
 * fallback tier: isCompromised() only returns true once at least 2
 * independent signals agree, so no single ambiguous signal (some
 * enterprise MDM configurations, some legitimate low-level dev/debug
 * sessions) locks out a real student by itself.
 *
 * HONEST LIMIT, stated once here: every one of these checks is
 * defeatable by modern jailbreak-hiding tools (Shadow, A-Bypass,
 * etc.) or a repackaged IPA with this very check patched out. This
 * raises the cost of casual tampering — it is real OS-level
 * evidence, not a spoofable JS variable — but it is not, and cannot
 * be marketed as, an unbreakable barrier. Apple's DeviceCheck / App
 * Attest APIs are the actual state of the art here and would be a
 * stronger foundation if server-side hardware attestation is ever
 * worth the added complexity — deliberately out of scope here to
 * keep this addable without any new server component.
 *
 * ⚠️ BUILD/TEST CAVEAT: written to the correct, standard Capacitor 7
 * CAPBridgedPlugin shape, but not compiled or run — this environment
 * has no Xcode/simulator/device to verify against, and (see the repo
 * note handed back alongside this file) this .swift file still needs
 * to be added to the Xcode project itself, since raw file drops don't
 * register with Xcode's project.pbxproj automatically. Test on at
 * least one real non-jailbroken device before shipping any build that
 * GATES functionality on isCompromised() (see materialCache.js) — a
 * false positive here silently costs a paying student their offline
 * access, which is a much worse failure mode than under-detecting.
 * ═══════════════════════════════════════════════════════════════
 */
@objc(DeviceIntegrityPlugin)
public class DeviceIntegrityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DeviceIntegrityPlugin"
    public let jsName = "DeviceIntegrity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isCompromised", returnType: CAPPluginReturnPromise)
    ]

    private static let jailbreakPaths = [
        "/Applications/Cydia.app",
        "/Applications/Sileo.app",
        "/Applications/Zebra.app",
        "/Library/MobileSubstrate/MobileSubstrate.dylib",
        "/Library/MobileSubstrate/DynamicLibraries",
        "/bin/bash",
        "/usr/sbin/sshd",
        "/etc/apt",
        "/private/var/lib/apt",
        "/private/var/lib/cydia",
        "/private/var/stash",
        "/var/checkra1n.dmg",
        "/usr/libexec/cydia/firmware.sh"
    ]

    @objc func isCompromised(_ call: CAPPluginCall) {
        var signals: [String] = []

        if Self.checkJailbreakFiles()   { signals.append("jailbreak_file_present") }
        if Self.checkSandboxEscape()    { signals.append("sandbox_write_succeeded") }
        if Self.checkCydiaUrlScheme()   { signals.append("cydia_url_scheme_openable") }
        if Self.checkDebuggerAttached() { signals.append("debugger_attached") }
        if Self.checkSimulator()        { signals.append("simulator_detected") }

        // Conservative threshold — see file header.
        let compromised = signals.count >= 2

        call.resolve([
            "rooted": compromised,
            "signals": signals
        ])
    }

    private static func checkJailbreakFiles() -> Bool {
        let fm = FileManager.default
        return jailbreakPaths.contains { fm.fileExists(atPath: $0) }
    }

    private static func checkSandboxEscape() -> Bool {
        // A non-jailbroken app's sandbox forbids writing outside its
        // own container — only jailbreak-granted elevated filesystem
        // access lets this succeed.
        let testPath = "/private/ens_integrity_check_\(UUID().uuidString).txt"
        do {
            try "test".write(toFile: testPath, atomically: true, encoding: .utf8)
            try? FileManager.default.removeItem(atPath: testPath) // clean up regardless of what caused the write to succeed
            return true
        } catch {
            return false // expected outcome on a normal, non-jailbroken device
        }
    }

    private static func checkCydiaUrlScheme() -> Bool {
        // Requires "cydia" listed under LSApplicationQueriesSchemes in
        // Info.plist (added alongside this file) — without it,
        // canOpenURL always returns false regardless of whether Cydia
        // is actually installed, which would make this check useless
        // rather than merely conservative.
        guard let url = URL(string: "cydia://package/com.example.package") else { return false }
        var result = false
        if Thread.isMainThread {
            result = UIApplicationBridge.canOpen(url)
        } else {
            DispatchQueue.main.sync { result = UIApplicationBridge.canOpen(url) }
        }
        return result
    }

    private static func checkDebuggerAttached() -> Bool {
        // Classic sysctl-based debugger check: ask the kernel for this
        // process's own info and inspect the P_TRACED flag, the same
        // technique Apple's own sample code and every mainstream
        // anti-debug library on iOS uses.
        var info = kinfo_proc()
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        var size = MemoryLayout<kinfo_proc>.stride
        let result = sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0)
        guard result == 0 else { return false }
        return (info.kp_proc.p_flag & P_TRACED) != 0
    }

    private static func checkSimulator() -> Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return false
        #endif
    }
}

/// Tiny indirection so canOpenURL (a UIApplication instance method,
/// which must be called on the main thread) has a single, clearly-
/// named call site above rather than reaching into UIApplication.shared
/// inline in two branches.
private enum UIApplicationBridge {
    static func canOpen(_ url: URL) -> Bool {
        UIApplication.shared.canOpenURL(url)
    }
}
