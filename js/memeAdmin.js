/* ═══════════════════════════════════════════════════════════════
   MEME ADMIN PANEL
   ───────────────────────────────────────────────────────────────
   No-code interface for managing the meme catalog per GPA bracket.
   Auth boundary (client): is_admin profile flag — UI gate only.
   Auth boundary (server): ADMIN_EMAIL secret checked independently
   in every Edge Function before any storage or DB write.
═══════════════════════════════════════════════════════════════ */
import { $, escHtml } from './dom.js';
import { State } from './state.js';
import { Supabase, sb } from './supabaseClient.js';
import { MemeSystem } from './memeSystem.js';

// ── Category metadata (display labels for the UI) ─────────────────────────
export const MEME_CATEGORIES = [
  { key: 'cat_below_8',        label: 'Below 8.00',       emoji: '😱' },
  { key: 'cat_8_to_9_50',      label: '8.00 – 9.50',      emoji: '😬' },
  { key: 'cat_9_51_to_9_99',   label: '9.51 – 9.99',      emoji: '😅' },
  { key: 'cat_10_to_10_50',    label: '10.00 – 10.50',    emoji: '😌' },
  { key: 'cat_10_51_to_12',    label: '10.51 – 12.00',    emoji: '😊' },
  { key: 'cat_12_01_to_13_50', label: '12.01 – 13.50',    emoji: '👍' },
  { key: 'cat_13_51_to_14_99', label: '13.51 – 14.99',    emoji: '✨' },
  { key: 'cat_15_to_15_99',    label: '15.00 – 15.99',    emoji: '🏆' },
  { key: 'cat_16_plus',        label: '16.00+',            emoji: '🎓' },
];

function _isAuthorizedAdmin() {
  return State.currentProfile?.is_admin === true;
}

export const MemeAdmin = {
  _selectedFile:   null,
  _activeCategory: MEME_CATEGORIES[0].key,
  _allMemes:       [],   // full list from DB (includes inactive, for admin view)

  // ── Open / close ─────────────────────────────────────────────────────
  open() {
    if (!_isAuthorizedAdmin()) return;
    $('meme-admin-modal').classList.remove('hidden');
    this._loadAll();
  },

  close() {
    $('meme-admin-modal').classList.add('hidden');
    this._resetUploadForm();
  },

  handleOverlayClick(e) {
    if (e.target.id === 'meme-admin-modal') this.close();
  },

  // ── Category tab selection ────────────────────────────────────────────
  selectCategory(key) {
    this._activeCategory = key;
    MEME_CATEGORIES.forEach(({ key: k }) => {
      const btn = $(`meme-cat-btn-${k}`);
      if (btn) btn.classList.toggle('meme-cat-tab--active', k === key);
    });
    const catSel = $('meme-upload-category');
    if (catSel) catSel.value = key;
    this._renderMemeGrid();
  },

  // ── Load all memes (admin sees all, including inactive) ───────────────
  async _loadAll() {
    const grid = $('meme-admin-grid');
    if (grid) grid.innerHTML = '<div class="meme-admin-empty">جارٍ التحميل…</div>';

    try {
      const { data, error } = await sb
        .from('memes')
        .select('id, category, file_url, title, content_type, active, created_at')
        .order('created_at', { ascending: false });

      if (error) throw error;
      this._allMemes = data ?? [];
      this._renderCategoryTabs();
      this._renderMemeGrid();
    } catch (err) {
      console.error('[MemeAdmin._loadAll]', err);
      if (grid) grid.innerHTML = '<div class="meme-admin-empty">خطأ في التحميل</div>';
    }
  },

  // ── Render the scrollable category tab bar ───────────────────────────
  _renderCategoryTabs() {
    const tabs = $('meme-cat-tabs');
    if (!tabs) return;
    tabs.innerHTML = MEME_CATEGORIES.map(({ key, label, emoji }) => {
      const count  = this._allMemes.filter(m => m.category === key).length;
      const active = key === this._activeCategory;
      return `<button
        class="meme-cat-tab${active ? ' meme-cat-tab--active' : ''}"
        id="meme-cat-btn-${escHtml(key)}"
        onclick="App.MemeAdmin.selectCategory('${escHtml(key)}')"
      >${emoji} ${escHtml(label)} <span class="meme-cat-count">${count}</span></button>`;
    }).join('');
  },

  // ── Render the meme grid for the active category ─────────────────────
  _renderMemeGrid() {
    const grid = $('meme-admin-grid');
    if (!grid) return;

    const memes = this._allMemes.filter(m => m.category === this._activeCategory);

    if (!memes.length) {
      grid.innerHTML = `<div class="meme-admin-empty">
        لا توجد ميمات في هذه الفئة بعد.<br>
        ارفع أول ميم باستخدام النموذج أعلاه.
      </div>`;
      return;
    }

    grid.innerHTML = memes.map(m => {
      const isVideo    = (m.content_type ?? '').startsWith('video/');
      const inactiveCs = m.active ? '' : ' meme-admin-item--inactive';
      const safeTitle  = escHtml(m.title ?? '');
      const escapedTitleJs = (m.title ?? '').replace(/'/g, "\\'");

      const preview = isVideo
        ? `<video class="meme-admin-preview" src="${escHtml(m.file_url)}"
               muted loop autoplay playsinline preload="metadata"></video>`
        : `<img class="meme-admin-preview" src="${escHtml(m.file_url)}"
              alt="${safeTitle}" loading="lazy" decoding="async" />`;

      return `
        <div class="meme-admin-item${inactiveCs}" id="meme-admin-item-${escHtml(m.id)}">
          <div class="meme-admin-preview-wrap">${preview}</div>
          <div class="meme-admin-item-info">
            <div class="meme-admin-item-title">${safeTitle || '<em style="opacity:.5">بدون عنوان</em>'}</div>
            <div class="meme-admin-item-meta">${escHtml(m.content_type)} · ${m.active ? '✅ مفعّل' : '⏸️ معطّل'}</div>
          </div>
          <div class="meme-admin-item-actions">
            <button class="meme-admin-action-btn meme-admin-toggle-btn"
                    title="${m.active ? 'تعطيل' : 'تفعيل'}"
                    onclick="App.MemeAdmin.toggleMeme('${escHtml(m.id)}', ${!m.active})"
            >${m.active ? '⏸️ تعطيل' : '▶️ تفعيل'}</button>
            <button class="meme-admin-action-btn meme-admin-delete-btn"
                    title="حذف نهائياً"
                    onclick="App.MemeAdmin.deleteMeme('${escHtml(m.id)}', '${escHtml(escapedTitleJs)}')"
            >🗑️</button>
          </div>
        </div>`;
    }).join('');
  },

  // ── File picker ───────────────────────────────────────────────────────
  onFileSelected(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    const ALLOWED = ['video/mp4', 'video/webm', 'image/gif'];
    if (!ALLOWED.includes(file.type)) {
      this._setStatus('error', 'يُسمح فقط بـ MP4 أو WebM أو GIF');
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
    if (file.size === 0) {
      this._setStatus('error', 'الملف فارغ');
      e.target.value = '';
      this._selectedFile = null;
      return;
    }

    this._selectedFile = file;
    const nameEl = $('meme-file-name');
    nameEl.textContent = `📎 ${file.name}  (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
    nameEl.classList.remove('hidden');
    $('meme-file-drop-text').textContent = 'تم الاختيار — اضغط لتغييره';
    this._setStatus(null);
  },

  // ── Upload ─────────────────────────────────────────────────────────────
  async upload() {
    if (!_isAuthorizedAdmin()) return;
    const category = $('meme-upload-category').value;
    const title    = ($('meme-upload-title').value ?? '').trim();

    if (!this._selectedFile) {
      this._setStatus('error', 'الرجاء اختيار ملف أولاً');
      return;
    }

    const btn = $('meme-upload-btn');
    btn.disabled = true;
    this._setStatus('loading', 'جارٍ الرفع…');

    try {
      const form = new FormData();
      form.append('file', this._selectedFile);
      form.append('category', category);
      if (title) form.append('title', title);

      const { ok, json } = await Supabase.callFunctionMultipart('admin-upload-meme', form);

      if (!ok || json?.error) {
        this._setStatus('error', json?.error ?? 'فشل الرفع. حاول مجدداً.');
        return;
      }

      this._setStatus('success', '✅ تم رفع الميم بنجاح!');
      this._resetUploadForm();

      if (json.meme) {
        // Prepend to local list and switch to that category tab
        this._allMemes.unshift(json.meme);
        this._activeCategory = json.meme.category;
        this._renderCategoryTabs();
        this._renderMemeGrid();
        // Refresh live catalog so students see it immediately
        await MemeSystem.refresh();
      }
    } catch (err) {
      console.error('[MemeAdmin.upload]', err);
      this._setStatus('error', 'خطأ في الشبكة. تحقق من الاتصال.');
    } finally {
      btn.disabled = false;
    }
  },

  // ── Toggle active / inactive ──────────────────────────────────────────
  async toggleMeme(memeId, newActive) {
    if (!_isAuthorizedAdmin()) return;
    const item = $(`meme-admin-item-${memeId}`);
    if (item) item.style.opacity = '0.45';

    try {
      const { ok, json } = await Supabase.callFunction('admin-toggle-meme', {
        meme_id: memeId,
        active: newActive,
      });

      if (!ok || json?.error) {
        this._setStatus('error', json?.error ?? 'فشل التحديث');
        if (item) item.style.opacity = '';
        return;
      }

      const idx = this._allMemes.findIndex(m => m.id === memeId);
      if (idx !== -1) this._allMemes[idx].active = newActive;
      this._renderCategoryTabs();
      this._renderMemeGrid();
      await MemeSystem.refresh();
    } catch (err) {
      console.error('[MemeAdmin.toggleMeme]', err);
      if (item) item.style.opacity = '';
    }
  },

  // ── Delete ─────────────────────────────────────────────────────────────
  async deleteMeme(memeId, title) {
    if (!_isAuthorizedAdmin()) return;
    const label = title || 'هذا الميم';
    if (!confirm(`سيتم حذف "${label}" نهائياً من التخزين وقاعدة البيانات.\nلا يمكن التراجع عن هذا الإجراء.\n\nهل أنت متأكد؟`)) return;

    const item = $(`meme-admin-item-${memeId}`);
    if (item) { item.style.opacity = '0.35'; item.style.pointerEvents = 'none'; }

    try {
      const { ok, json } = await Supabase.callFunction('admin-delete-meme', { meme_id: memeId });

      if (!ok || json?.error) {
        this._setStatus('error', json?.error ?? 'فشل الحذف');
        if (item) { item.style.opacity = ''; item.style.pointerEvents = ''; }
        return;
      }

      this._allMemes = this._allMemes.filter(m => m.id !== memeId);
      this._renderCategoryTabs();
      this._renderMemeGrid();
      this._setStatus('success', `✅ تم حذف "${label}" بنجاح.`);
      await MemeSystem.refresh();
    } catch (err) {
      console.error('[MemeAdmin.deleteMeme]', err);
      if (item) { item.style.opacity = ''; item.style.pointerEvents = ''; }
    }
  },

  // ── Helpers ────────────────────────────────────────────────────────────
  _resetUploadForm() {
    this._selectedFile = null;
    const t = $('meme-upload-title');
    if (t) t.value = '';
    const fi = $('meme-file-input');
    if (fi) fi.value = '';
    const fn = $('meme-file-name');
    if (fn) { fn.classList.add('hidden'); fn.textContent = ''; }
    const dt = $('meme-file-drop-text');
    if (dt) dt.textContent = 'اضغط لاختيار ملف MP4 / WebM / GIF أو اسحبه هنا';
    this._setStatus(null);
  },

  _setStatus(kind, text) {
    const bar  = $('meme-status-bar');
    const spin = $('meme-status-spinner');
    const lbl  = $('meme-status-text');
    if (!bar) return;
    if (!kind) { bar.classList.remove('show', 'loading', 'success', 'error'); return; }
    bar.classList.add('show');
    bar.classList.remove('loading', 'success', 'error');
    bar.classList.add(kind);
    if (spin) spin.classList.toggle('hidden', kind !== 'loading');
    if (lbl)  lbl.textContent = text ?? '';
  },
};
