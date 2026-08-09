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
import { BackNav } from './backNav.js';

function _isAuthorizedAdmin() {
  return State.currentProfile?.is_admin === true;
}

const MAX_GUIDE_IMAGE_BYTES = 10 * 1024 * 1024; // matches the guide-images bucket limit
const GUIDE_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export const AdminPanel = {
  _selectedFile: null,
  _selectedGuideImages: [], // File[] for the guide text+images upload path

  /** Show the admin button only for the one authorized account */
  refreshVisibility() {
    const btn = $('admin-dropdown-btn');
    if (btn) btn.classList.toggle('hidden', !_isAuthorizedAdmin());
    const memeBtn = $('meme-admin-dropdown-btn');
    if (memeBtn) memeBtn.classList.toggle('hidden', !_isAuthorizedAdmin());
  },

  open() {
    if (!_isAuthorizedAdmin()) return; // defence in depth
    UI.toggleDropdown(); // close the user dropdown menu
    this._resetForm(); // triggers onCategoryChange() -> onSemesterChange()
    $('admin-modal').classList.remove('hidden');
    BackNav.push(() => this.close());
  },

  close() {
    BackNav.notifyClose();
    $('admin-modal').classList.add('hidden');
  },

  handleOverlayClick(e) {
    if (e.target.id === 'admin-modal') this.close();
  },

  _resetForm() {
    this._selectedFile = null;
    this._selectedGuideImages = [];
    $('admin-title').value = '';
    $('admin-category').value = 'summary';
    $('admin-file-input').value = '';
    $('admin-file-name').classList.add('hidden');
    $('admin-file-name').textContent = '';
    $('admin-file-drop-text').textContent = 'اضغط لاختيار ملف PDF أو اسحبه هنا';
    $('admin-guide-text').value = '';
    $('admin-guide-images-input').value = '';
    $('admin-guide-images-preview').innerHTML = '';
    $('admin-guide-images-text').textContent = 'اضغط لاختيار صورة أو أكثر';
    $('admin-guide-replace-mode').checked = false;
    this._setStatus(null);
    this.onCategoryChange();
  },

  /** Switches the form between the PDF path and the guide text+images path. */
  onCategoryChange() {
    const category = $('admin-category').value;
    const isGuide = category === 'guide';
    $('admin-pdf-fields').classList.toggle('hidden', isGuide);
    $('admin-guide-fields').classList.toggle('hidden', !isGuide);
    $('admin-submit-btn').textContent = isGuide ? 'رفع الدليل الآن' : 'رفع الملف الآن';

    // "Both semesters" only makes sense for the Comprehensive Guide path
    // (PDFs are genuinely semester-specific files). Only offer it there,
    // and fall back to "Semester 1" if it was selected and the category
    // changed away from guide underneath it.
    const bothOption = $('admin-semester-both-option');
    bothOption.classList.toggle('hidden', !isGuide);
    if (!isGuide && $('admin-semester').value === 'both') {
      $('admin-semester').value = '1';
    }
    this.onSemesterChange();
  },

  onGuideImagesSelected(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    const rejected = [];
    const accepted = [];
    for (const file of files) {
      if (!GUIDE_IMAGE_MIME.includes(file.type)) { rejected.push(file.name); continue; }
      if (file.size > MAX_GUIDE_IMAGE_BYTES) { rejected.push(file.name); continue; }
      accepted.push(file);
    }

    this._selectedGuideImages = this._selectedGuideImages.concat(accepted);
    e.target.value = ''; // allow re-picking the same file name later

    if (rejected.length) {
      this._setStatus('error', `تم تجاهل ${rejected.length} صورة (نوع أو حجم غير مدعوم — الحد الأقصى 10 ميجابايت لكل صورة)`);
    }

    $('admin-guide-images-text').textContent =
      this._selectedGuideImages.length ? `تم اختيار ${this._selectedGuideImages.length} صورة — اضغط لإضافة المزيد` : 'اضغط لاختيار صورة أو أكثر';

    this._renderGuideImagePreviews();
  },

  _renderGuideImagePreviews() {
    const wrap = $('admin-guide-images-preview');
    wrap.innerHTML = '';
    this._selectedGuideImages.forEach((file, i) => {
      const thumb = document.createElement('div');
      thumb.style.cssText = 'position:relative;width:64px;height:64px;border-radius:8px;overflow:hidden;border:1px solid var(--slate-200,#e2e8f0);';

      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
      img.onload = () => URL.revokeObjectURL(img.src);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = '✕';
      removeBtn.title = 'إزالة';
      removeBtn.style.cssText = 'position:absolute;top:2px;right:2px;width:18px;height:18px;line-height:18px;padding:0;border:none;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;font-size:.65rem;cursor:pointer;';
      removeBtn.addEventListener('click', () => {
        this._selectedGuideImages.splice(i, 1);
        this._renderGuideImagePreviews();
        $('admin-guide-images-text').textContent =
          this._selectedGuideImages.length ? `تم اختيار ${this._selectedGuideImages.length} صورة — اضغط لإضافة المزيد` : 'اضغط لاختيار صورة أو أكثر';
      });

      thumb.appendChild(img);
      thumb.appendChild(removeBtn);
      wrap.appendChild(thumb);
    });
  },

  /** Repopulate the module dropdown whenever the semester changes */
  onSemesterChange() {
    const semesterVal = $('admin-semester').value;
    const sel = $('admin-module');

    if (semesterVal === 'both') {
      // Only list modules that actually have a same-subject counterpart
      // in the other semester (matched by name minus its trailing "1"/"2",
      // e.g. "Grammar 1" <-> "Grammar 2"). A couple of slots hold genuinely
      // different subjects across semesters (e.g. ICT vs. Computer Science)
      // and are deliberately excluded here — those must be uploaded per
      // semester individually.
      sel.innerHTML = this._pairedGuideModules().map(p =>
        `<option value="${escHtml(p.base)}">${escHtml(p.base)}</option>`
      ).join('');
      $('admin-existing-list').innerHTML = '';
      return;
    }

    const semester = parseInt(semesterVal, 10);
    const modules  = Curriculum.modulesFor(semester) || [];
    sel.innerHTML = modules.map(m =>
      `<option value="${escHtml(m.name)}">${escHtml(m.name)}</option>`
    ).join('');
    this._renderExistingList(semester);
  },

  /** Strips a trailing " 1" / " 2" (with any amount of leading whitespace) off a module name. */
  _baseModuleName(name) {
    return name.replace(/\s*[12]\s*$/, '').trim();
  },

  /**
   * Modules present in both Curriculum.SEMESTER_1 and SEMESTER_2 that share
   * the same subject (base name matches once the trailing semester digit is
   * stripped). Returns { base, s1Name, s2Name } for each match.
   */
  _pairedGuideModules() {
    const s1 = Curriculum.SEMESTER_1 || [];
    const s2 = Curriculum.SEMESTER_2 || [];
    const pairs = [];
    s1.forEach(m1 => {
      const base = this._baseModuleName(m1.name);
      const m2 = s2.find(m => this._baseModuleName(m.name) === base);
      if (m2) pairs.push({ base, s1Name: m1.name, s2Name: m2.name });
    });
    return pairs;
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
    const category = $('admin-category').value;
    if (category === 'guide') { await this._uploadGuide(); return; }

    const semester   = parseInt($('admin-semester').value, 10);
    const moduleName = $('admin-module').value;
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

  /**
   * Text + images path for the Comprehensive Guide. Unlike PDF uploads,
   * this always opens in the plain HTML content window (never the PDF
   * viewer) — the text becomes paragraphs and any images are appended
   * below them. By default this ADDS to whatever guide content already
   * exists for this module/semester (so images can be added below text
   * uploaded earlier); the "replace" checkbox overwrites it instead.
   */
  async _uploadGuide() {
    const semesterVal = $('admin-semester').value;
    const moduleName  = $('admin-module').value;
    const text        = $('admin-guide-text').value.trim();
    const mode        = $('admin-guide-replace-mode').checked ? 'replace' : 'append';

    if (!moduleName) { this._setStatus('error', 'الرجاء اختيار مادة'); return; }
    if (!text && this._selectedGuideImages.length === 0) {
      this._setStatus('error', 'الرجاء إدخال نص أو إضافة صورة واحدة على الأقل');
      return;
    }

    // "Both semesters" resolves the one base name shown in the dropdown
    // back to each semester's real module name and submits twice — once
    // per semester — with the exact same text/images/mode.
    let targets; // [{ semester, moduleName }]
    if (semesterVal === 'both') {
      const pair = this._pairedGuideModules().find(p => p.base === moduleName);
      if (!pair) { this._setStatus('error', 'تعذر إيجاد نظير هذه المادة في الفصل الآخر'); return; }
      targets = [{ semester: 1, moduleName: pair.s1Name }, { semester: 2, moduleName: pair.s2Name }];
    } else {
      targets = [{ semester: parseInt(semesterVal, 10), moduleName }];
    }

    const btn = $('admin-submit-btn');
    btn.disabled = true;
    this._setStatus('loading', this._selectedGuideImages.length ? 'جارٍ رفع الصور والنص…' : 'جارٍ الحفظ…');

    try {
      for (const target of targets) {
        const form = new FormData();
        form.append('semester', String(target.semester));
        form.append('module_name', target.moduleName);
        form.append('text', text);
        form.append('mode', mode);
        this._selectedGuideImages.forEach((file) => form.append('images', file));

        const { ok, json } = await Supabase.callFunctionMultipart('admin-upsert-guide', form);

        if (!ok || json?.error) {
          this._setStatus('error', `${json?.error || 'فشل الرفع.'} (الفصل ${target.semester} — ${target.moduleName})`);
          btn.disabled = false;
          return;
        }
      }

      const modeMsg = mode === 'replace' ? 'تم استبدال محتوى الدليل بنجاح!' : 'تمت إضافة المحتوى الجديد إلى الدليل بنجاح!';
      const scopeMsg = targets.length > 1 ? ' (للفصلين معاً)' : '';
      this._setStatus('success', `✅ ${modeMsg}${scopeMsg} يفتح الآن كنافذة مجانية لجميع الطلاب.`);
      $('admin-guide-text').value = '';
      this._selectedGuideImages = [];
      $('admin-guide-images-input').value = '';
      $('admin-guide-images-preview').innerHTML = '';
      $('admin-guide-images-text').textContent = 'اضغط لاختيار صورة أو أكثر';
      $('admin-guide-replace-mode').checked = false;

    } catch (err) {
      console.error('[AdminPanel._uploadGuide]', err);
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
    for (const [key, materials] of CourseMaterials._cache.entries()) {
      const [sem, mod, cat] = key.split(':');
      if (parseInt(sem, 10) !== semester) continue;
      // A slot can hold several files now (oldest -> newest); list
      // every one so nothing silently disappears from view.
      materials.forEach((val, i) => {
        rows.push({ id: val.id, mod, cat, title: val.title, order: i + 1, count: materials.length });
      });
    }

    if (!rows.length) {
      list.innerHTML = '<div style="font-size:.78rem;color:var(--slate-400);text-align:center;padding:.5rem;">لا توجد ملفات مسجّلة بعد لهذا الفصل</div>';
      return;
    }

    list.innerHTML =
      '<div style="font-size:.75rem;font-weight:700;color:var(--slate-400);margin-bottom:.5rem;text-transform:uppercase;letter-spacing:.04em;">الملفات المسجَّلة حالياً</div>' +
      rows.map(r => `
        <div class="admin-existing-item" id="admin-item-${escHtml(r.id)}">
          <span class="name">${escHtml(r.title)}${r.count > 1 ? ` <span style="color:var(--slate-400);font-weight:400;">(${r.order}/${r.count})</span>` : ''}</span>
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

