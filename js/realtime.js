/* ═══════════════════════════════════════════════════════════════
   REALTIME — admin-approved premium updates pushed live
═══════════════════════════════════════════════════════════════ */
import { sb } from './supabaseClient.js';
import { State } from './state.js';
import { $ } from './dom.js';
import { UI } from './ui.js';
import { Modules } from './modules.js';
import { Community } from './community.js';
import { Subscription } from './subscription.js';

/* ─────────────────────────────────────────────────────────────
   REALTIME — admin-approved premium updates pushed live
───────────────────────────────────────────────────────────── */
export const Realtime = {
  setup() {
    if (!State.currentUser || State.realtimeChannel) return;
    State.realtimeChannel = sb
      .channel('profile_' + State.currentUser.id)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'user_profiles',
        filter: 'id=eq.' + State.currentUser.id
      }, (payload) => {
        State.currentProfile = { ...(State.currentProfile || {}), ...payload.new };
        UI.updateHeader();
        Modules.render(false);
        Modules.updatePremiumNotice();
        Community.updateNote();
        if (payload.new.has_s1_access && !payload.old.has_s1_access) this.showPremiumToast('S1');
        if (payload.new.has_s2_access && !payload.old.has_s2_access) this.showPremiumToast('S2');

        // If the subscription modal happens to be open right now, refresh
        // it immediately — e.g. the "Both Semesters" card (or the one
        // semester just approved) needs to disappear without the student
        // having to close and reopen the modal themselves.
        if (State.subModalOpen) Subscription.updatePlanUI();
      })
      .subscribe();
  },
  showPremiumToast(sem) {
    const toast = $('protection-toast');
    toast.style.background = 'var(--green)';
    toast.textContent = '🎉 S' + sem + ' Premium access has been activated!';
    toast.classList.remove('hidden');
    setTimeout(() => { toast.classList.add('hidden'); toast.style.background = ''; }, 4000);
  },
  teardown() {
    if (State.realtimeChannel) { sb.removeChannel(State.realtimeChannel); State.realtimeChannel = null; }
  }
};

