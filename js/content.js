/* ═══════════════════════════════════════════════════════════════
   CONTENT VIEWER  (HTML fallback — used only when no PDF exists)
═══════════════════════════════════════════════════════════════ */
import { sb } from './supabaseClient.js';
import { Curriculum } from './curriculum.js';
import { CourseMaterials } from './courseMaterials.js';
import { State } from './state.js';
import { $, escHtml, lockBodyScroll, unlockBodyScroll } from './dom.js';
import { PDFViewer } from './pdfViewer.js';
import { Subscription } from './subscription.js';

/* ─────────────────────────────────────────────────────────────
   CONTENT VIEWER  (HTML fallback — used only when no PDF exists)
   When a PDF is registered in course_materials, PDFViewer takes
   over completely and this module is bypassed for that material.
───────────────────────────────────────────────────────────── */
export const Content = {
  /**
   * Entry point called by module card buttons.
   * Routes to PDFViewer when a PDF is registered; falls back to
   * the HTML content overlay for legacy / unregistered content.
   */
  async open(modName, type, hasPrem) {
    const modules = Curriculum.modulesFor(State.activeSemester);
    const mod = modules.find(m => m.name === modName);
    if (!mod) return;

    // Gate premium content before any network call
    if (type !== 'summary' && !hasPrem) {
      Subscription.open(State.activeSemester);
      return;
    }

    // Check for registered PDFs in course_materials — a slot can now
    // hold more than one (oldest -> newest); the array is empty when
    // nothing is registered yet.
    const materials = CourseMaterials.getAll(State.activeSemester, modName, type);

    if (materials.length === 1) {
      // Only one on file — open it directly, same as before.
      await PDFViewer.open(mod, type, materials[0]);
      return;
    }

    if (materials.length > 1) {
      // Several materials in this slot — let the student pick one,
      // oldest first, instead of guessing which one they'll get.
      this._showPicker(mod, type, materials);
      return;
    }

    // ── HTML fallback ──────────────────────────────────────────────
    if (type === 'summary') {
      this._showHtml(mod, type, this._summaryPlaceholder(mod));
      return;
    }

    // Show loading state in the HTML overlay while we fetch
    this._showHtml(mod, type,
      '<div class="mock-content"><p style="text-align:center;padding:2rem">⏳ Loading…</p></div>');

    const table = type === 'fullLesson' ? 'lessons' : 'guides';
    const { data } = await sb
      .from(table)
      .select('content_html')
      .eq('module_name', modName)
      .eq('semester', State.activeSemester)
      .single();

    const safeHtml = DOMPurify.sanitize(
      (data?.content_html) ? data.content_html : this._fallbackHtml(mod, type),
      { USE_PROFILES: { html: true } }
    );
    $('cv-content').innerHTML = safeHtml;
  },

  // Holds the material list currently offered by the picker, so the
  // onclick handler (which can only pass simple values) can look the
  // chosen one back up by index.
  _pickerMod: null,
  _pickerType: null,
  _pickerMaterials: null,

  /** Shows a simple oldest→newest list; picking one opens the PDF viewer. */
  _showPicker(mod, type, materials) {
    this._pickerMod = mod;
    this._pickerType = type;
    this._pickerMaterials = materials;

    const itemsHtml = materials.map((m, i) => `
      <button type="button" class="material-picker-item" onclick="App.Content._openPicked(${i})">
        <span class="material-picker-index">${i + 1}</span>
        <span class="material-picker-title">${escHtml(m.title || mod.name)}</span>
      </button>
    `).join('');

    this._showHtml(mod, type, `
      <div class="material-picker">
        <p class="material-picker-hint">هناك عدة ملفات لهذه المادة — اختر واحداً لفتحه:</p>
        ${itemsHtml}
      </div>
    `);
    // The list above is plain buttons, not premium body text — hide
    // the watermark layer PDFViewer/HTML premium content normally gets.
    const wmLayer = $('cv-watermark');
    if (wmLayer) wmLayer.innerHTML = '';
  },

  /** Called by the picker's onclick handlers. */
  async _openPicked(index) {
    const material = this._pickerMaterials?.[index];
    const mod  = this._pickerMod;
    const type = this._pickerType;
    if (!material || !mod) return;
    this.close();
    await PDFViewer.open(mod, type, material);
  },

  _summaryPlaceholder(mod) {
    return `<div class="mock-content">
      <h4>📋 Summary — ${escHtml(mod.name)}</h4>
      <p>A concise, exam-ready summary covering all key concepts — structured to maximise retention before your TD sessions and exams.</p>
      <ul>
        <li>Core theoretical frameworks and foundational concepts</li>
        <li>Essential terminology and academic vocabulary</li>
        <li>Common exam question patterns and model answers</li>
        <li>Critical analysis techniques expected at ENS level</li>
      </ul>
    </div>`;
  },

  _fallbackHtml(mod, type) {
    const labels = { fullLesson: 'Full Lesson', guide: 'Comprehensive Guide' };
    return `<div class="mock-content"><h4>${escHtml(labels[type] || type)} — ${escHtml(mod.name)}</h4><p>Content is being prepared. Check back soon.</p></div>`;
  },

  _showHtml(mod, type, htmlContent) {
    const typeLabels = { summary: 'Free Summary', fullLesson: 'Full Lesson', guide: 'Comprehensive Guide' };
    $('cv-title').textContent = mod.name;
    $('cv-subtitle').textContent = typeLabels[type] || '';
    $('cv-content').innerHTML = DOMPurify.sanitize(htmlContent, { USE_PROFILES: { html: true } });

    const body = $('cv-body');
    body.classList.remove('blurred');

    // Watermark for premium HTML content
    const wmLayer = $('cv-watermark');
    wmLayer.innerHTML = '';
    if (type !== 'summary' && State.currentUser && State.currentProfile) {
      const text = `${State.currentProfile.first_name} ${State.currentProfile.last_name} – ${State.currentUser.email}`.trim();
      for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 3; col++) {
          const el = document.createElement('div');
          el.className = 'watermark-text';
          el.style.top  = (row * 130 + 40) + 'px';
          el.style.left = (col * 280 - 60)  + 'px';
          el.textContent = text;
          wmLayer.appendChild(el);
        }
      }
    }

    if (type !== 'summary') State.contentViewerActive = true;
    $('content-overlay').classList.remove('hidden');
    lockBodyScroll();
  },

  close() {
    $('content-overlay').classList.add('hidden');
    unlockBodyScroll();
    State.contentViewerActive = false;
  }
};

