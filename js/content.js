/* ═══════════════════════════════════════════════════════════════
   CONTENT VIEWER  (HTML fallback — used only when no PDF exists)
═══════════════════════════════════════════════════════════════ */
import { sb } from './supabaseClient.js';
import { Curriculum } from './curriculum.js';
import { CourseMaterials } from './courseMaterials.js';
import { State } from './state.js';
import { $, escHtml } from './dom.js';
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

    // Check for a registered PDF in course_materials
    const material = CourseMaterials.get(State.activeSemester, modName, type);

    if (material) {
      // Hand off to the secure canvas-based PDF viewer
      await PDFViewer.open(mod, type, material);
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
  },

  close() {
    $('content-overlay').classList.add('hidden');
    State.contentViewerActive = false;
  }
};

