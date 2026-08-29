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
     (This is about WHICH files get downloaded, not WHEN a chosen
     file starts playing — see _renderMeme() below, which now waits
     for that one already-chosen file to fully buffer before playback
     starts, to avoid stutter. Still exactly one network request per
     meme shown, at the same moment as before; nothing is fetched
     speculatively.)
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

// Guards against a slow-to-buffer meme popping in after the user has
// already moved to a different GPA bracket (or cleared the form) while
// it was loading. Keyed per meme-box element rather than globally,
// since sem 1 and sem 2 render independently.
const _renderTokens = new WeakMap();

// How long to wait for a meme to fully buffer/decode before showing it
// anyway with whatever's ready — protects against a slow/flaky mobile
// connection leaving the calculator stuck on a skeleton indefinitely.
const MEDIA_READY_TIMEOUT_MS = 2500;

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
    // Invalidate any preload still buffering in the background for this
    // box, so it can't pop in after the fact once the form was cleared.
    _renderTokens.set(box, (_renderTokens.get(box) || 0) + 1);
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
 *
 * Fully buffers/decodes the file OFF-DOM first (see _prepareVideo /
 * _prepareImage below) and only swaps it into the visible box once
 * ready, instead of setting .src on a live, already-inserted element
 * and calling .play() immediately. That immediate-play pattern is what
 * caused the stutter/frame-drop the first time a given meme loaded on
 * a fresh connection — the browser was decoding and rendering frames
 * while still downloading the rest of the file at the same time.
 */
async function _renderMeme(box, meme) {
  const myToken = (_renderTokens.get(box) || 0) + 1;
  _renderTokens.set(box, myToken);
  const stillCurrent = () => _renderTokens.get(box) === myToken;

  _showSkeleton(box);

  const isVideo = (meme.content_type ?? '').startsWith('video/');

  let mediaEl;
  try {
    mediaEl = isVideo ? await _prepareVideo(meme) : await _prepareImage(meme);
  } catch (err) {
    console.warn('[MemeSystem] media failed to load:', err);
    if (stillCurrent()) {
      box.innerHTML = '';
      box.classList.remove('meme-box--visible');
    }
    return;
  }

  if (!stillCurrent()) {
    // Superseded while buffering (bracket changed again, or the form
    // was cleared) — release what we just loaded and let whichever
    // render owns the box now stand untouched.
    if (isVideo) { try { mediaEl.pause(); mediaEl.src = ''; } catch (_) {} }
    return;
  }

  box.innerHTML = '';
  box.appendChild(mediaEl);

  if (meme.title) {
    const caption = document.createElement('div');
    caption.className   = 'meme-caption';
    caption.textContent = meme.title;
    box.appendChild(caption);
  }

  box.classList.add('meme-box--visible');

  if (isVideo) _playVideo(mediaEl);
}

/**
 * Builds a <video> off-DOM and resolves once it's buffered enough to
 * play through smoothly (or a timeout elapses, so a slow connection
 * can't hang this forever — it just plays with whatever's ready).
 * Does NOT start playback; the caller decides when to insert + play.
 */
function _prepareVideo(meme) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.className   = 'meme-media';
    video.controls    = false;
    video.playsInline  = true;
    video.setAttribute('webkit-playsinline', ''); // older iOS Safari
    video.loop        = false;
    video.muted       = false;   // first play is with sound — see _playVideo()
    video.preload     = 'auto';  // ask the browser to buffer ahead, not just enough to start

    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('canplaythrough', onReady);
      video.removeEventListener('error', onError);
    };
    const onReady = () => { if (settled) return; settled = true; cleanup(); resolve(video); };
    const onError = () => { if (settled) return; settled = true; cleanup(); reject(new Error('video failed to load')); };

    video.addEventListener('canplaythrough', onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
    const timer = setTimeout(onReady, MEDIA_READY_TIMEOUT_MS);

    video.src = meme.file_url; // ← first and only network request for this meme
    // Already buffered enough (e.g. served from the browser's own HTTP
    // cache on a repeat view) — fires immediately, no need to wait.
    if (video.readyState >= 4) onReady();
  });
}

/**
 * Loads + decodes an <img> off-DOM and resolves once it's ready to
 * paint without a mid-decode pop-in — this matters most for animated
 * GIFs, which otherwise can appear to freeze or glitch for a beat
 * right as they're inserted while still downloading.
 */
function _prepareImage(meme) {
  return new Promise((resolve, reject) => {
    const img = document.createElement('img');
    img.alt       = meme.title ?? 'GPA meme';
    img.className = 'meme-media';
    img.decoding  = 'async';

    let settled = false;
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(img); };
    const fail   = () => { if (settled) return; settled = true; clearTimeout(timer); reject(new Error('image failed to load')); };

    img.src = meme.file_url; // ← first and only network request for this meme

    // decode() resolves once the browser has downloaded and decoded the
    // image well enough to paint it. Some older/mobile browsers don't
    // fully support decode() for animated GIFs, so fall back to the
    // plain load event rather than rejecting outright.
    img.decode().then(finish).catch(() => {
      if (img.complete) { finish(); return; }
      img.addEventListener('load', finish, { once: true });
      img.addEventListener('error', fail, { once: true });
    });

    const timer = setTimeout(finish, MEDIA_READY_TIMEOUT_MS);
  });
}

/** Starts playback on an already-buffered, already-inserted <video>. */
function _playVideo(video) {
  // First play: with sound.
  // After it ends: loop silently (no re-download — already buffered).
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
}
