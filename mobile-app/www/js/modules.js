/* ═══════════════════════════════════════════════════════════════
   MODULES — semester tabs + module list rendering/expansion
═══════════════════════════════════════════════════════════════ */
import { Curriculum } from './curriculum.js';
import { State } from './state.js';
import { $, escHtml, initScrollReveal } from './dom.js';
import { Content } from './content.js';
import { Subscription } from './subscription.js';
import { CourseMaterials } from './courseMaterials.js';
import { PDFViewer } from './pdfViewer.js';

/* ─────────────────────────────────────────────────────────────
   MODULES — semester tabs + module list
───────────────────────────────────────────────────────────── */
export const Modules = {
  switchSemester(num) {
    State.activeSemester = num;
    State.expandedModuleName = null;
    $('sem-tab-1').classList.toggle('active', num === 1);
    $('sem-tab-2').classList.toggle('active', num === 2);
    this.render(true);
    this.updatePremiumNotice();
  },

  updatePremiumNotice() {
    const notice = $('premium-notice');
    // The native-app copy omits this bar entirely (removed from
    // index.html) — bail out safely instead of throwing when the
    // element doesn't exist. The website copy still has the element
    // and is unaffected by this guard.
    if (!notice) return;
    const hasPrem = State.hasPremiumForSem(State.activeSemester);
    if (hasPrem) {
      notice.style.display = 'none';
    } else {
      notice.style.display = 'flex';
      $('notice-sem').textContent = State.activeSemester;
      $('notice-unlock-btn').onclick = () => Subscription.open(State.activeSemester);
    }
  },

  render(animate = false) {
    const modules = Curriculum.modulesFor(State.activeSemester);
    const hasPrem = State.hasPremiumForSem(State.activeSemester);
    const container = $('module-list');
    container.innerHTML = '';

    modules.forEach((mod, index) => {
      const isExpanded = State.expandedModuleName === mod.name;
      const card = document.createElement('div');
      card.className = 'module-card' + (isExpanded ? ' expanded' : '');

      if (animate) {
        card.classList.add('reveal');
        card.style.animationDelay = Math.min(index * 0.08, 0.5) + 's';
      }
      card.id = 'mod-card-' + CSS.escape(mod.name);

      // Course-card cover accent — cycled from the existing token
      // palette (see css/app-template.css §7). No photos available,
      // so a gradient + big initial stands in for the template's
      // course thumbnail image.
      const COVER_PAIRS = [
        ['var(--accent)', 'var(--navy)'],
        ['var(--purple)', 'var(--navy-mid)'],
        ['var(--green)', 'var(--navy)'],
        ['var(--orange)', 'var(--navy-mid)'],
        ['var(--gold)', 'var(--navy)'],
      ];
      const [coverA, coverB] = COVER_PAIRS[index % COVER_PAIRS.length];
      card.style.setProperty('--cover-a', coverA);
      card.style.setProperty('--cover-b', coverB);
      const initial = (mod.name || '').trim()[0]?.toUpperCase() || '•';

      const header = document.createElement('div');
      header.className = 'module-header';
      header.onclick = () => this.toggleModule(mod.name);
      header.innerHTML = `
        <div class="course-cover"><span class="course-cover-initial">${escHtml(initial)}</span></div>
        <div class="course-card-body">
          <div class="course-tags">
            <span class="course-tag">⚖ Coef ${mod.coef}</span>
            <span class="course-tag course-tag-alt">S${State.activeSemester}</span>
          </div>
          <div class="module-name${mod.rtl ? ' rtl' : ''}" ${mod.rtl ? 'dir="rtl"' : ''}>${escHtml(mod.name)}</div>
          <div class="course-caption">Summaries, full lessons &amp; strategic guides</div>
          <div class="course-cta">
            <span>View Materials</span>
            <span class="module-chevron">▾</span>
          </div>
        </div>
      `;

      const body = document.createElement('div');
      body.className = 'module-body';
      body.innerHTML = this.buildModuleBody(mod, hasPrem);
      // Event delegation instead of string-interpolated onclick attributes —
      // module names (which can contain quotes/RTL text) never have to be
      // serialized into an inline JS attribute this way.
      body.addEventListener('click', (e) => {
        const dlBtn = e.target.closest('[data-action="download-offline"]');
        if (dlBtn) {
          // Never also open the viewer — this tap means "cache it for
          // later," not "open it right now."
          e.stopPropagation();
          this._handleDownloadClick(dlBtn);
          return;
        }
        const item = e.target.closest('[data-action="open-content"]');
        if (!item) return;
        Content.open(item.dataset.mod, item.dataset.type, item.dataset.prem === 'true');
      });

      card.appendChild(header);
      card.appendChild(body);
      container.appendChild(card);
    });

    if (animate) setTimeout(initScrollReveal, 50);
  },

  buildModuleBody(mod, hasPrem) {
    const name = escHtml(mod.name);

    /**
     * Renders the small "download for offline" affordance next to a
     * content-item, or '' when there's nothing to download (no PDF
     * registered for this slot yet, or it's premium content the
     * student can't view anyway — no point offering to cache
     * something they're not entitled to open).
     */
    const downloadButton = (type, viewable) => {
      if (!viewable) return '';
      const materials = CourseMaterials.getAll(State.activeSemester, mod.name, type);
      if (!materials.length) return '';
      // A slot can (rarely) hold several materials — offer to
      // download all of them from one button rather than making the
      // student pick, since there's no viewer overlay to pick inside
      // here (unlike Content.open()'s picker).
      const ids = materials.map(m => m.id).join(',');
      const alreadyOffline = materials.every(m => PDFViewer.isOfflineReady(m.id));
      return `
        <button type="button" class="download-offline-btn${alreadyOffline ? ' downloaded' : ''}"
                data-action="download-offline" data-mod="${name}" data-type="${type}" data-ids="${escHtml(ids)}"
                title="${alreadyOffline ? 'Available offline' : 'Download for offline access'}"
                aria-label="${alreadyOffline ? 'Available offline' : 'Download for offline access'}">
          <span class="download-offline-icon">${alreadyOffline ? '✓' : '⬇'}</span>
        </button>`;
    };

    const lessonsPart = !mod.isListening ? `
      <div>
        <div class="content-section-title">📚 Lessons</div>
        <div class="content-item" data-action="open-content" data-mod="${name}" data-type="summary" data-prem="${hasPrem}">
          <div class="content-item-left">
            <div class="content-icon free">📋</div>
            <div>
              <div class="content-name">Summarize</div>
              <div class="content-tag free-tag">✓ Free Access</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:.5rem;">
            ${downloadButton('summary', true)}
            <span style="font-size:.8rem;color:var(--slate-400);">→</span>
          </div>
        </div>
        <div class="content-item" data-action="open-content" data-mod="${name}" data-type="fullLesson" data-prem="${hasPrem}">
          <div class="content-item-left">
            <div class="content-icon ${hasPrem ? 'premium' : 'locked'}">${hasPrem ? '📖' : '🔒'}</div>
            <div>
              <div class="content-name" style="color:${hasPrem ? 'var(--slate-900)' : 'var(--slate-500)'};">Full Lesson</div>
              <div class="content-tag ${hasPrem ? 'unlocked-tag' : 'premium-tag'}">${hasPrem ? '✓ Unlocked' : '⚡ Premium Only'}</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:.5rem;">
            ${downloadButton('fullLesson', hasPrem)}
            <span style="font-size:.8rem;color:var(--slate-400);">${hasPrem ? '→' : '🔒'}</span>
          </div>
        </div>
      </div>` : '';

    const listeningNote = mod.isListening ? `
      <div class="listening-note">
        ℹ️ This module is practice-based. Written lessons are replaced by practical methodology guides and oral examination strategy.
      </div>` : '';

    const guidePart = `
      <div class="${mod.isListening ? 'full-width' : ''}">
        <div class="content-section-title">🎯 Guide</div>
        <div class="content-item" data-action="open-content" data-mod="${name}" data-type="guide" data-prem="${hasPrem}">
          <div class="content-item-left">
            <div class="content-icon guide">🎯</div>
            <div>
              <div class="content-name">Comprehensive Guide</div>
              <div class="content-tag free-tag">✓ Free Access</div>
            </div>
          </div>
          <span style="font-size:.8rem;color:var(--slate-400);">→</span>
        </div>
        ${listeningNote}
      </div>`;

    return `<div class="content-grid">${lessonsPart}${guidePart}</div>`;
  },

  toggleModule(name) {
    if (State.expandedModuleName === name) {
      State.expandedModuleName = null;
      const card = $('mod-card-' + CSS.escape(name));
      if (card) card.classList.remove('expanded');
    } else {
      if (State.expandedModuleName) {
        const oldCard = $('mod-card-' + CSS.escape(State.expandedModuleName));
        if (oldCard) oldCard.classList.remove('expanded');
      }
      State.expandedModuleName = name;
      const newCard = $('mod-card-' + CSS.escape(name));
      if (newCard) newCard.classList.add('expanded');
    }
  },

  /**
   * Handles a tap on a "download for offline" button — see
   * buildModuleBody()'s downloadButton() for how it's rendered.
   * Downloads every material in this slot (almost always just one)
   * via PDFViewer.prefetchOffline(), updating the button's own icon
   * to reflect progress/result. Never opens the viewer.
   */
  async _handleDownloadClick(btn) {
    if (btn.classList.contains('downloading') || btn.classList.contains('downloaded')) return; // already in progress or done — nothing to do
    const modName = btn.dataset.mod;
    const type = btn.dataset.type;
    const ids = (btn.dataset.ids || '').split(',').filter(Boolean);
    const modules = Curriculum.modulesFor(State.activeSemester);
    const mod = modules.find(m => m.name === modName);
    const materials = CourseMaterials.getAll(State.activeSemester, modName, type)
      .filter(m => ids.includes(m.id));
    if (!mod || !materials.length) return;

    const icon = btn.querySelector('.download-offline-icon');
    btn.classList.add('downloading');
    btn.classList.remove('downloaded');
    if (icon) icon.textContent = '⏳';
    btn.disabled = true;

    let allOk = true;
    let lastFailureReason = null;
    for (const material of materials) {
      const result = await PDFViewer.prefetchOffline(mod, type, material);
      if (!result.ok) { allOk = false; lastFailureReason = result.reason; }
    }

    btn.classList.remove('downloading');
    btn.disabled = false;

    if (allOk) {
      btn.classList.add('downloaded');
      if (icon) icon.textContent = '✓';
      btn.title = 'Available offline';
      btn.setAttribute('aria-label', 'Available offline');
    } else {
      // Revert to the download icon rather than leaving it stuck on
      // the spinner — the student can just tap again. A friendlier
      // message for the one failure mode they can actually act on
      // (no internet right now); anything else stays generic rather
      // than leaking server-side detail into the UI.
      if (icon) icon.textContent = '⬇';
      btn.title = lastFailureReason === 'network'
        ? 'No internet connection — try again when you\'re online'
        : 'Download failed — tap to try again';
      btn.setAttribute('aria-label', btn.title);
    }
  }
};

