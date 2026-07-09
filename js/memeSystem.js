/* ═══════════════════════════════════════════════════════════════
   MEME SYSTEM
   ───────────────────────────────────────────────────────────────
   Manages the GPA-bracket meme feature entirely client-side.

   Privacy guarantees (immutable by design, not just policy):
   ─ GPA values, names, and grades never leave the browser.
     memeSystem.show(gpa, sem) receives a numeric GPA and selects
     a category; the GPA value itself is never sent anywhere.
   ─ The only outbound requests this module makes are:
       1. One JSON query to fetch active meme metadata on init.
       2. One media file request per meme shown (to load the video).
     Neither includes any student data whatsoever.
   ─ No localStorage, sessionStorage, cookies, IndexedDB, or any
     other persistence mechanism is used. Everything resets on refresh.
   ─ All GPA categorisation logic runs locally, in this file.
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
let _catalog  = null;   // Map<categoryKey, meme[]> | null=not yet loaded
let _loading  = false;
let _warmupEls = {};    // { [categoryKey]: HTMLVideoElement|HTMLImageElement }
let _currentCat = {};   // { [sem]: categoryKey } — tracks last displayed category

// ── Public API ────────────────────────────────────────────────────────────
export const MemeSystem = {

  /**
   * Fetch the active meme catalog in the background.
   * Called once from main.js (non-blocking — does not delay TTI/LCP).
   * After the catalog loads, warms up one media element per category
   * using preload="metadata" so subsequent plays load near-instantly.
   */
  async init() {
    if (_loading || _catalog) return;
    _loading = true;
    try {
      // Single lightweight query — returns only metadata (URLs, categories).
      // No student data is involved; this is equivalent to fetching a JSON
      // list of public assets.
      const { data, error } = await sb
        .from('memes')
        .select('id, category, file_url, title, content_type')
        .eq('active', true);

      if (error) {
        console.warn('[MemeSystem] catalog fetch failed:', error.message);
        _catalog = {};
        return;
      }

      // Group by category
      const map = {};
      for (const m of (data ?? [])) {
        if (!map[m.category]) map[m.category] = [];
        map[m.category].push(m);
      }
      _catalog = map;
      _warmup();

    } catch (err) {
      console.warn('[MemeSystem] init error:', err);
      _catalog = {};
    } finally {
      _loading = false;
    }
  },

  /**
   * Show the appropriate meme for a completed GPA in a semester's container.
   * Replaces the meme only when the GPA crosses a category boundary —
   * this avoids constant flickering while the user tweaks individual grades.
   *
   * @param {number} gpa  Computed semester average (0–20).
   * @param {number} sem  Semester number (1 or 2), used to find the DOM box.
   */
  show(gpa, sem) {
    const box = document.getElementById(`meme-box-${sem}`);
    if (!box) return;

    const category = _getCategory(gpa);

    // Same bracket and a meme is already visible — leave it playing
    if (_currentCat[sem] === category && box.querySelector('.meme-media')) return;
    _currentCat[sem] = category;

    if (!_catalog) {
      // Catalog is still loading (< 1 s normally) — show skeleton and retry
      _showSkeleton(box);
      _waitForCatalog(() => this.show(gpa, sem));
      return;
    }

    const memes = _catalog[category] ?? [];
    if (!memes.length) {
      // No memes uploaded for this bracket yet — hide cleanly
      box.innerHTML = '';
      box.classList.remove('meme-box--visible');
      return;
    }

    _renderMeme(box, _pickRandom(memes));
  },

  /**
   * Clear the meme box for a given semester (called when all grades are
   * cleared or the result is back to partial).
   */
  hide(sem) {
    delete _currentCat[sem];
    const box = document.getElementById(`meme-box-${sem}`);
    if (!box) return;
    // Release media resources before clearing
    const video = box.querySelector('video');
    if (video) { try { video.pause(); video.src = ''; } catch (_) {} }
    box.innerHTML = '';
    box.classList.remove('meme-box--visible');
  },

  /**
   * Force-refresh the catalog after admin changes (upload / delete / toggle).
   * Clears the prewarmed elements so they're rebuilt from fresh data.
   */
  async refresh() {
    _catalog  = null;
    _warmupEls = {};
    _currentCat = {};
    await this.init();
  },
};

// ── Private helpers ───────────────────────────────────────────────────────

function _getCategory(gpa) {
  for (const { key, min, max } of BRACKETS) {
    if (gpa >= min && gpa <= max) return key;
  }
  return 'cat_below_8'; // safe fallback
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
  if (tries > 30) return; // give up after ~3 s
  setTimeout(() => _waitForCatalog(cb, tries + 1), 100);
}

function _renderMeme(box, meme) {
  const isVideo = (meme.content_type ?? '').startsWith('video/');

  // Tear down any existing media to release decoder resources
  const existing = box.querySelector('video');
  if (existing) { try { existing.pause(); existing.src = ''; } catch (_) {} }
  box.innerHTML = '';

  if (isVideo) {
    // Prefer the pre-warmed element (already has metadata buffered)
    const prewarmed = _warmupEls[meme.category];
    const reusePrewarm = prewarmed instanceof HTMLVideoElement
      && prewarmed.dataset.memeId === meme.id;

    const video = reusePrewarm ? prewarmed : document.createElement('video');
    video.src         = meme.file_url;
    video.className   = 'meme-media';
    video.controls    = false;
    video.playsInline = true;
    video.preload     = 'auto';
    video.loop        = false;

    // First play: with sound.
    // After ended: loop silently forever.
    video.muted = false;
    video.addEventListener('ended', () => {
      video.muted = true;
      video.loop  = true;
      video.play().catch(() => {});
    }, { once: true });

    // Trigger play; fall back to muted if the browser blocks unmuted autoplay
    video.autoplay = true;
    const playPromise = video.play();
    if (playPromise !== undefined) {
      playPromise.catch(() => {
        video.muted = true;
        video.loop  = true;
        video.play().catch(() => {});
      });
    }

    box.appendChild(video);

  } else {
    // GIF — loops automatically, no sound (by nature)
    const img = document.createElement('img');
    img.src       = meme.file_url;
    img.alt       = meme.title ?? 'GPA meme';
    img.className = 'meme-media';
    img.loading   = 'eager';
    img.decoding  = 'async';
    box.appendChild(img);
  }

  // Optional title caption
  if (meme.title) {
    const caption = document.createElement('div');
    caption.className   = 'meme-caption';
    caption.textContent = meme.title;
    box.appendChild(caption);
  }

  box.classList.add('meme-box--visible');
}

/**
 * After the catalog loads, prime one media element per category using
 * preload="metadata". This opens the TCP connection and downloads the
 * first few kilobytes (container headers) without fetching the full file.
 * When the user actually gets a GPA result, the video starts near-instantly
 * because the connection is already warm.
 *
 * For GIFs, we insert a <link rel="prefetch"> hint and create an in-memory
 * Image (which also primes the decode cache).
 *
 * This is intentionally LOW-priority — browsers schedule prefetch/preload
 * at idle time, so it doesn't compete with visible page content.
 */
function _warmup() {
  if (!_catalog) return;
  for (const [cat, memes] of Object.entries(_catalog)) {
    if (!memes.length) continue;
    const pick = _pickRandom(memes);

    if ((pick.content_type ?? '').startsWith('video/')) {
      const v = document.createElement('video');
      v.preload      = 'metadata';
      v.muted        = true;     // must be muted for background preload
      v.src          = pick.file_url;
      v.dataset.memeId = pick.id;
      // Element stays in memory only — NOT appended to DOM —
      // so it primes the network/decode cache without causing any reflows.
      _warmupEls[cat] = v;

    } else {
      // GIF prefetch hint
      const link = document.createElement('link');
      link.rel  = 'prefetch';
      link.href = pick.file_url;
      link.as   = 'image';
      document.head.appendChild(link);
      // In-memory Image primes the decode cache
      const img = new Image();
      img.src = pick.file_url;
      _warmupEls[cat] = img;
    }
  }
}
