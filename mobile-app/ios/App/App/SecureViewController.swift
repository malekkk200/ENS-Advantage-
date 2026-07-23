import UIKit
import Capacitor

/**
 * ENS ADVANTAGE — screenshot / screen-recording response
 * ─────────────────────────────────────────────────────────────
 * READ THIS FIRST — what this file can and cannot actually do:
 *
 * 1. SCREEN RECORDING (UIScreen.isCaptured) — this genuinely works.
 *    iOS tells the app the instant screen recording (or AirPlay/
 *    external mirroring) starts, via `capturedDidChangeNotification`.
 *    We use that to cover the WebView with a solid black view while
 *    `isCaptured` is true, so the recording itself is just black.
 *
 * 2. A SINGLE SCREENSHOT (power+volume, or the little onscreen
 *    shortcut) — this CANNOT be blocked, by this code or by any code
 *    on iOS. Apple's `userDidTakeScreenshotNotification` fires only
 *    AFTER the OS has already captured and saved the image to Photos.
 *    There is no earlier hook. What we do here is the best available
 *    response: immediately report the event to the backend (so it's
 *    tied to that student's account for manual review/enforcement)
 *    and show a brief on-screen notice. The screenshot itself, sitting
 *    in the user's Photos app, will still show the real content.
 *    Don't expect this to look or behave like the recording case.
 */
class SecureViewController: CAPBridgeViewController {

  private var blackoutView: UIView?

  override func viewDidLoad() {
    super.viewDidLoad()

    NotificationCenter.default.addObserver(
      self, selector: #selector(handleScreenCaptureChange),
      name: UIScreen.capturedDidChangeNotification, object: nil
    )
    NotificationCenter.default.addObserver(
      self, selector: #selector(handleScreenshot),
      name: UIApplication.userDidTakeScreenshotNotification, object: nil
    )

    // Catch the case where recording was already active before this
    // screen loaded (e.g. resuming the app mid-recording).
    updateBlackout(isCaptured: UIScreen.main.isCaptured)
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  // MARK: - Screen recording → black

  @objc private func handleScreenCaptureChange() {
    let capturing = UIScreen.main.isCaptured
    updateBlackout(isCaptured: capturing)
    reportEvent(capturing ? "screen_recording_started" : "screen_recording_stopped")
  }

  private func updateBlackout(isCaptured: Bool) {
    if isCaptured {
      if blackoutView == nil {
        let v = UIView(frame: view.bounds)
        v.backgroundColor = .black
        v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(v)
        blackoutView = v
      }
    } else {
      blackoutView?.removeFromSuperview()
      blackoutView = nil
    }
  }

  // MARK: - Screenshot → report only (cannot block/blank it — see notes above)

  @objc private func handleScreenshot() {
    reportEvent("screenshot_taken")
    flashNotice("Screenshot detected — this has been recorded on your account.")
  }

  // MARK: - Reporting

  /// Calls the log-screenshot-event Edge Function through the already-
  /// authenticated web session running inside the WebView, so we don't
  /// need to duplicate Supabase auth/token handling natively — the
  /// JS side already knows the current session and the current
  /// lesson/material being viewed.
  private func reportEvent(_ eventType: String) {
    let js = "window.__ensReportSecurityEvent && window.__ensReportSecurityEvent('\(eventType)');"
    bridge?.webView?.evaluateJavaScript(js, completionHandler: nil)
  }

  private func flashNotice(_ text: String) {
    let label = UILabel()
    label.text = "🔒 " + text
    label.textColor = .white
    label.backgroundColor = UIColor(red: 0.86, green: 0.15, blue: 0.15, alpha: 0.95) // matches --red
    label.font = .boldSystemFont(ofSize: 13)
    label.textAlignment = .center
    label.numberOfLines = 2
    label.layer.cornerRadius = 10
    label.clipsToBounds = true
    label.alpha = 0
    label.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(label)

    NSLayoutConstraint.activate([
      label.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
      label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 16),
      label.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -16),
      label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      label.heightAnchor.constraint(greaterThanOrEqualToConstant: 40),
    ])
    label.setContentHuggingPriority(.defaultLow, for: .horizontal)
    label.numberOfLines = 0
    label.setContentCompressionResistancePriority(.required, for: .vertical)
    label.layoutMargins = UIEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)

    UIView.animate(withDuration: 0.25, animations: { label.alpha = 1 }) { _ in
      UIView.animate(withDuration: 0.3, delay: 4.0, options: [], animations: {
        label.alpha = 0
      }) { _ in
        label.removeFromSuperview()
      }
    }
  }
}
