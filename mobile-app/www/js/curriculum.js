/* ═══════════════════════════════════════════════════════════════
   CURRICULUM DATA
═══════════════════════════════════════════════════════════════ */
import { sb } from './supabaseClient.js';

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
    } catch (err) {
      console.error('[Curriculum.load] Failed to fetch curriculum from database:', err);
    }
  }
};

