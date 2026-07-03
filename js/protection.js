/* ═══════════════════════════════════════════════════════════════
   CONTENT PROTECTION
   ───────────────────────────────────────────────────────────────
   Anti-copy / anti-screenshot measures: DevTools detection, print
   override, drag/selection blocking, and the toast used to notify
   the user when a protected action is blocked.
═══════════════════════════════════════════════════════════════ */
import { $ } from './dom.js';
import { State } from './state.js';

/* ─────────────────────────────────────────────────────────────
   CONTENT PROTECTION
───────────────────────────────────────────────────────────── */
export const Protection = {
  // Bound once so add/removeEventListener target the same function refs.
  _onContextMenu: (e) => e.preventDefault(),
  _onDragStart: (e) => e.preventDefault(),
  _onSelectStart: (e) => {
    const tag = e.target.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') e.preventDefault();
  },
  _onKeydown(e) {
    if ((e.ctrlKey || e.metaKey) && ['p', 's', 'P', 'S', 'a', 'A'].includes(e.key)) {
      e.preventDefault();
      Protection.showToast();
    }
    if (e.key === 'F12' || e.key === 'PrintScreen') {
      e.preventDefault();
      Protection.showToast();
    }
  },
  _onBlur() {
    if (State.contentViewerActive) $('cv-body').classList.add('blurred');
    if (State.pdfViewerActive)    document.getElementById('pdf-canvas-zone')?.classList.add('blurred');
  },
  _onFocus() {
    $('cv-body').classList.remove('blurred');
    document.getElementById('pdf-canvas-zone')?.classList.remove('blurred');
  },
  _onVisibilityChange() {
    if (document.hidden && (State.contentViewerActive || State.pdfViewerActive)) {
      $('cv-body').classList.add('blurred');
      document.getElementById('pdf-canvas-zone')?.classList.add('blurred');
    } else if (!document.hidden) {
      $('cv-body').classList.remove('blurred');
      document.getElementById('pdf-canvas-zone')?.classList.remove('blurred');
    }
  },
  _checkDevTools() {
    const threshold = 160;
    if (window.outerWidth - window.innerWidth > threshold || window.outerHeight - window.innerHeight > threshold) {
      if (State.contentViewerActive) $('cv-body').classList.add('blurred');
      if (State.pdfViewerActive) document.getElementById('pdf-canvas-zone')?.classList.add('blurred');
    }
  },

  activate() {
    document.addEventListener('contextmenu', this._onContextMenu);
    document.addEventListener('keydown', this._onKeydown);
    document.addEventListener('dragstart', this._onDragStart);
    document.addEventListener('selectstart', this._onSelectStart);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('focus', this._onFocus);
    document.addEventListener('visibilitychange', this._onVisibilityChange);
    State.devToolsInterval = setInterval(this._checkDevTools, 1200);
  },

  deactivate() {
    document.removeEventListener('contextmenu', this._onContextMenu);
    document.removeEventListener('keydown', this._onKeydown);
    document.removeEventListener('dragstart', this._onDragStart);
    document.removeEventListener('selectstart', this._onSelectStart);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('focus', this._onFocus);
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    if (State.devToolsInterval) { clearInterval(State.devToolsInterval); State.devToolsInterval = null; }
  },

  showToast() {
    const toast = $('protection-toast');
    toast.classList.remove('hidden');
    toast.style.animation = 'none';
    void toast.offsetWidth;
    toast.style.animation = 'slideDown .3s ease, fadeOutToast 3s forwards';
    if (State.toastTimeout) clearTimeout(State.toastTimeout);
    State.toastTimeout = setTimeout(() => toast.classList.add('hidden'), 3300);
  }
};

