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
───────────────────────────────────────────────────────────── */
export const Curriculum = {
  SEMESTER_1: [],
  SEMESTER_2: [],
  CALC_DATA: { 1: [], 2: [] },
  _loaded: false,

  modulesFor(sem) { return sem === 1 ? this.SEMESTER_1 : this.SEMESTER_2; },

  async load() {
    // Skip if already loaded (avoids re-fetching on tab switches / realtime events)
    if (this._loaded) return;

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
      // Offline (or any other failure) — fall back to the last
      // successfully synced copy so the module list and, critically,
      // the grade calculator still have something to work with
      // without a connection. A genuinely first-ever launch with no
      // connectivity and no prior sync has nothing to fall back to;
      // the arrays simply stay empty in that one specific case, same
      // as before this change.
      this._loadFromPersistedCache();
    }
  },

  _loadFromPersistedCache() {
    try {
      const raw = localStorage.getItem(PERSIST_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed?.SEMESTER_1) this.SEMESTER_1 = parsed.SEMESTER_1;
      if (parsed?.SEMESTER_2) this.SEMESTER_2 = parsed.SEMESTER_2;
      if (parsed?.CALC_DATA)  this.CALC_DATA  = parsed.CALC_DATA;
      // Deliberately NOT setting _loaded = true here — if connectivity
      // returns later this session and something calls load() again,
      // it should get a real chance to refresh rather than being
      // stuck on this offline snapshot until the next full app
      // restart. Falling back to the same persisted copy again on a
      // retry that still has no connection is harmless.
      console.info('[Curriculum.load] Using last-synced offline copy.');
    } catch (err) {
      console.warn('[Curriculum._loadFromPersistedCache] failed:', err);
    }
  }
};

