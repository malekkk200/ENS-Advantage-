/* ═══════════════════════════════════════════════════════════════
   SECURE PDF VIEWER — continuous vertical scroll
   ───────────────────────────────────────────────────────────────
   Canvas-based PDF renderer (primary content-delivery path). PDF.js
   (window.pdfjsLib) is loaded via the UMD CDN <script> tag in
   index.html. Uses its own internal `_el()` DOM helper rather than
   the shared `$` from dom.js — kept as-is from the original file.

   Renders every page as its own <canvas> inside a stacked
   `.pdf-pages-container`, so the whole document scrolls naturally
   with one continuous finger-drag/wheel gesture (like Google Drive)
   instead of a one-page-at-a-time carousel. Pages are lazily
   rendered via IntersectionObserver as they approach the viewport —
   important for longer PDFs, since rasterizing 100+ pages up front
   would be slow and memory-heavy for no benefit.
═══════════════════════════════════════════════════════════════ */
import { sb } from './supabaseClient.js';
import { State } from './state.js';
import { lockBodyScroll, unlockBodyScroll } from './dom.js';
import { BackNav } from './backNav.js';
import { MaterialCache } from './materialCache.js';
import { PDFExtras } from './pdfExtras.js';

// Initialise the PDF.js worker source immediately — this avoids a
// small delay on first open because the worker script starts loading
// in the background as soon as the module is parsed.
if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

/* ─────────────────────────────────────────────────────────────
   SECURE PDF VIEWER
   ─────────────────────────────────────────────────────────────
   Architecture:
     1. open() → immediately shows skeleton + the overlay
     2. For content already opened once on this device (see
        materialCache.js — this now covers both free summaries and
        paid full lessons), the document's bytes are read straight
        from an AES-256-GCM encrypted on-device cache — no network,
        no Edge Function round trip, works fully offline.
     3. Otherwise: calls the get-material-url Edge Function, which
        creates a 90-second-TTL signed URL as the requesting user
        (so storage RLS is still the real gate — a denied user gets
        an error, never a URL) and logs every attempt to
        security_logs, soft-throttling abnormal request bursts from
        one account before they reach storage.
     4. The signed URL (or the decrypted cached bytes) is handed to
        PDF.js getDocument(). PDF.js streams/parses the file; the raw
        bytes never appear in the DOM as a blob or data-URI — they
        live only in PDF.js' own internal buffer (or, for a cache
        hit, a function-local ArrayBuffer that's never assigned
        anywhere it would outlive this call).
     5. _buildPages() → creates one wrapper+canvas per page, sized
        from that page's real aspect ratio, and wires an
        IntersectionObserver that renders each page's canvas only
        once it scrolls near the viewport.
     6. A scroll listener (rAF-throttled) tracks which page is
        currently in view, to keep the page-number field and the
        "resume where you left off" position in sync as the user
        scrolls — not just when they tap next/prev.
     7. Focus/visibility listeners blur the whole pages container
        when the window loses focus, making screenshots harder and
        signalling users they should stay inside the platform.
───────────────────────────────────────────────────────────── */
export const PDFViewer = (() => {
  // ── Internal state ────────────────────────────────────────
  let _pdfDoc      = null;   // pdf.js PDFDocumentProxy
  let _curPage     = 1;      // the page currently most visible in the scroll viewport
  let _totalPages  = 0;
  let _zoomLevel   = 1.0;    // multiplier on top of "fit-width" base scale
  let _baseScale   = 1.0;    // computed once per document load, from page 1
  let _materialId  = null;   // current document's DB id — used as the reading-progress key
  let _pages       = [];     // [{ wrapper, canvas, wm, rendered, width, height }] — index 0 = page 1
  let _observer    = null;   // IntersectionObserver — lazy-renders pages as they approach view
  let _scrollRaf   = null;   // rAF handle for the throttled scroll handler
  let _saveTimer   = null;   // debounce handle for progress-saving while scrolling
  let _programmaticScroll = false; // true while we're scrolling the zone ourselves (goto/resume)
  let _openToken   = 0;      // bumped on every open() call — lets a stale, still-in-flight
                              // open() (e.g. user closed and reopened a different lesson
                              // before the first one's network calls finished) detect that
                              // it's no longer the current request and stop before it can
                              // clobber the newer one's state/UI.
  const ZOOM_STEPS = [0.5, 0.6, 0.75, 0.9, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0];
  const RENDER_MARGIN = '1200px 0px'; // preload ~1.5 screens above/below the viewport

  // ── Private helpers ───────────────────────────────────────
  function _el(id)  { return document.getElementById(id); }

  function _showState(state) {
    // state: 'skeleton' | 'error' | 'pages'
    _el('pdf-skeleton').classList.toggle('hidden', state !== 'skeleton');
    _el('pdf-error').classList.toggle('hidden', state !== 'error');
    _el('pdf-pages-container').classList.toggle('hidden', state !== 'pages');
  }

  function _setError(msg) {
    _el('pdf-err-msg').textContent = msg || 'Could not load document.';
    _showState('error');
  }

  /* ── Reading-progress persistence ──────────────────────────
     "Resume where you left off" — keyed per user *and* per document
     so it can't leak across accounts on a shared/public browser.
     Stored client-side (localStorage) rather than in Supabase: it's
     a pure convenience feature with no access-control implications,
     so a lightweight client-only implementation is the right amount
     of complexity here. (If cross-device sync is ever wanted, this
     is the one function that would need to become a Supabase write.) */
  function _progressKey(materialId) {
    const userId = State.currentUser?.id || 'anon';
    return `pdfProgress:${userId}:${materialId}`;
  }

  function _loadSavedPage(materialId, totalPages) {
    try {
      const raw = localStorage.getItem(_progressKey(materialId));
      if (!raw) return 1;
      const saved = parseInt(raw, 10);
      if (!Number.isFinite(saved) || saved < 1) return 1;
      // Clamp in case the document was replaced with a shorter one
      return Math.min(saved, totalPages || saved);
    } catch {
      return 1; // localStorage unavailable (private browsing, quota, etc.) — fail open
    }
  }

  function _saveProgress(materialId, page) {
    if (!materialId) return;
    try {
      localStorage.setItem(_progressKey(materialId), String(page));
    } catch {
      // Non-fatal — reading still works, it just won't resume next time
    }
  }

  function _scheduleSaveProgress() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => _saveProgress(_materialId, _curPage), 400);
  }

  /**
   * Compute a base scale that makes the page fit the viewer's width.
   * On large/full-screen viewports we deliberately cap the page's
   * rendered width at a comfortable reading size (like Google Drive's
   * viewer) instead of stretching a single page edge-to-edge across a
   * wide desktop monitor — only the surrounding chrome is full-screen.
   * On narrow (mobile) viewports the full available width is used.
   */
  function _fitWidthScale(viewport) {
    const zone       = _el('pdf-canvas-zone');
    const rawAvail   = (zone?.clientWidth || 800) - 40; // 20px padding each side
    const MAX_READING_WIDTH = 900; // px — comfortable reading column on large screens
    const avail      = Math.min(rawAvail, MAX_READING_WIDTH);
    return Math.max(0.5, avail / viewport.width);
  }

  function _updatePagePill() {
    const input = _el('pdf-page-input');
    if (input) {
      // Don't fight the user while they're actively typing in the field
      if (document.activeElement !== input) input.value = _curPage;
      input.max = _totalPages || 1;
      input.disabled = !_totalPages;
    }
    const totalEl = _el('pdf-page-total-num');
    if (totalEl) totalEl.textContent = _totalPages || '—';
    _el('pdf-btn-prev').disabled = _curPage <= 1;
    _el('pdf-btn-next').disabled = _curPage >= _totalPages;
  }

  function _updateZoomLabel() {
    _el('pdf-zoom-label').textContent = Math.round(_zoomLevel * 100) + '%';
  }

  /** Actually rasterize one page's canvas — called lazily by the IntersectionObserver */
  async function _renderPageEntry(entry) {
    if (entry.rendered || !_pdfDoc) return;
    entry.rendered = true; // set immediately so overlapping observer callbacks don't double-render
    try {
      const page      = await _pdfDoc.getPage(entry.num);
      const scale     = _baseScale * _zoomLevel;
      const viewport  = page.getViewport({ scale });

      const canvas    = entry.canvas;
      const ctx       = canvas.getContext('2d');
      // Cap at 3x rather than 2x — most modern phones run 2.5–3x device
      // pixel ratio, and capping too low is exactly what makes a canvas
      // PDF viewer look "downgraded" compared to a native PDF reader.
      const dpr       = Math.min(window.devicePixelRatio || 1, 3);
      canvas.width    = viewport.width  * dpr;
      canvas.height   = viewport.height * dpr;
      canvas.style.width  = viewport.width  + 'px';
      canvas.style.height = viewport.height + 'px';
      ctx.scale(dpr, dpr);

      await page.render({ canvasContext: ctx, viewport }).promise;
    } catch (err) {
      console.error('[PDFViewer] page render failed:', entry.num, err);
      entry.rendered = false; // allow a retry if it scrolls back into view
    }
  }

  /** Tear down the current document's DOM/observer/listeners before loading a new one (or closing) */
  function _clearPages() {
    if (_observer) { _observer.disconnect(); _observer = null; }
    const container = _el('pdf-pages-container');
    if (container) container.innerHTML = '';
    _pages = [];
  }

  /**
   * Build one wrapper+canvas per page (sized from that page's real
   * dimensions, scaled uniformly with page 1's base scale), then
   * wire the IntersectionObserver that lazily renders each canvas
   * as it nears the viewport.
   */
  async function _buildPages() {
    const container = _el('pdf-pages-container');
    container.innerHTML = '';
    _pages = [];

    // Base scale is derived once from page 1 and applied to every
    // page — this keeps the reading column a consistent width even
    // if a handful of pages have slightly different intrinsic sizes.
    const firstPage = await _pdfDoc.getPage(1);
    _baseScale = _fitWidthScale(firstPage.getViewport({ scale: 1 }));

    // Fetch every remaining page's metadata (dimensions etc.) in
    // parallel instead of one-at-a-time. getPage() is an async
    // lookup into the document that's already streaming in — awaiting
    // it sequentially for every page (20-50+ for a full lesson) was
    // the main reason opening a lesson felt slow, since the wait time
    // stacked up per page instead of overlapping. This only changes
    // how fast the page scaffold is built; actual pixel rendering is
    // still lazy via the IntersectionObserver below, unchanged.
    // (Page 1 is reused from the fetch above instead of being
    // requested a second time.)
    const remainingNums = [];
    for (let n = 2; n <= _totalPages; n++) remainingNums.push(n);
    const remainingPages = await Promise.all(
      remainingNums.map(n => _pdfDoc.getPage(n))
    );
    const allPages = [firstPage, ...remainingPages]; // index 0 = page 1

    const scale = _baseScale * _zoomLevel;
    for (let n = 1; n <= _totalPages; n++) {
      const page     = allPages[n - 1];
      const viewport = page.getViewport({ scale });

      const wrapper = document.createElement('div');
      wrapper.className = 'pdf-page-wrapper';
      wrapper.style.width  = viewport.width  + 'px';
      wrapper.style.height = viewport.height + 'px';
      wrapper.dataset.pageNum = String(n);

      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-page-canvas';
      wrapper.appendChild(canvas);

      container.appendChild(wrapper);
      _pages.push({ num: n, wrapper, canvas, rendered: false });
    }

    // Lazy render: start rasterizing a page once it's within
    // RENDER_MARGIN of the visible scroll area.
    _observer = new IntersectionObserver((entries) => {
      for (const ioEntry of entries) {
        if (!ioEntry.isIntersecting) continue;
        const num = parseInt(ioEntry.target.dataset.pageNum, 10);
        const entry = _pages[num - 1];
        if (entry) _renderPageEntry(entry);
      }
    }, { root: _el('pdf-canvas-zone'), rootMargin: RENDER_MARGIN });

    _pages.forEach(p => _observer.observe(p.wrapper));
  }

  /** Scroll the zone so a given page's wrapper is at the top */
  function _scrollToPage(n) {
    const entry = _pages[n - 1];
    const zone  = _el('pdf-canvas-zone');
    if (!entry || !zone) return;
    _programmaticScroll = true;
    zone.scrollTop = entry.wrapper.offsetTop - 12; // small gap so the top isn't flush with the toolbar
    _curPage = n;
    _updatePagePill();
    _scheduleSaveProgress();
    // Release the programmatic-scroll guard once the browser settles
    requestAnimationFrame(() => requestAnimationFrame(() => { _programmaticScroll = false; }));
  }

  /** rAF-throttled scroll handler — tracks which page is "current" as the user scrolls freely */
  function _onScroll() {
    if (_programmaticScroll || _scrollRaf) return;
    _scrollRaf = requestAnimationFrame(() => {
      _scrollRaf = null;
      const zone = _el('pdf-canvas-zone');
      if (!zone || !_pages.length) return;
      const pos = zone.scrollTop + 24; // small offset so the page just past the top counts as "current"
      let current = _pages[0].num;
      for (const p of _pages) {
        if (p.wrapper.offsetTop <= pos) current = p.num;
        else break;
      }
      if (current !== _curPage) {
        _curPage = current;
        _updatePagePill();
        _scheduleSaveProgress();
      }
    });
  }

  /** Re-render already-visible pages and resize every placeholder after a zoom change */
  async function _rerenderAfterZoom() {
    const zone = _el('pdf-canvas-zone');
    const anchorPage = _curPage; // keep the reading position stable across the resize

    for (const entry of _pages) {
      const page     = await _pdfDoc.getPage(entry.num);
      const scale    = _baseScale * _zoomLevel;
      const viewport = page.getViewport({ scale });
      entry.wrapper.style.width  = viewport.width  + 'px';
      entry.wrapper.style.height = viewport.height + 'px';
      entry.rendered = false; // force a redraw at the new scale
    }

    _scrollToPage(anchorPage);

    // Re-render whatever is now actually in/near the viewport at the new scale
    for (const entry of _pages) {
      const rect = entry.wrapper.getBoundingClientRect();
      const zoneRect = zone.getBoundingClientRect();
      if (rect.bottom > zoneRect.top - 1200 && rect.top < zoneRect.bottom + 1200) {
        await _renderPageEntry(entry);
      }
    }

    // Word-hit-layer positions (tap-to-define, search highlights) were
    // computed at the old scale — rebuild them at the new one.
    PDFExtras.onZoomChanged();
  }

  /**
   * Shared tail-end of loading a document, regardless of whether its
   * pdf.js loadingTask was created from a network `url` or from
   * already-local cached `data` bytes: waits for the document to
   * parse, builds the page scaffold, and resumes the saved reading
   * position. Bails out cleanly (without touching shared state) if a
   * newer open() call has superseded this one while awaiting.
   */
  async function _finishLoadingDoc(loadingTask, myToken) {
    _pdfDoc = await loadingTask.promise;
    if (myToken !== _openToken) { // superseded while awaiting — don't touch the newer viewer's state
      try { await _pdfDoc.destroy(); } catch (_) {}
      return;
    }
    _totalPages = _pdfDoc.numPages;

    // Build every page's wrapper/canvas up front (sized correctly
    // from real dimensions) and start the lazy-render observer —
    // this is what makes the continuous scroll work.
    await _buildPages();
    if (myToken !== _openToken) return; // superseded mid-build

    _showState('pages');
    _updatePagePill();

    // Resume from wherever the user last left off in this document
    const startPage = _loadSavedPage(_materialId, _totalPages);
    _scrollToPage(startPage);

    // Hand the freshly-built document/pages over to the TOC/search/
    // dictionary/theme module — see pdfExtras.js.
    PDFExtras.onDocumentReady({
      pdfDoc: _pdfDoc,
      pages: _pages,
      gotoPage: _scrollToPage,
      getScale: () => _baseScale * _zoomLevel,
    });
  }

  /** Event: blur the pages container when window loses focus */
  function _onWindowBlur()  {
    if (State.pdfViewerActive) _el('pdf-canvas-zone')?.classList.add('blurred');
  }
  function _onWindowFocus() {
    _el('pdf-canvas-zone')?.classList.remove('blurred');
  }
  function _onVisibilityChange() {
    if (document.hidden && State.pdfViewerActive) {
      _el('pdf-canvas-zone')?.classList.add('blurred');
    } else {
      _el('pdf-canvas-zone')?.classList.remove('blurred');
    }
  }
  // DevTools size-heuristic — same as Protection module
  function _checkDevTools() {
    if (!State.pdfViewerActive) return;
    const diff = window.outerWidth - window.innerWidth;
    if (diff > 160) _el('pdf-canvas-zone')?.classList.add('blurred');
  }
  let _devToolsTimer = null;

  // ── Public API ────────────────────────────────────────────
  return {

    /**
     * Main entry point.
     * @param {object} mod       Module object { name, … }
     * @param {string} type      'summary' | 'fullLesson' | 'guide'
     * @param {object} material  { id, title, storagePath } — one entry from CourseMaterials.getAll()
     */
    async open(mod, type, material) {
      // Bump the request generation immediately — anything from an
      // older, still-in-flight open() call checks this and bails out
      // rather than overwriting a newer open() that's already showing.
      const myToken = ++_openToken;

      // Set type label in toolbar
      const typeLabels = {
        summary:    'Free Summary',
        fullLesson: 'Full Lesson',
        guide:      'Comprehensive Guide'
      };

      _el('pdf-doc-name').textContent = material.title || mod.name;
      _el('pdf-doc-type').textContent = typeLabels[type] || type;

      // Reset viewer state
      _clearPages();
      _pdfDoc     = null;
      _curPage    = 1;
      _totalPages = 0;
      _zoomLevel  = 1.0;
      _materialId = material?.id ?? null;

      const pageInput = _el('pdf-page-input');
      if (pageInput) { pageInput.value = ''; pageInput.disabled = true; }
      _el('pdf-page-total-num').textContent = '—';
      _el('pdf-zoom-label').textContent = '100%';
      _el('pdf-btn-prev').disabled = true;
      _el('pdf-btn-next').disabled = true;
      _el('pdf-canvas-zone').classList.remove('blurred');
      _showState('skeleton');

      // Show the overlay immediately so the user sees feedback at once
      _el('pdf-overlay').classList.remove('hidden');
      lockBodyScroll();
      BackNav.push(() => this.close());

      State.pdfViewerActive = true;
      State.contentViewerActive = false; // mutually exclusive with HTML viewer

      // Attach window-focus / devtools / scroll listeners
      window.addEventListener('blur', _onWindowBlur);
      window.addEventListener('focus', _onWindowFocus);
      document.addEventListener('visibilitychange', _onVisibilityChange);
      _el('pdf-canvas-zone').addEventListener('scroll', _onScroll, { passive: true });
      if (!_devToolsTimer) _devToolsTimer = setInterval(_checkDevTools, 1200);

      // ── 0. Instant path: already-cached content (works fully offline) ──
      // Skips both the Edge Function round trip and the PDF network
      // fetch entirely, decrypting straight from the on-device cache
      // — see materialCache.js. Now covers both 'summary' (free) and
      // 'fullLesson' (paid) content: paid lessons are safe to persist
      // here because they're encrypted at rest with a key that can
      // never be read back out as bytes by any script, not because
      // they're treated as any less sensitive than before.
      const cacheable = type === 'summary' || type === 'fullLesson';
      if (cacheable) {
        const cachedBytes = await MaterialCache.read(_materialId);
        if (myToken !== _openToken) return; // superseded while awaiting

        if (cachedBytes) {
          // Tell the server this material was viewed again — this is
          // still awaited-in-the-background (not blocking render, but
          // its result IS inspected) rather than pure fire-and-forget,
          // because for 'fullLesson' this doubles as the revocation
          // check described in materialCache.js's header: if the
          // server now says access is denied (403) — subscription
          // lapsed since this was cached — the local copy is purged so
          // it can't keep being opened offline indefinitely. Any other
          // outcome (success, or simply being offline right now)
          // leaves the cached copy alone; being offline is the whole
          // point of this cache, not a reason to distrust it.
          sb.functions.invoke('get-material-url', {
            body: { storage_path: material.storagePath, material_id: material.id, title: material.title },
          }).then(({ error }) => {
            const status = error?.context?.status ?? error?.status;
            if (status === 403) MaterialCache.evict(_materialId);
          }).catch(() => {}); // offline, or anything else — leave the cached copy alone

          try {
            const loadingTask = window.pdfjsLib.getDocument({
              data:       cachedBytes,
              cMapUrl:    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
              cMapPacked: true,
            });
            await _finishLoadingDoc(loadingTask, myToken);
            return; // rendered entirely from cache — done, fully offline-capable
          } catch (err) {
            if (myToken !== _openToken) return; // superseded — newer open() owns error reporting now
            console.warn('[PDFViewer] cached copy failed to load, evicting and falling back to network:', err);
            // A partial/failed load may have left a PDFDocumentProxy
            // behind — destroy it before the network path below
            // creates a fresh one, so it isn't silently leaked.
            if (_pdfDoc) { try { await _pdfDoc.destroy(); } catch (_) {} _pdfDoc = null; }
            await MaterialCache.evict(_materialId);
            // fall through to the normal network path below — if the
            // device is genuinely offline and there's no usable cache,
            // this will fail too, and the existing catch block further
            // down reports that clearly rather than hanging.
          }
        }
      }

      // ── 1. Generate a short-lived signed URL (90 seconds) ──
      // Routed through the get-material-url Edge Function rather than
      // calling storage.createSignedUrl() directly. Storage RLS is
      // still the actual access gate (the function calls createSignedUrl()
      // as this same user) — the function's job is to log every
      // open attempt to security_logs and soft-throttle abnormal bursts,
      // which a direct client→storage call has no way to do.
      let signedUrl;
      try {
        const { data, error } = await sb.functions.invoke('get-material-url', {
          body: {
            storage_path: material.storagePath,
            material_id: material.id,
            title: material.title,
          },
        });

        if (myToken !== _openToken) return; // superseded by a newer open() while awaiting

        if (error || !data?.signedUrl) {
          // supabase-js v2 wraps BOTH a real 403 from the function AND a
          // pure network/CORS failure (e.g. fetch() rejected before ever
          // reaching the server — as happens when the caller's Origin
          // isn't on the Edge Function's CORS allow-list) into this same
          // { error } shape rather than throwing. Previously every case
          // here showed "verify your subscription", which was actively
          // misleading whenever the real cause was a connection/CORS
          // problem, not an access one. Differentiate by HTTP status
          // when we have it.
          const status = error?.context?.status;
          console.error('[PDFViewer] get-material-url error:', { status, name: error?.name, message: error?.message || data?.error, error });
          if (status === 403) {
            _setError('Access denied. Please verify your subscription.');
          } else if (status === 401) {
            _setError('Your session has expired. Please log in again.');
          } else if (status === 429) {
            _setError('Too many requests — please slow down and try again shortly.');
          } else if (!status) {
            // No HTTP status at all means the request never got a server
            // response (network/CORS-level failure).
            _setError('Connection problem loading this document. Please check your internet connection and try again.');
          } else {
            _setError('Could not load this document right now. Please try again.');
          }
          return;
        }
        signedUrl = data.signedUrl;
      } catch (err) {
        if (myToken !== _openToken) return; // superseded by a newer open() while awaiting
        console.error('[PDFViewer] Network error during signed URL generation:', err);
        _setError('Network error. Please check your connection and try again.');
        return;
      }

      // ── 2. Fetch the document bytes once, then load via PDF.js ──
      try {
        // Point the worker at the same CDN version as the main script
        if (window.pdfjsLib) {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        }

        // Fetch the bytes ONCE, rather than letting PDF.js stream from
        // the signed URL and separately re-downloading afterward
        // (un-awaited, in the background) to populate the cache. That
        // was two independent network operations racing against
        // whatever the user did next — if connectivity dropped (or the
        // tab was closed) before that second fetch finished, the
        // document simply never got cached even though it had just
        // opened successfully seconds earlier, which is very likely
        // exactly how the "Connection problem loading this document"
        // bug happened for previously-opened lessons: the first-ever
        // online open never actually finished writing a usable cache
        // entry, so the next offline attempt had nothing to fall back
        // to and surfaced a network error instead. Fetching once and
        // using the SAME bytes for both rendering and the cache write
        // below removes that race entirely, trading away PDF.js' own
        // progressive "start rendering before the whole file arrives"
        // streaming — an acceptable cost for these file sizes against
        // a much more important guarantee, for a feature whose entire
        // point is reliable offline access.
        const response = await fetch(signedUrl, {
          // Don't let the browser's own HTTP cache hold a copy keyed
          // to a URL that's only valid for the next 90 seconds anyway.
          headers: { 'Cache-Control': 'no-store' }
        });
        if (myToken !== _openToken) return; // superseded while awaiting
        if (!response.ok) throw new Error(`Failed to download document (status ${response.status})`);
        const arrayBuffer = await response.arrayBuffer();
        if (myToken !== _openToken) return; // superseded while awaiting

        const loadingTask = window.pdfjsLib.getDocument({
          data:       arrayBuffer,
          // Standard CMap support for non-Latin character sets
          cMapUrl:    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
          cMapPacked: true,
          // Disable the text layer (nothing selectable) and annotation layer
          // (no internal hyperlinks rendered that could hint at structure)
        });

        await _finishLoadingDoc(loadingTask, myToken);
        if (myToken !== _openToken) return; // superseded mid-build

        // Populate the on-device (encrypted) cache using the exact
        // same bytes just rendered — awaited here, not fire-and-
        // forget, so caching genuinely completes before open()
        // returns instead of racing against whatever happens next.
        // Covers both 'summary' and 'fullLesson' now — see the read
        // side above and materialCache.js for why encryption makes
        // that safe for paid content too.
        if (cacheable) {
          await MaterialCache.write(_materialId, arrayBuffer);
        }

      } catch (err) {
        if (myToken !== _openToken) return; // superseded — the newer open() owns error reporting now
        console.error('[PDFViewer] PDF.js load error:', err);
        if (err?.name === 'InvalidPDFException') {
          _setError('Invalid or corrupted document. Please contact support.');
        } else if (err?.name === 'MissingPDFException' || err?.status === 403) {
          _setError('Document link expired. Please close and reopen the content.');
        } else if (err instanceof TypeError) {
          // fetch() throws a bare TypeError for a network-level
          // failure (no connectivity, DNS, etc.) — distinct from a
          // successful response with a bad status, handled above.
          _setError('Connection problem loading this document. Please check your internet connection and try again.');
        } else {
          _setError('Failed to load document. Please try again.');
        }
      }
    },

    close() {
      // Invalidate any open() call still in flight (e.g. the user closed
      // before its network/PDF.js work finished) so it stops before
      // touching state or UI that no longer belongs to it.
      _openToken++;

      BackNav.notifyClose();
      _el('pdf-overlay').classList.add('hidden');
      unlockBodyScroll();
      State.pdfViewerActive = false;
      PDFExtras.onClose();

      // Destroy the PDF document to release memory
      if (_pdfDoc) {
        _pdfDoc.destroy();
        _pdfDoc = null;
      }
      _clearPages();
      _showState('skeleton'); // reset for next open
      _materialId = null;

      // Remove focus / devtools / scroll listeners
      window.removeEventListener('blur', _onWindowBlur);
      window.removeEventListener('focus', _onWindowFocus);
      document.removeEventListener('visibilitychange', _onVisibilityChange);
      _el('pdf-canvas-zone')?.removeEventListener('scroll', _onScroll);
      if (_devToolsTimer) { clearInterval(_devToolsTimer); _devToolsTimer = null; }
      if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    },

    /** Scroll up one page (keyboard ↑ / toolbar button) */
    prevPage() {
      if (_curPage > 1) _scrollToPage(_curPage - 1);
    },

    /** Scroll down one page (keyboard ↓ / toolbar button) */
    nextPage() {
      if (_curPage < _totalPages) _scrollToPage(_curPage + 1);
    },

    /** Called by the page-number <input> on change (Enter or blur) */
    gotoPageInput(rawValue) {
      const n = parseInt(rawValue, 10);
      const input = _el('pdf-page-input');
      if (!Number.isFinite(n) || n < 1 || n > _totalPages) {
        // Invalid entry — snap the field back to the real current page
        if (input) input.value = _curPage;
        return;
      }
      _scrollToPage(n);
    },

    async zoom(direction) {
      // direction: +1 = zoom in, -1 = zoom out
      const idx = ZOOM_STEPS.indexOf(
        ZOOM_STEPS.reduce((best, z) => Math.abs(z - _zoomLevel) < Math.abs(best - _zoomLevel) ? z : best, ZOOM_STEPS[0])
      );
      const nextIdx = Math.max(0, Math.min(ZOOM_STEPS.length - 1, idx + direction));
      _zoomLevel = ZOOM_STEPS[nextIdx];
      _updateZoomLabel();
      await _rerenderAfterZoom();
    }
  };
})();
