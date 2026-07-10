/* ═══════════════════════════════════════════════════════════════
   MEME SYSTEM  —  data-efficient, on-demand only
   ───────────────────────────────────────────────────────────────
   Privacy & data guarantees:
   ─ GPA values, names, grades never leave the browser.
     show(gpa, sem) resolves the category locally; the number
     is never sent in any network request.
   ─ Network activity is strictly limited to:
       1. One lightweight JSON query on init (~2–5 KB total)
          to fetch the list of meme URLs + categories.
       2. One media file per meme actually shown to the user.
     Nothing is downloaded speculatively or in the background.
   ─ No preloading, no prefetching, no warmup requests.
     Media only loads when the user has a GPA result on screen.
   ─ No localStorage, sessionStorage, cookies, or any persistence.
     Everything resets on page refresh.
═══════════════════════════════════════════════════════════════ */
import { sb } from './supabaseClient.js';

// ── GPA bracket → DB category key ────────────────────────────────────────
// Checked top-to-bottom; first match wins. GPA is on the Algerian /20 scale.
const BRACKETS = [
  { key: 'cat_16_plus',        min: 16.00, max:  20.00 },
  { key: 'cat_15_to_15_99',    min: 15.00, max:  15.999 },
  { key: 'cat_13_51_to_14_99', min: 13.51, max:  14.999 },
  { key: 'cat_12_01_to_13_50', min: 12.01, max:  13.500 },
  { key: 'cat_10_51_to_12',    min: 10.51, max:  12.000 },
  { key: 'cat_10_to_10_50',    min: 10.00, max:  10.500 },
  { key: 'cat_9_51_to_9_99',   min:  9.51, max:   9.999 },
  { key: 'cat_8_to_9_50',      min:  8.00, max:   9.500 },
  { key: 'cat_below_8',        min:  0,    max:   7.999 },
];

// ── Module-level state (session-only, no persistence) ────────────────────
let _catalog    = null;   // Map<categoryKey, meme[]> | null = not yet loaded
let _loading    = false;
let _currentCat = {};     // { [sem]: categoryKey } — last displayed bracket

// ── Public API ────────────────────────────────────────────────────────────
export const MemeSystem = {

  /**
   * Fetch active meme metadata in the background.
   * Downloads only a small JSON response (~2–5 KB) — no media files.
   * Called once from main.js; non-blocking (does not delay TTI/LCP).
   */
  async init() {
    if (_loading || _catalog) return;
    _loading = true;
    try {
      const { data, error } = await sb
        .from('memes')
        .select('id, category, file_url, title, content_type')
        .eq('active', true);

      if (error) {
        console.warn('[MemeSystem] catalog fetch failed:', error.message);
        _catalog = {};
        return;
      }

      // Group by category — only URLs and category keys, no student data
      const map = {};
      for (const m of (data ?? [])) {
        if (!map[m.category]) map[m.category] = [];
        map[m.category].push(m);
      }
      _catalog = map;

      // ── No warmup / preload / prefetch ────────────────────────────────
      // Media files are only requested when the user actually receives a
      // GPA result and a meme needs to be shown. Nothing is downloaded
      // speculatively — this is intentional to avoid consuming mobile data
      // for content the user may never see.

    } catch (err) {
      console.warn('[MemeSystem] init error:', err);
      _catalog = {};
    } finally {
      _loading = false;
    }
  },

  /**
   * Show the appropriate meme for a completed GPA result.
   * The meme replaces only when the GPA crosses a category boundary,
   * avoiding repeated media requests while the user edits individual grades.
   *
   * @param {number} gpa  Computed semester average (0–20).
   * @param {number} sem  Semester number (1 or 2).
   */
  show(gpa, sem) {
    const box = document.getElementById(`meme-box-${sem}`);
    if (!box) return;

    const category = _getCategory(gpa);

    // Same bracket + meme already playing → leave it, save data
    if (_currentCat[sem] === category && box.querySelector('.meme-media')) return;
    _currentCat[sem] = category;

    if (!_catalog) {
      // Catalog still loading (rare — usually resolves in < 1 s)
      _showSkeleton(box);
      _waitForCatalog(() => this.show(gpa, sem));
      return;
    }

    const memes = _catalog[category] ?? [];
    if (!memes.length) {
      // No memes uploaded for this bracket yet
      box.innerHTML = '';
      box.classList.remove('meme-box--visible');
      return;
    }

    _renderMeme(box, _pickRandom(memes));
  },

  /**
   * Clear the meme box (called when grades are cleared or result is partial).
   */
  hide(sem) {
    delete _currentCat[sem];
    const box = document.getElementById(`meme-box-${sem}`);
    if (!box) return;
    const video = box.querySelector('video');
    if (video) { try { video.pause(); video.src = ''; } catch (_) {} }
    box.innerHTML = '';
    box.classList.remove('meme-box--visible');
  },

  /**
   * Force-refresh the catalog after admin changes.
   * Downloads the catalog JSON again (~2–5 KB); no media files.
   */
  async refresh() {
    _catalog    = null;
    _currentCat = {};
    await this.init();
  },
};

// ── Private helpers ───────────────────────────────────────────────────────

function _getCategory(gpa) {
  for (const { key, min, max } of BRACKETS) {
    if (gpa >= min && gpa <= max) return key;
  }
  return 'cat_below_8';
}

function _pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function _showSkeleton(box) {
  box.innerHTML = '<div class="meme-skeleton"></div>';
  box.classList.add('meme-box--visible');
}

function _waitForCatalog(cb, tries = 0) {
  if (_catalog !== null) { cb(); return; }
  if (tries > 30) return;
  setTimeout(() => _waitForCatalog(cb, tries + 1), 100);
}

/**
 * Create and mount the media element for a meme.
 * This is the ONLY point where a media file is requested from the network —
 * and only because the user has an actual GPA result on screen.
 */
function _renderMeme(box, meme) {
  const isVideo = (meme.content_type ?? '').startsWith('video/');

  // Release any previous media to free decoder memory
  const prev = box.querySelector('video');
  if (prev) { try { prev.pause(); prev.src = ''; } catch (_) {} }
  box.innerHTML = '';

  if (isVideo) {
    const video = document.createElement('video');
    video.src         = meme.file_url;   // ← first and only network request for this meme
    video.className   = 'meme-media';
    video.controls    = false;
    video.playsInline = true;
    video.loop        = false;

    // First play: with sound.
    // After it ends: loop silently (no re-download — already buffered).
    video.muted = false;
    video.addEventListener('ended', () => {
      video.muted = true;
      video.loop  = true;
      video.play().catch(() => {});
    }, { once: true });

    video.autoplay = true;
    const p = video.play();
    if (p !== undefined) {
      // Fallback: some browsers block unmuted autoplay (especially mobile)
      p.catch(() => {
        video.muted = true;
        video.loop  = true;
        video.play().catch(() => {});
      });
    }

    box.appendChild(video);

  } else {
    // GIF — loops automatically, no sound
    const img = document.createElement('img');
    img.src       = meme.file_url;   // ← first and only network request for this meme
    img.alt       = meme.title ?? 'GPA meme';
    img.className = 'meme-media';
    img.loading   = 'lazy';     // don't decode until visible
    img.decoding  = 'async';
    box.appendChild(img);
  }

  if (meme.title) {
    const caption = document.createElement('div');
    caption.className   = 'meme-caption';
    caption.textContent = meme.title;
    box.appendChild(caption);
  }

  box.classList.add('meme-box--visible');
}
