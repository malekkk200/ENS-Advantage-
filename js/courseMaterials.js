/* ═══════════════════════════════════════════════════════════════
   COURSE MATERIALS
═══════════════════════════════════════════════════════════════ */
import { sb } from './supabaseClient.js';

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
    } catch (err) {
      console.error('[CourseMaterials.load] Unexpected error:', err);
      this._cache = null;
    } finally {
      this._loading = false;
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
    this._cache   = null;
    this._loading = false;
  }
};

