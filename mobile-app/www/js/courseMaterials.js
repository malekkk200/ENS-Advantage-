/* ═══════════════════════════════════════════════════════════════
   COURSE MATERIALS
═══════════════════════════════════════════════════════════════ */
import { sb } from './supabaseClient.js';
import { State } from './state.js';

// Persisted per-account (not per-device) so this metadata is available
// on a later offline launch — without it, Content.open() has no way
// to know a full lesson/summary even HAS a cached PDF to render from
// materialCache.js's encrypted store, offline or not. RLS already
// scoped what got fetched here in the first place; this is just a
// local mirror of that same already-filtered result, not a new access
// path — see the class comment below. Scoped by user id so a second
// account signing in on the same device never sees a stale mix of the
// previous account's material list before their own fresh sync lands.
function persistKey() {
  return `ensCourseMaterialsCache_v1_${State.currentUser?.id || 'anon'}`;
}

/* ─────────────────────────────────────────────────────────────
   COURSE MATERIALS
   Fetches PDF metadata from the `course_materials` table and
   caches it in memory keyed by (semester, module_name, category).

   The actual PDF bytes never pass through here — only the
   storage_path string is cached. The raw file is served
   exclusively through a short-lived signed URL generated at
   open-time by createSignedUrl(), so any leaked cache entry
   is completely useless without a valid Supabase session.

   load() is cache-first, not network-first: if a persisted copy
   exists for the current account, it's applied synchronously and
   load() returns immediately, with the network fetch happening
   afterward in the background. This matters a lot offline — a
   fetch() to an unreachable host doesn't fail instantly, it can take
   several seconds to time out, and the caller here
   (UI.showMainApp()) awaits this before rendering anything. Waiting
   on that timeout before falling back to the cache is what caused a
   multi-second blank screen on a cold offline launch even though a
   perfectly good cached copy existed the whole time.
───────────────────────────────────────────────────────────── */
export const CourseMaterials = {
  // Map< "sem:moduleName:category" → Array<{ id, title, storagePath }> >
  // A slot can now hold more than one material (e.g. several summaries
  // uploaded over time). Each array is ordered oldest -> newest,
  // matching the DB's `sort_order` (which the upload function always
  // appends to, never overwrites).
  _cache: null,
  _loading: false,

  async load() {
    if (this._cache !== null || this._loading) return;

    if (this._applyPersistedCache()) {
      // Refresh silently in the background — doesn't block whoever's
      // awaiting load() right now.
      this._fetchAndPersist().catch(() => {});
      return;
    }

    // No persisted copy for this account — nothing to show either
    // way, so it's correct to actually wait on the network here.
    await this._fetchAndPersist();
  },

  async _fetchAndPersist() {
    this._loading = true;
    if (this._cache === null) this._cache = new Map();

    try {
      // RLS on the server ensures the user only receives rows they
      // are entitled to see — no client-side filtering needed.
      const { data, error } = await sb
        .from('course_materials')
        .select('id, semester, module_name, category, title, storage_path')
        // sort_order is the primary "oldest -> newest" ordering, but it
        // can collide (e.g. two rows end up with the same sort_order
        // after a delete leaves a gap that a later upload's COUNT-based
        // number happens to reoccupy) — Postgres doesn't guarantee any
        // particular order among ties, so created_at as a secondary key
        // keeps oldest -> newest reliable even when that happens.
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true });

      if (error) {
        console.error('[CourseMaterials.load] DB error:', error.message);
        // Only wipe the cache if there was nothing already in it
        // (i.e. this was the primary fetch, not a background refresh
        // of an already-applied persisted copy) — a failed refresh
        // should never regress a student from "has offline access to
        // their cached lessons" back to "has nothing."
        if (this._cache.size === 0) this._cache = null;
        return;
      }

      const fresh = new Map();
      for (const row of (data || [])) {
        const key = `${row.semester}:${row.module_name}:${row.category}`;
        const entry = {
          id:           row.id,
          title:        row.title,
          storagePath:  row.storage_path
        };
        if (fresh.has(key)) {
          fresh.get(key).push(entry);
        } else {
          fresh.set(key, [entry]);
        }
      }
      this._cache = fresh;

      try {
        localStorage.setItem(persistKey(), JSON.stringify(Array.from(this._cache.entries())));
      } catch (_) { /* quota / private-browsing — non-fatal, just no offline fallback next launch */ }

    } catch (err) {
      console.error('[CourseMaterials.load] Unexpected error:', err);
      if (this._cache.size === 0) this._cache = null;
    } finally {
      this._loading = false;
    }
  },

  /** Synchronous, zero-network. Returns true if a persisted copy was found and applied. */
  _applyPersistedCache() {
    try {
      const raw = localStorage.getItem(persistKey());
      if (!raw) return false;
      const entries = JSON.parse(raw);
      this._cache = new Map(entries);
      console.info('[CourseMaterials] Using last-synced offline copy.');
      return true;
    } catch (err) {
      console.warn('[CourseMaterials._applyPersistedCache] failed:', err);
      this._cache = null;
      return false;
    }
  },

  // Map frontend type IDs → DB category strings
  _typeToCategory: {
    summary:    'summary',
    fullLesson: 'full_lesson',
    guide:      'guide'
  },

  /**
   * Returns every material registered for this slot, oldest -> newest.
   * Always an array — empty when nothing is registered yet.
   * @param {number} semester  1 or 2
   * @param {string} modName   Exact module_name as stored in the DB
   * @param {string} type      'summary' | 'fullLesson' | 'guide'
   */
  getAll(semester, modName, type) {
    if (!this._cache) return [];
    const category = this._typeToCategory[type] || type;
    return this._cache.get(`${semester}:${modName}:${category}`) ?? [];
  },

  /** Call on logout so the next login fetches a fresh, access-correct set */
  invalidate() {
    try { localStorage.removeItem(persistKey()); } catch (_) {}
    this._cache   = null;
    this._loading = false;
  }
};
