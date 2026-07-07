/* ═══════════════════════════════════════════════════════════════
   ADMIN UPLOAD & DELETE PANEL
   ───────────────────────────────────────────────────────────────
   A no-code interface for uploading/deleting PDFs straight from the
   browser. Restricted to exactly one account — the check here is
   client-side UI convenience only (hides the button/blocks the
   modal for everyone else); the REAL security boundary is server
   side, in the admin-upload-material and admin-delete-material
   Edge Functions, which independently verify the caller's email
   against the admin account before touching storage or the DB. A
   client-side check alone would never be sufficient — anyone could
   just call the function directly with dev tools.

   NOTE: this file ships as-is to every visitor's browser (view-source
   shows it to anyone), and this repo is public — so we deliberately
   check `is_admin` on the user's own profile row instead of a
   hardcoded email address. That keeps the actual admin email out of
   both the public repo and the client bundle. `is_admin` is set once,
   directly in the database, for the one admin account; it plays no
   role in the real security check (that stays server-side).
═══════════════════════════════════════════════════════════════ */
import { $, escHtml } from './dom.js';
import { State } from './state.js';
import { Curriculum } from './curriculum.js';
import { CourseMaterials } from './courseMaterials.js';
import { Supabase } from './supabaseClient.js';
import { UI } from './ui.js';
import { Modules } from './modules.js';
import { PDFCompressor } from './pdfCompressor.js';

function _isAuthorizedAdmin() {
  return State.currentProfile?.is_admin === true;
}

export const AdminPanel = {
  _selectedFile: null,

  /** Show the admin button only for the one authorized account */
  refreshVisibility() {
    const btn = $('admin-dropdown-btn');
    if (!btn) return;
    btn.classList.toggle('hidden', !_isAuthorizedAdmin());
  },

  open() {
    if (!_isAuthorizedAdmin()) return; // defence in depth
    UI.toggleDropdown(); // close the user dropdown menu
    this._resetForm();
    this.onSemesterChange();
    $('admin-modal').classList.remove('hidden');
  },

  close() {
    $('admin-modal').classList.add('hidden');
  },

  handleOverlayClick(e) {
    if (e.target.id === 'admin-modal') this.close();
  },

  _resetForm() {
    this._selectedFile = null;
    $('admin-title').value = '';
    $('admin-category').value = 'summary';
    $('admin-file-input').value = '';
    $('admin-file-name').classList.add('hidden');
    $('admin-file-name').textContent = '';
    $('admin-file-drop-text').textContent = 'اضغط لاختيار ملف PDF أو اسحبه هنا';
    this._setStatus(null);
  },

  /** Repopulate the module dropdown whenever the semester changes */
  onSemesterChange() {
    const semester = parseInt($('admin-semester').value, 10);
    const modules  = Curriculum.modulesFor(semester) || [];
    const sel = $('admin-module');
    sel.innerHTML = modules.map(m =>
      `<option value="${escHtml(m.name)}">${escHtml(m.name)}</option>`
    ).join('');
    this._renderExistingList(semester);
  },

  onFileSelected(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== 'application/pdf') {
      this._setStatus('error', 'يُسمح فقط بملفات PDF');
      e.target.value = '';
      this._selectedFile = null;
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      this._setStatus('error', 'حجم الملف يتجاوز 50 ميجابايت');
      e.target.value = '';
      this._selectedFile = null;
      return;
    }
    this._selectedFile = file;
    $('admin-file-name').textContent = `📎 ${file.name}  (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
    $('admin-file-name').classList.remove('hidden');
    $('admin-file-drop-text').textContent = 'تم اختيار الملف — اضغط لتغييره';
    this._setStatus(null);
  },

  _setStatus(kind, text) {
    const bar     = $('admin-status-bar');
    const spinner = $('admin-status-spinner');
    const label   = $('admin-status-text');
    if (!kind) { bar.classList.remove('show', 'loading', 'success', 'error'); return; }
    bar.classList.add('show');
    bar.classList.remove('loading', 'success', 'error');
    bar.classList.add(kind);
    spinner.classList.toggle('hidden', kind !== 'loading');
    label.textContent = text;
  },

  async upload() {
    const semester   = parseInt($('admin-semester').value, 10);
    const moduleName = $('admin-module').value;
    const category   = $('admin-category').value;
    const title      = $('admin-title').value.trim();

    if (!moduleName) { this._setStatus('error', 'الرجاء اختيار مادة'); return; }
    if (!this._selectedFile) { this._setStatus('error', 'الرجاء اختيار ملف PDF'); return; }

    const btn = $('admin-submit-btn');
    btn.disabled = true;

    // Compress before upload: shrinks the file every student later
    // downloads, at the one-time cost of a few seconds here in the
    // admin's own browser. Falls back safely to the original file if
    // compression fails or doesn't actually help (see pdfCompressor.js).
    this._setStatus('loading', 'جارٍ ضغط الملف…');
    const originalSize = this._selectedFile.size;
    const fileToUpload = await PDFCompressor.compress(
      this._selectedFile,
      (msg) => this._setStatus('loading', msg)
    );
    const savedPct = originalSize > 0
      ? Math.round((1 - fileToUpload.size / originalSize) * 100)
      : 0;

    this._setStatus('loading', 'جارٍ الرفع… قد يستغرق ذلك بضع ثوانٍ');

    try {
      const form = new FormData();
      form.append('file', fileToUpload);
      form.append('semester', String(semester));
      form.append('module_name', moduleName);
      form.append('category', category);
      if (title) form.append('title', title);

      const { ok, json } = await Supabase.callFunctionMultipart('admin-upload-material', form);

      if (!ok || json?.error) {
        this._setStatus('error', json?.error || 'فشل الرفع. حاول مجدداً.');
        btn.disabled = false;
        return;
      }

      const savedMsg = savedPct > 0 ? ` (تم تقليل الحجم بنسبة ${savedPct}%)` : '';
      this._setStatus('success', `✅ تم الرفع بنجاح! الدرس متاح الآن للطلاب.${savedMsg}`);

      // Invalidate + reload the materials cache so the new PDF is
      // immediately clickable without requiring a logout/login.
      CourseMaterials.invalidate();
      await CourseMaterials.load();
      Modules.render(true);

      this._renderExistingList(semester);
      $('admin-file-input').value = '';
      this._selectedFile = null;
      $('admin-file-name').classList.add('hidden');
      $('admin-file-drop-text').textContent = 'اضغط لاختيار ملف PDF أو اسحبه هنا';

    } catch (err) {
      console.error('[AdminPanel.upload]', err);
      this._setStatus('error', 'خطأ في الشبكة. تحقق من اتصالك وحاول مجدداً.');
    } finally {
      btn.disabled = false;
    }
  },

  /** Small reference list of what's already registered for the selected semester */
  _renderExistingList(semester) {
    const list = $('admin-existing-list');
    if (!CourseMaterials._cache) { list.innerHTML = ''; return; }

    const labels = { summary: 'ملخص', full_lesson: 'درس كامل', guide: 'دليل' };
    const rows = [];
    for (const [key, val] of CourseMaterials._cache.entries()) {
      const [sem, mod, cat] = key.split(':');
      if (parseInt(sem, 10) !== semester) continue;
      rows.push({ id: val.id, mod, cat, title: val.title });
    }

    if (!rows.length) {
      list.innerHTML = '<div style="font-size:.78rem;color:var(--slate-400);text-align:center;padding:.5rem;">لا توجد ملفات مسجّلة بعد لهذا الفصل</div>';
      return;
    }

    list.innerHTML =
      '<div style="font-size:.75rem;font-weight:700;color:var(--slate-400);margin-bottom:.5rem;text-transform:uppercase;letter-spacing:.04em;">الملفات المسجَّلة حالياً</div>' +
      rows.map(r => `
        <div class="admin-existing-item" id="admin-item-${escHtml(r.id)}">
          <span class="name">${escHtml(r.title)}</span>
          <span class="badge">${escHtml(labels[r.cat] || r.cat)}</span>
          <button class="admin-delete-btn" title="حذف هذا الملف نهائياً"
                  onclick="App.AdminPanel.deleteMaterial('${escHtml(r.id)}', '${escHtml(r.title).replace(/'/g, "\\'")}')">🗑️</button>
        </div>
      `).join('');
  },

  /**
   * Permanently deletes a material: removes the PDF from storage and its
   * course_materials row, server-side, via the admin-delete-material Edge
   * Function (which independently re-checks the caller's email — see the
   * module header comment). Confirms first since this can't be undone.
   */
  async deleteMaterial(materialId, title) {
    if (!_isAuthorizedAdmin()) return; // defence in depth
    const confirmed = window.confirm(`سيتم حذف "${title}" نهائياً من التخزين وقاعدة البيانات. هذا الإجراء لا يمكن التراجع عنه.\n\nهل أنت متأكد؟`);
    if (!confirmed) return;

    const row = $(`admin-item-${materialId}`);
    const btn = row?.querySelector('.admin-delete-btn');
    if (btn) { btn.disabled = true; btn.textContent = '…'; }

    try {
      const { ok, json } = await Supabase.callFunction('admin-delete-material', { material_id: materialId });

      if (!ok || json?.error) {
        this._setStatus('error', json?.error || 'فشل الحذف. حاول مجدداً.');
        if (btn) { btn.disabled = false; btn.textContent = '🗑️'; }
        return;
      }

      this._setStatus('success', `✅ تم حذف "${title}" بنجاح.`);

      // Invalidate + reload so the deleted material disappears from the
      // student-facing module cards immediately too.
      CourseMaterials.invalidate();
      await CourseMaterials.load();
      Modules.render(true);

      const semester = parseInt($('admin-semester').value, 10);
      this._renderExistingList(semester);

    } catch (err) {
      console.error('[AdminPanel.deleteMaterial]', err);
      this._setStatus('error', 'خطأ في الشبكة. تحقق من اتصالك وحاول مجدداً.');
      if (btn) { btn.disabled = false; btn.textContent = '🗑️'; }
    }
  }
};

