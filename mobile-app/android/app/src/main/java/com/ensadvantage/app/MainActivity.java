package com.ensadvantage.app;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

/**
 * ENS ADVANTAGE — screenshot / screen-recording block
 * ─────────────────────────────────────────────────────────────
 * WindowManager.LayoutParams.FLAG_SECURE is a real OS-level flag
 * (this is genuinely enforced by Android, not just app-level theater):
 *   - Screenshots of this window come back black / fail entirely
 *   - Screen recording (and screen-sharing over video calls) shows
 *     black instead of app content
 *   - The app's thumbnail in the Recent Apps switcher is hidden
 *     (shown as a blank/generic card instead of a content preview)
 *
 * This is set on the whole Activity, so it covers every screen the
 * WebView renders — login, lessons, PDFs, everything — not just the
 * PDF viewer. There is no equivalent guarantee on iOS; Apple provides
 * no API to block screenshots, only to detect one after the fact.
 */
public class MainActivity extends BridgeActivity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    getWindow().setFlags(
      WindowManager.LayoutParams.FLAG_SECURE,
      WindowManager.LayoutParams.FLAG_SECURE
    );
    super.onCreate(savedInstanceState);

    // ── Lock text size to the app's own CSS, ignore system font scale ──
    // By default Capacitor's WebView multiplies every rem/em value by
    // whatever the phone's system "font size" accessibility setting is
    // (via WebView's textZoom, which mirrors system font scale unless
    // told otherwise). That's why text looked bigger on some phones and
    // not others — it tracked each phone's own font-size setting, not a
    // real screen-density difference. Locking textZoom to 100 makes the
    // app render fonts at exactly the size specified in CSS on every
    // device, matching the -webkit-text-size-adjust:100% rule already
    // set in css/app-mode.css.
    if (this.bridge != null && this.bridge.getWebView() != null) {
      this.bridge.getWebView().getSettings().setTextZoom(100);
    }
  }
}
