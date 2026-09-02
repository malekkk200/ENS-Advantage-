/* ═══════════════════════════════════════════════════════════════
   CURRICULUM DATA
═══════════════════════════════════════════════════════════════ */
import { sb } from './supabaseClient.js';

// Small JSON snapshot (module names + calculator coefficients — not
// per-account data, the same for every student) persisted after every
// successful fetch so the module list and grade calculator still work
// on a later launch with no connection. Plain localStorage is fine
// here: this is program structure, not anything sensitive, and it's
// the same data every student already sees online regardless of who
// they are.
const PERSIST_KEY = 'ensCurriculumCache_v1';

/* ─────────────────────────────────────────────────────────────
   CURRICULUM DATA  (loaded from Supabase — no hardcoded values)
   Tables used:
     • curriculum_modules     → SEMESTER_1 / SEMESTER_2
     • curriculum_ues         → CALC_DATA UE groups
     • curriculum_ue_modules  → CALC_DATA module rows within each UE

   load() is cache-first, not network-first: if a persisted copy
   exists, it's applied synchronously and load() returns immediately,
   with the network fetch happening afterward in the background. This
   matters a lot offline — a fetch() to an unreachable host doesn't
   fail instantly, it can take several seconds to time out, and the
   caller here (UI.showMainApp()) awaits this before rendering
   anything. Waiting on that timeout before falling back to the cache
   is what caused a multi-second blank screen on a cold offline
   launch even though a perfectly good cached copy existed the whole
   time. Only a genuinely first-ever launch with nothing cached yet
   still has to wait on the real network attempt, because there's
   nothing else to show in that one specific case.
───────────────────────────────────────────────────────────── */
export const Curriculum = {
  SEMESTER_1: [],
  SEMESTER_2: [],
  CALC_DATA: { 1: [], 2: [] },
  _loaded: false,

  modulesFor(sem) { return sem === 1 ? this.SEMESTER_1 : this.SEMESTER_2; },

  async load() {
    if (this._loaded) return;

    if (this._applyPersistedCache()) {
      this._loaded = true;
      // Refresh silently in the background — doesn't block whoever's
      // awaiting load() right now. If it succeeds, this data updates
      // in place for next time (module list rarely changes mid
      // session, so not forcing an immediate re-render here is fine).
      this._fetchAndPersist().catch(() => {});
      return;
    }

    // No persisted copy at all — nothing to show either way, so it's
    // correct to actually wait on the network here.
    await this._fetchAndPersist();
  },

  async _fetchAndPersist() {
    try {
      // ── 1. Module list (used by the semester accordion) ──────────────
      const { data: mods, error: modsErr } = await sb
        .from('curriculum_modules')
        .select('semester, name, coef, is_listening, is_rtl')
        .order('sort_order');

      if (modsErr) throw modsErr;

      this.SEMESTER_1 = mods
        .filter(m => m.semester === 1)
        .map(m => ({ name: m.name, coef: m.coef, isListening: m.is_listening, rtl: m.is_rtl }));
      this.SEMESTER_2 = mods
        .filter(m => m.semester === 2)
        .map(m => ({ name: m.name, coef: m.coef, isListening: m.is_listening, rtl: m.is_rtl }));

      // ── 2. UEs + nested modules (used by the grade calculator) ────────
      const { data: ues, error: uesErr } = await sb
        .from('curriculum_ues')
        .select(`
          semester, code, ue_coef, sort_order,
          curriculum_ue_modules ( name, coef, is_rtl, sort_order )
        `)
        .order('sort_order');

      if (uesErr) throw uesErr;

      [1, 2].forEach(sem => {
        this.CALC_DATA[sem] = ues
          .filter(ue => ue.semester === sem)
          .map(ue => ({
            code: ue.code,
            ueCoef: ue.ue_coef,
            modules: (ue.curriculum_ue_modules || [])
              .slice()
              .sort((a, b) => a.sort_order - b.sort_order)
              .map(m => ({ name: m.name, coef: m.coef, rtl: m.is_rtl || false }))
          }));
      });

      this._loaded = true;

      try {
        localStorage.setItem(PERSIST_KEY, JSON.stringify({
          SEMESTER_1: this.SEMESTER_1,
          SEMESTER_2: this.SEMESTER_2,
          CALC_DATA:  this.CALC_DATA,
        }));
      } catch (_) { /* quota / private-browsing — non-fatal, just no offline fallback next launch */ }

    } catch (err) {
      console.error('[Curriculum.load] Failed to fetch curriculum from database:', err);
      // Only relevant when this was the "no persisted copy yet" path
      // (load() already applied the cache itself otherwise) — try
      // once more here in case something changed between then and now.
      // Deliberately doesn't re-throw: a genuinely first-ever launch
      // with no connectivity and nothing cached has nothing to fall
      // back to, and load() should still resolve (with empty arrays,
      // same as before any of this offline work existed) rather than
      // reject and break the Promise.all() awaiting it in
      // UI.showMainApp().
      this._applyPersistedCache();
    }
  },

  /** Synchronous, zero-network. Returns true if a persisted copy was found and applied. */
  _applyPersistedCache() {
    try {
      const raw = localStorage.getItem(PERSIST_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (parsed?.SEMESTER_1) this.SEMESTER_1 = parsed.SEMESTER_1;
      if (parsed?.SEMESTER_2) this.SEMESTER_2 = parsed.SEMESTER_2;
      if (parsed?.CALC_DATA)  this.CALC_DATA  = parsed.CALC_DATA;
      console.info('[Curriculum] Using last-synced offline copy.');
      return true;
    } catch (err) {
      console.warn('[Curriculum._applyPersistedCache] failed:', err);
      return false;
    }
  }
};
