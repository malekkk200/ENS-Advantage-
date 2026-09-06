/* ═══════════════════════════════════════════════════════════════
   OFFLINE LICENSE MANAGER
   ───────────────────────────────────────────────────────────────
   Adds a TTL to offline access, independent of the encryption in
   materialCache.js. Before this module, a cached file's local
   encryption key (secureKeyStore.js / secureStorage.js) worked
   forever once created — a lapsed subscription had no way to revoke
   already-cached offline content until the device came back online
   AND the student happened to reopen that exact material (the 403
   eviction check in pdfViewer.js). This module makes that revocation
   check happen on a schedule instead of only opportunistically:
   every cached material gets a license record — { issuedAt, expiresAt }
   — and MaterialCache reads are gated on it still being valid.

   This deliberately does NOT introduce a new server endpoint or a
   real "content key" issued by the server (that would be closer to
   actual DRM, e.g. Widevine/FairPlay — see the notes handed back
   alongside this file for why those don't apply to PDF distribution,
   and what would be involved if this ever needs to become genuinely
   server-issued). Instead, this reuses the *existing* get-material-url
   call as the renewal check: any time it succeeds for a given
   material, that IS the server re-confirming access is still valid,
   so it's treated as license renewal too. Any time it 403s, the
   license is revoked immediately, same as the cache eviction already
   did. Zero new server surface, zero new attack surface — the
   license is exactly as trustworthy as the access check already was.

   TTL default: 36 hours (the midpoint of the requested 24–48h
   range). A license nearing expiry is proactively renewed in the
   background (see startBackgroundRenewal) whenever the device is
   online, so a student doesn't lose access mid-session purely
   because a timer happened to lapse while they were using the app.

   Storage: plain localStorage JSON, NOT the encrypted cache. Nothing
   here is secret — a license record just says "this material ID was
   confirmed accessible until time X," the same information the
   server would tell anyone with a valid, still-subscribed session
   anyway. The actual content stays protected by materialCache.js's
   encryption; this module only decides whether that decryption is
   even attempted.
═══════════════════════════════════════════════════════════════ */
import { sb } from './supabaseClient.js';
import { State } from './state.js';
import { MaterialCache } from './materialCache.js';

const STORAGE_KEY = 'ensOfflineLicenses'; // { [materialId]: { issuedAt, expiresAt, storagePath, title } }
const TTL_MS           = 36 * 60 * 60 * 1000; // 36h
const RENEW_WINDOW_MS  = 6  * 60 * 60 * 1000; // proactively renew inside the last 6h of a license's life
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;     // check for renewals-due every 15 min while the app is open

function _load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return (raw && typeof raw === 'object') ? raw : {};
  } catch { return {}; }
}

function _save(map) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch (_) {} // private-browsing/quota — non-fatal, licenses just won't persist across reloads
}

/** Performs the actual server round trip that both issues and renews a license — see file header for why this reuses get-material-url rather than a dedicated endpoint. */
async function _confirmAccess(materialId, storagePath, title) {
  try {
    const { error } = await sb.functions.invoke('get-material-url', {
      body: { storage_path: storagePath, material_id: materialId, title },
    });
    const status = error?.context?.status ?? error?.status;
    if (status === 403) return false;
    if (error) return null; // offline / transient failure — NOT a denial, don't revoke on this
    return true;
  } catch (_) {
    return null; // offline / transient — same as above
  }
}

export const LicenseManager = {
  /** True if this material currently has a non-expired license — the gate MaterialCache.read() consults before decrypting anything offline. */
  isValid(materialId) {
    const rec = _load()[materialId];
    return !!rec && rec.expiresAt > Date.now();
  },

  /** Issues a fresh license (first cache) or renews an existing one (subsequent confirmed access) — call this any time get-material-url succeeds for a cacheable material. */
  issue(materialId, storagePath, title) {
    if (!materialId) return;
    const map = _load();
    const now = Date.now();
    map[materialId] = { issuedAt: now, expiresAt: now + TTL_MS, storagePath: storagePath || map[materialId]?.storagePath || '', title: title || map[materialId]?.title || '' };
    _save(map);
  },

  /** Revokes a license immediately — call on a confirmed 403 (access actually denied), never on a mere offline/network failure. */
  async revoke(materialId) {
    const map = _load();
    if (map[materialId]) {
      delete map[materialId];
      _save(map);
    }
    await MaterialCache.evict(materialId);
  },

  /** Wipes every license — call on logout, alongside MaterialCache.clear(). */
  clear() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  },

  /** Materials whose license expires within RENEW_WINDOW_MS (or already has), for the background sweep below. */
  _dueForRenewal() {
    const map = _load();
    const cutoff = Date.now() + RENEW_WINDOW_MS;
    return Object.entries(map)
      .filter(([, rec]) => rec.expiresAt < cutoff)
      .map(([materialId, rec]) => ({ materialId, storagePath: rec.storagePath, title: rec.title }));
  },

  /**
   * Starts a background sweep that silently renews any license nearing
   * expiry while the device is online — the "mandatory background
   * synchronization and renewal" requirement. Runs on an interval
   * AND immediately whenever the browser regains connectivity (the
   * moment renewal is actually possible after being offline).
   * Safe to call once at app boot; a second call is a silent no-op.
   */
  startBackgroundRenewal() {
    if (this._started) return;
    this._started = true;

    const sweep = async () => {
      if (!navigator.onLine || !State.currentUser) return;
      for (const { materialId, storagePath, title } of this._dueForRenewal()) {
        const ok = await _confirmAccess(materialId, storagePath, title);
        if (ok === true) this.issue(materialId, storagePath, title);
        else if (ok === false) await this.revoke(materialId); // real 403 — subscription actually lapsed
        // ok === null (offline/transient): leave the existing license alone, try again next sweep
      }
    };

    setInterval(sweep, SWEEP_INTERVAL_MS);
    window.addEventListener('online', sweep);
    // One initial sweep shortly after boot, in case licenses were
    // already stale from a previous session (e.g. the app was closed
    // for two days).
    setTimeout(sweep, 5000);
  }
};
