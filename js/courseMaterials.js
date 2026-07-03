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
  // Map< "sem:moduleName:category" → { id, title, storage_path } >
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
        .order('sort_order', { ascending: true });

      if (error) {
        console.error('[CourseMaterials.load] DB error:', error.message);
        this._cache = null; // allow retry on next call
        return;
      }

      for (const row of (data || [])) {
        const key = `${row.semester}:${row.module_name}:${row.category}`;
        this._cache.set(key, {
          id:           row.id,
          title:        row.title,
          storagePath:  row.storage_path
        });
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
   * Returns { id, title, storagePath } or null when no PDF is registered.
   * @param {number} semester  1 or 2
   * @param {string} modName   Exact module_name as stored in the DB
   * @param {string} type      'summary' | 'fullLesson' | 'guide'
   */
  get(semester, modName, type) {
    if (!this._cache) return null;
    const category = this._typeToCategory[type] || type;
    return this._cache.get(`${semester}:${modName}:${category}`) ?? null;
  },

  /** Call on logout so the next login fetches a fresh, access-correct set */
  invalidate() {
    this._cache   = null;
    this._loading = false;
  }
};

