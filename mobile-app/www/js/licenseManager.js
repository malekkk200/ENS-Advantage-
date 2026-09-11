/* ═══════════════════════════════════════════════════════════════
   OFFLINE ACCESS RECORDS
   ───────────────────────────────────────────────────────────────
   Tracks which materials have been downloaded/cached on this device,
   independent of the encryption in materialCache.js. A record here
   is NOT a time-limited license any more — once a material is
   confirmed cached, it stays available offline indefinitely. That's
   a deliberate, explicitly requested product decision: downloaded
   lessons should behave like a real download, not something that
   quietly expires if the student doesn't reconnect often enough.

   ── What this file used to do, and why that changed ──
   An earlier version enforced a rolling 36-hour TTL — every cached
   material had to be re-confirmed with the server (via
   get-material-url, reused as an implicit renewal check) at least
   that often, or offline access to it stopped, even though the
   encrypted bytes were still sitting on the device. That gave a
   lapsed subscription a real, timely revocation path for offline
   content. It also meant a student who genuinely couldn't reconnect
   for more than ~30 hours (a multi-day trip, exam period, etc.) lost
   access to lessons they'd legitimately downloaded — which is the
   specific behavior this rewrite removes.

   ── What actually still invalidates a cached copy now ──
   1. The admin replaces a material's file. course_materials.updated_at
      is bumped by a DB trigger on every update to that row (including
      a plain file swap), so it's a reliable, server-enforced "this
      changed" signal — see contentChanged() below. The next time this
      device has synced course_materials (i.e. has been online at some
      point — doesn't need to be online at the exact moment the lesson
      is reopened), a version mismatch is caught and the stale cached
      copy is evicted, forcing a fresh download of the new version.
      This is the ordinary, expected way a lesson's local copy ever
      goes away on its own now.
   2. A confirmed 403 from get-material-url — the server actively
      denying access, not merely being unreachable — still evicts the
      local copy immediately (see pdfViewer.js). This remains the one
      path by which an actual subscription lapse can revoke an
      already-downloaded lesson, and only fires when the device is
      online and the server explicitly says no.

   Explicitly NOT a goal any more: guaranteeing offline access tracks
   subscription status in anything close to real time for a device
   that stays offline. A student whose subscription lapses and who
   then never reconnects keeps whatever they'd already downloaded,
   permanently. That trade-off — offline reliability over timely
   subscription-lapse enforcement — is intentional, not an oversight;
   reintroducing a TTL (see git history for the previous version of
   this file) is the natural way to walk it back if that's ever
   needed again.

   Storage: plain localStorage JSON, NOT the encrypted cache. Nothing
   here is secret — a record just says "this material ID was
   downloaded, and here's the content-version it was downloaded at."
   The actual content stays protected by materialCache.js's
   encryption; this module only decides whether that decryption is
   even attempted, and whether it's for the current version of the
   file.
═══════════════════════════════════════════════════════════════ */
import { MaterialCache } from './materialCache.js';

const STORAGE_KEY = 'ensOfflineLicenses'; // kept as-is (not renamed) so existing on-device records survive this update rather than being silently wiped; shape is now { [materialId]: { downloadedAt, contentVersion, storagePath, title } }

function _load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return (raw && typeof raw === 'object') ? raw : {};
  } catch { return {}; }
}

function _save(map) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch (_) {} // private-browsing/quota — non-fatal, records just won't persist across reloads
}

export const LicenseManager = {
  /** True if this material has a download record at all — no time component any more, see file header. The gate MaterialCache.read() is consulted through before decrypting anything offline. */
  isValid(materialId) {
    return this.hasRecord(materialId);
  },

  /**
   * True if a download record exists for this material. Kept as a
   * separate name from isValid() for the callers that specifically
   * care about "was this ever cached before this tracking existed"
   * (grandfathering pre-existing cache entries) vs. a general
   * permission check — the two happen to be the exact same test now
   * that there's no time dimension, but the distinct names keep call
   * sites' intent readable.
   */
  hasRecord(materialId) {
    return !!_load()[materialId];
  },

  /**
   * True only when we have BOTH a recorded content-version (from when
   * this material was downloaded) and a current one (from the
   * caller's live or offline-synced course_materials data) AND they
   * differ — i.e. only when the admin has genuinely replaced this
   * file since it was cached. If either side is unknown, this never
   * forces a re-download over a mere absence of information (e.g. a
   * cold offline launch before course_materials has ever synced on
   * this device, or an on-device record saved before this
   * version-tracking existed).
   */
  contentChanged(materialId, currentContentVersion) {
    const rec = _load()[materialId];
    if (!rec?.contentVersion || !currentContentVersion) return false;
    return rec.contentVersion !== currentContentVersion;
  },

  /**
   * Records a material as downloaded/cached — call any time
   * MaterialCache.write() succeeds for it (a fresh network open, or
   * the explicit "Download for offline" button). contentVersion
   * should be the material's current course_materials.updated_at
   * whenever the caller has it (pass undefined/null if not — this
   * preserves whatever version was recorded before, rather than
   * blanking it out).
   */
  issue(materialId, storagePath, title, contentVersion) {
    if (!materialId) return;
    const map = _load();
    map[materialId] = {
      downloadedAt:   map[materialId]?.downloadedAt ?? Date.now(),
      contentVersion: contentVersion ?? map[materialId]?.contentVersion ?? null,
      storagePath:    storagePath || map[materialId]?.storagePath || '',
      title:          title || map[materialId]?.title || ''
    };
    _save(map);
  },

  /** Revokes a download record immediately — call on a confirmed 403 (access actually denied), a detected content-version change (the cached file is for a superseded version), or a record found to be stale (bytes missing despite a record claiming otherwise). Never on a mere offline/network failure. */
  async revoke(materialId) {
    const map = _load();
    if (map[materialId]) {
      delete map[materialId];
      _save(map);
    }
    await MaterialCache.evict(materialId);
  },

  /** Wipes every download record — call on logout, alongside MaterialCache.clear(). */
  clear() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  }
};
