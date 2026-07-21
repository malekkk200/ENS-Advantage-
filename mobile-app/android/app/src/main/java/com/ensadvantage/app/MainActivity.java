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
  }
}
