/* ═══════════════════════════════════════════════════════════════
   MODULES — semester tabs + module list rendering/expansion
═══════════════════════════════════════════════════════════════ */
import { Curriculum } from './curriculum.js';
import { State } from './state.js';
import { $, escHtml, initScrollReveal } from './dom.js';
import { Content } from './content.js';
import { Subscription } from './subscription.js';

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

      const header = document.createElement('div');
      header.className = 'module-header';
      header.onclick = () => this.toggleModule(mod.name);
      header.innerHTML = `
        <div class="module-info">
          <div class="module-name${mod.rtl ? ' rtl' : ''}" ${mod.rtl ? 'dir="rtl"' : ''}>${escHtml(mod.name)}</div>
          <div class="coef-pill">⚖ Coefficient: ${mod.coef}</div>
        </div>
        <div class="module-chevron">▾</div>
      `;

      const body = document.createElement('div');
      body.className = 'module-body';
      body.innerHTML = this.buildModuleBody(mod, hasPrem);
      // Event delegation instead of string-interpolated onclick attributes —
      // module names (which can contain quotes/RTL text) never have to be
      // serialized into an inline JS attribute this way.
      body.addEventListener('click', (e) => {
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
          <span style="font-size:.8rem;color:var(--slate-400);">→</span>
        </div>
        <div class="content-item" data-action="open-content" data-mod="${name}" data-type="fullLesson" data-prem="${hasPrem}">
          <div class="content-item-left">
            <div class="content-icon ${hasPrem ? 'premium' : 'locked'}">${hasPrem ? '📖' : '🔒'}</div>
            <div>
              <div class="content-name" style="color:${hasPrem ? 'var(--slate-900)' : 'var(--slate-500)'};">Full Lesson</div>
              <div class="content-tag ${hasPrem ? 'unlocked-tag' : 'premium-tag'}">${hasPrem ? '✓ Unlocked' : '⚡ Premium Only'}</div>
            </div>
          </div>
          <span style="font-size:.8rem;color:var(--slate-400);">${hasPrem ? '→' : '🔒'}</span>
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
  }
};

