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
    // Return immediately if already loaded or a load is in progress
    if (this._cache !== null || this._loading) return;
    this._loading = true;
    this._cache   = new Map();

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
        this._cache = null; // allow retry on next call
        this._loadFromPersistedCache(); // offline (or any DB error) fallback
        return;
      }

      for (const row of (data || [])) {
        const key = `${row.semester}:${row.module_name}:${row.category}`;
        const entry = {
          id:           row.id,
          title:        row.title,
          storagePath:  row.storage_path
        };
        if (this._cache.has(key)) {
          this._cache.get(key).push(entry);
        } else {
          this._cache.set(key, [entry]);
        }
      }

      try {
        localStorage.setItem(persistKey(), JSON.stringify(Array.from(this._cache.entries())));
      } catch (_) { /* quota / private-browsing — non-fatal, just no offline fallback next launch */ }

    } catch (err) {
      console.error('[CourseMaterials.load] Unexpected error:', err);
      this._cache = null;
      this._loadFromPersistedCache();
    } finally {
      this._loading = false;
    }
  },

  /**
   * Offline (or any fetch failure) fallback — rehydrates from the
   * last successfully synced copy for the CURRENT account, so a
   * student can still open lessons/summaries they've already cached
   * (see materialCache.js) without a connection. If there's no
   * persisted copy yet (first-ever launch with no connectivity), this
   * is a no-op and _cache stays null / getAll() keeps returning [] —
   * there's genuinely nothing to fall back to in that specific case.
   */
  _loadFromPersistedCache() {
    try {
      const raw = localStorage.getItem(persistKey());
      if (!raw) return;
      const entries = JSON.parse(raw);
      this._cache = new Map(entries);
      console.info('[CourseMaterials.load] Using last-synced offline copy.');
    } catch (err) {
      console.warn('[CourseMaterials._loadFromPersistedCache] failed:', err);
      this._cache = null;
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

