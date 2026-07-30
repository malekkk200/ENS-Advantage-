/* ═══════════════════════════════════════════════════════════════
   STATE
   ───────────────────────────────────────────────────────────────
   The single source of truth, replacing every loose `let` global
   the old script had. Every other module imports this same object
   (ES module imports are live bindings + this is a mutable object,
   so mutations made in one module are visible everywhere else).
═══════════════════════════════════════════════════════════════ */

/* ─────────────────────────────────────────────────────────────
   STATE — the single source of truth, replacing every loose
   `let` global the old script had.
───────────────────────────────────────────────────────────── */
export const State = {
  // session / profile
  currentUser: null,
  currentProfile: null,
  realtimeChannel: null,
  sessionChannel: null,
  // auth screen
  currentAuthMode: 'login',
  // main app
  activeSemester: 1,
  expandedModuleName: null,
  dropdownOpen: false,
  helpPopoverOpen: false,
  contentViewerActive: false,
  pdfViewerActive: false,
  // subscription modal
  subModalOpen: false,
  selectedPlan: 'S1',
  subModalDefaultSemester: undefined,
  discountEligible: false, // new-student 40%-off first-subscription offer
  // calculator
  calcActiveSem: 1,
  // misc
  scrollObserver: null,
  toastTimeout: null,
  devToolsInterval: null,

  hasPremiumForSem(sem) {
    if (!this.currentProfile) return false;
    return sem === 1 ? !!this.currentProfile.has_s1_access : !!this.currentProfile.has_s2_access;
  },
  hasAnyPremium() {
    return !!(this.currentProfile && (this.currentProfile.has_s1_access || this.currentProfile.has_s2_access));
  }
};

