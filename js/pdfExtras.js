/* ═══════════════════════════════════════════════════════════════
   PDF VIEWER EXTRAS
   ───────────────────────────────────────────────────────────────
   Adds five features on top of the core canvas-based viewer in
   pdfViewer.js, without touching that file's rendering pipeline:

     • Pan / hand tool     — drag-to-scroll the canvas zone (mouse
                              users, and anyone zoomed in past the
                              fit-width scale).
     • Tap-to-define       — single-word dictionary lookup, via an
                              invisible per-word hit-layer built from
                              PDF.js text content (see note below on
                              why this does NOT reintroduce free-text
                              selection/copy).
     • Table of contents   — parses the PDF's own outline/bookmarks
                              (pdfDoc.getOutline()) into a collapsible
                              sidebar.
     • In-document search  — case-insensitive search across every
                              page's text content, with next/prev
                              stepping between highlighted matches.
     • Dark / Sepia mode   — a CSS filter applied to the rendered
                              pages, cycled and remembered across
                              sessions (a *reading* theme, distinct
                              from the app chrome, which is already
                              dark).

   Integration model: pdfViewer.js calls three small hooks —
   onDocumentReady(), onZoomChanged(), onClose() — and everything
   else here is self-contained, driven by the toolbar buttons wired
   in index.html (onclick="App.PDFExtras.…()").

   On the anti-copy stance: the core viewer deliberately renders PDF
   pages as flat canvas pixels with no text layer, so nothing is
   selectable/copyable by default. Tap-to-define and search both need
   *some* notion of where words are, so this file builds its own
   minimal per-text-run hit-layer — invisible, `user-select: none`,
   and read only by this module's own click/search handlers. It is
   deliberately NOT PDF.js's standard selectable/copyable text layer:
   there is no click-drag range selection and no OS copy/paste, only
   (a) "which single run of text was tapped" for the dictionary and
   (b) "does this run contain the search term" for highlighting. That
   keeps the existing no-copy guarantee intact while still enabling
   both features.
═══════════════════════════════════════════════════════════════ */

const THEME_KEY = 'pdfReaderTheme'; // 'normal' | 'dark' | 'sepia' — global, not per-document
const THEMES = ['normal', 'dark', 'sepia'];
const DICTIONARY_API = 'https://api.dictionaryapi.dev/api/v2/entries/en/';

function _el(id) { return document.getElementById(id); }

export const PDFExtras = (() => {
  // ── State tied to the currently-open document ─────────────────
  let _pdfDoc     = null;
  let _pages      = [];      // same array pdfViewer.js builds: [{ num, wrapper, canvas, rendered }]
  let _gotoPage   = null;    // (n) => void, supplied by pdfViewer.js
  let _getScale   = null;    // () => number, supplied by pdfViewer.js
  let _textCache  = new Map(); // pageNum -> { textContent, viewport } — built lazily, once per page per open()

  // ── Pan tool ───────────────────────────────────────────────────
  let _panActive  = false;
  let _panDragging = false;
  let _panStart   = { x: 0, y: 0, scrollLeft: 0, scrollTop: 0 };

  // ── Search ──────────────────────────────────────────────────────
  let _searchOpen    = false;
  let _searchQuery   = '';
  let _searchMatches = []; // [{ pageNum, span }]
  let _searchIndex   = -1;
  let _searchToken   = 0;  // bumped per search run so a stale async build can't clobber a newer one

  // ── Dictionary popup ─────────────────────────────────────────────
  let _dictToken = 0;

  /* ── Word-hit-layer construction (shared by search + dictionary) ── */

  /** Lazily builds (once per page per open()) the invisible per-text-run hit layer for one page. */
  async function _ensureWordLayer(pageEntry) {
    if (pageEntry.wordLayerBuilt || !_pdfDoc) return;
    pageEntry.wordLayerBuilt = true; // set immediately — avoid duplicate concurrent builds
    try {
      const page = await _pdfDoc.getPage(pageEntry.num);
      const scale = _getScale();
      const viewport = page.getViewport({ scale });
      const textContent = await page.getTextContent();
      _textCache.set(pageEntry.num, { textContent, viewport });

      const layer = document.createElement('div');
      layer.className = 'pdf-word-layer';
      layer.oncontextmenu = () => false;

      for (let i = 0; i < textContent.items.length; i++) {
        const item = textContent.items[i];
        if (!item.str || !item.str.trim()) continue;

        const tx = window.pdfjsLib.Util.transform(viewport.transform, item.transform);
        const angle = Math.atan2(tx[1], tx[0]);
        const fontHeight = Math.hypot(tx[2], tx[3]) || 10;
        const widthPx = Math.abs(item.width * scale) || (fontHeight * item.str.length * 0.5);
        const left = tx[4];
        const top  = tx[5] - fontHeight;

        const span = document.createElement('span');
        span.className = 'pdf-word-run';
        span.dataset.text = item.str;
        span.dataset.itemIndex = String(i);
        span.style.left   = left + 'px';
        span.style.top    = top + 'px';
        span.style.width  = Math.max(widthPx, 4) + 'px';
        span.style.height = (fontHeight * 1.25) + 'px';
        if (Math.abs(angle) > 0.01) {
          span.style.transform = `rotate(${angle}rad)`;
          span.style.transformOrigin = '0 0';
        }
        layer.appendChild(span);
      }

      pageEntry.wrapper.appendChild(layer);
      pageEntry.wordLayerEl = layer;
    } catch (err) {
      pageEntry.wordLayerBuilt = false; // allow a retry (e.g. if it scrolls back into view later)
      console.warn('[PDFExtras] word layer build failed for page', pageEntry.num, err);
    }
  }

  /** Given a click on a .pdf-word-run span, picks the single nearest word inside it. */
  function _wordAtClick(span, clientX) {
    const text = span.dataset.text || '';
    const words = text.split(/(\s+)/).filter(w => w.trim());
    if (words.length <= 1) return text.trim();
    const rect = span.getBoundingClientRect();
    const frac = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
    const idx = Math.min(words.length - 1, Math.floor(frac * words.length));
    return words[idx].replace(/[^A-Za-z'’-]/g, '');
  }

  function _attachWordTapHandler(pageEntry) {
    if (!pageEntry.wordLayerEl || pageEntry.wordTapWired) return;
    pageEntry.wordTapWired = true;
    pageEntry.wordLayerEl.addEventListener('click', (e) => {
      const span = e.target.closest('.pdf-word-run');
      if (!span || _panActive) return; // pan mode owns drag gestures; don't also open a popup mid-drag
      const word = _wordAtClick(span, e.clientX);
      if (word && word.length > 1) _lookupWord(word, e.clientX, e.clientY);
    });
  }

  /* ── Dictionary lookup ────────────────────────────────────────── */

  async function _lookupWord(word, clientX, clientY) {
    const myToken = ++_dictToken;
    const popup = _el('pdf-dict-popup');
    if (!popup) return;

    _positionDictPopup(popup, clientX, clientY);
    popup.classList.remove('hidden');
    popup.innerHTML = `<div class="pdf-dict-word">${_escHtml(word)}</div><div class="pdf-dict-loading">Looking up definition…</div>`;

    try {
      const res = await fetch(DICTIONARY_API + encodeURIComponent(word.toLowerCase()));
      if (myToken !== _dictToken) return; // superseded by a newer tap
      if (!res.ok) {
        popup.innerHTML = `<div class="pdf-dict-word">${_escHtml(word)}</div><div class="pdf-dict-empty">No definition found.</div>`;
        return;
      }
      const data = await res.json();
      if (myToken !== _dictToken) return;
      const entry = Array.isArray(data) ? data[0] : null;
      if (!entry) {
        popup.innerHTML = `<div class="pdf-dict-word">${_escHtml(word)}</div><div class="pdf-dict-empty">No definition found.</div>`;
        return;
      }
      const phonetic = entry.phonetic || (entry.phonetics || []).find(p => p.text)?.text || '';
      const meanings = (entry.meanings || []).slice(0, 2).map(m => {
        const def = m.definitions?.[0];
        if (!def) return '';
        return `<div class="pdf-dict-meaning">
          <span class="pdf-dict-pos">${_escHtml(m.partOfSpeech || '')}</span>
          <span class="pdf-dict-def">${_escHtml(def.definition || '')}</span>
        </div>`;
      }).join('');
      popup.innerHTML = `
        <div class="pdf-dict-word">${_escHtml(entry.word || word)}${phonetic ? ` <span class="pdf-dict-phonetic">${_escHtml(phonetic)}</span>` : ''}</div>
        ${meanings || '<div class="pdf-dict-empty">No definition found.</div>'}
      `;
    } catch (err) {
      if (myToken !== _dictToken) return;
      popup.innerHTML = `<div class="pdf-dict-word">${_escHtml(word)}</div><div class="pdf-dict-empty">Couldn't reach the dictionary — check your connection.</div>`;
    }
  }

  function _positionDictPopup(popup, clientX, clientY) {
    const zone = _el('pdf-canvas-zone');
    const zoneRect = zone.getBoundingClientRect();
    const POPUP_W = 260;
    let left = clientX - zoneRect.left - POPUP_W / 2;
    left = Math.max(8, Math.min(left, zoneRect.width - POPUP_W - 8));
    let top = clientY - zoneRect.top + 16;
    if (top > zoneRect.height - 140) top = clientY - zoneRect.top - 150; // flip above if too close to the bottom
    popup.style.left = left + 'px';
    popup.style.top  = Math.max(8, top) + 'px';
  }

  function _escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ── Table of contents ───────────────────────────────────────── */

  async function _buildToc() {
    const body = _el('pdf-toc-body');
    if (!body || !_pdfDoc) return;
    body.innerHTML = '<div class="pdf-toc-empty">Loading contents…</div>';
    try {
      const outline = await _pdfDoc.getOutline();
      if (!outline || !outline.length) {
        body.innerHTML = '<div class="pdf-toc-empty">No table of contents in this document.</div>';
        return;
      }
      body.innerHTML = '';
      body.appendChild(await _renderTocLevel(outline, 0));
    } catch (err) {
      console.warn('[PDFExtras] getOutline failed:', err);
      body.innerHTML = '<div class="pdf-toc-empty">No table of contents in this document.</div>';
    }
  }

  async function _renderTocLevel(items, depth) {
    const list = document.createElement('div');
    list.className = 'pdf-toc-level';
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'pdf-toc-row';
      row.style.paddingLeft = (12 + depth * 16) + 'px';

      const hasChildren = item.items && item.items.length > 0;
      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'pdf-toc-label';
      label.textContent = item.title || 'Untitled';
      label.addEventListener('click', () => _gotoTocDest(item.dest));
      row.appendChild(label);

      if (hasChildren) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'pdf-toc-toggle';
        toggle.textContent = '▾';
        toggle.setAttribute('aria-label', 'Expand/collapse');
        row.appendChild(toggle);
      }

      list.appendChild(row);

      if (hasChildren) {
        const childList = await _renderTocLevel(item.items, depth + 1);
        list.appendChild(childList);
        const toggle = row.querySelector('.pdf-toc-toggle');
        toggle.addEventListener('click', () => {
          const collapsed = childList.classList.toggle('collapsed');
          toggle.textContent = collapsed ? '▸' : '▾';
        });
      }
    }
    return list;
  }

  async function _gotoTocDest(dest) {
    if (!dest || !_pdfDoc) return;
    try {
      const explicitDest = typeof dest === 'string' ? await _pdfDoc.getDestination(dest) : dest;
      if (!explicitDest) return;
      const pageIndex = await _pdfDoc.getPageIndex(explicitDest[0]);
      _gotoPage(pageIndex + 1);
      _closeToc();
    } catch (err) {
      console.warn('[PDFExtras] TOC navigation failed:', err);
    }
  }

  function _closeToc() {
    _el('pdf-toc-panel')?.classList.add('hidden');
    _el('pdf-btn-toc')?.classList.remove('active');
  }

  /* ── In-document search ──────────────────────────────────────── */

  async function _runSearch(query) {
    const myToken = ++_searchToken;
    _searchQuery = query.trim();
    _clearSearchHighlights();
    _searchMatches = [];
    _searchIndex = -1;
    _updateSearchCount();
    if (!_searchQuery || !_pdfDoc) return;

    const needle = _searchQuery.toLowerCase();
    _setSearchStatus('Searching…');

    for (const pageEntry of _pages) {
      if (myToken !== _searchToken) return; // a newer search superseded this one
      await _ensureWordLayer(pageEntry);
      _attachWordTapHandler(pageEntry);
      if (!pageEntry.wordLayerEl) continue;
      for (const span of pageEntry.wordLayerEl.querySelectorAll('.pdf-word-run')) {
        const text = (span.dataset.text || '').toLowerCase();
        if (text.includes(needle)) {
          span.classList.add('pdf-word-match');
          _searchMatches.push({ pageNum: pageEntry.num, span });
        }
      }
    }
    if (myToken !== _searchToken) return;

    _setSearchStatus('');
    if (_searchMatches.length) {
      _searchIndex = 0;
      _highlightCurrentMatch();
    }
    _updateSearchCount();
  }

  function _clearSearchHighlights() {
    document.querySelectorAll('.pdf-word-match, .pdf-word-match-current')
      .forEach(el => el.classList.remove('pdf-word-match', 'pdf-word-match-current'));
  }

  function _highlightCurrentMatch() {
    document.querySelectorAll('.pdf-word-match-current').forEach(el => el.classList.remove('pdf-word-match-current'));
    const m = _searchMatches[_searchIndex];
    if (!m) return;
    m.span.classList.add('pdf-word-match-current');
    _gotoPage(m.pageNum);
    // Scroll the exact match into the middle of the zone, not just its page
    requestAnimationFrame(() => {
      m.span.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  function _updateSearchCount() {
    const el = _el('pdf-search-count');
    if (!el) return;
    if (!_searchQuery) { el.textContent = ''; return; }
    el.textContent = _searchMatches.length
      ? `${_searchIndex + 1} / ${_searchMatches.length}`
      : 'No results';
  }

  function _setSearchStatus(msg) {
    const el = _el('pdf-search-count');
    if (el && msg) el.textContent = msg;
  }

  /* ── Pan / hand tool ──────────────────────────────────────────── */

  function _onPanDown(e) {
    if (!_panActive) return;
    const zone = _el('pdf-canvas-zone');
    _panDragging = true;
    zone.classList.add('panning');
    _panStart = { x: e.clientX, y: e.clientY, scrollLeft: zone.scrollLeft, scrollTop: zone.scrollTop };
    e.preventDefault();
  }
  function _onPanMove(e) {
    if (!_panDragging) return;
    const zone = _el('pdf-canvas-zone');
    zone.scrollLeft = _panStart.scrollLeft - (e.clientX - _panStart.x);
    zone.scrollTop  = _panStart.scrollTop  - (e.clientY - _panStart.y);
  }
  function _onPanUp() {
    if (!_panDragging) return;
    _panDragging = false;
    _el('pdf-canvas-zone')?.classList.remove('panning');
  }

  /* ── Theme (dark / sepia) ─────────────────────────────────────── */

  function _applyTheme(theme) {
    const container = _el('pdf-pages-container');
    if (!container) return;
    container.classList.remove('pdf-theme-dark', 'pdf-theme-sepia');
    if (theme === 'dark') container.classList.add('pdf-theme-dark');
    if (theme === 'sepia') container.classList.add('pdf-theme-sepia');
    const btn = _el('pdf-btn-theme');
    if (btn) btn.textContent = theme === 'dark' ? '🌙' : theme === 'sepia' ? '📜' : '☀️';
  }

  function _currentTheme() {
    try { return localStorage.getItem(THEME_KEY) || 'normal'; } catch { return 'normal'; }
  }

  /** Builds the word-hit-layer for whichever pages are already rendered but don't have one yet. Cheap no-op once everything visible is covered — safe to call often. */
  function _sweepWordLayers() {
    for (const p of _pages) {
      if (p.rendered && !p.wordLayerBuilt) {
        _ensureWordLayer(p).then(() => _attachWordTapHandler(p));
      }
    }
  }

  // ── Public API ─────────────────────────────────────────────────
  return {
    /** Called once by pdfViewer.js after a document's pages are built and shown. */
    onDocumentReady({ pdfDoc, pages, gotoPage, getScale }) {
      _pdfDoc = pdfDoc; _pages = pages; _gotoPage = gotoPage; _getScale = getScale;
      _textCache = new Map();
      _searchMatches = []; _searchIndex = -1; _searchQuery = '';
      const input = _el('pdf-search-input');
      if (input) input.value = '';
      _updateSearchCount();
      _closeToc();
      _el('pdf-dict-popup')?.classList.add('hidden');
      _applyTheme(_currentTheme());
      _buildToc(); // cheap even if unused — parses the outline once up front
      // Sweep a few times as initial pages finish rasterizing (rendering
      // is async and lazy — see pdfViewer.js), so tap-to-define/search
      // are ready on the first screenful without waiting for a scroll.
      [200, 600, 1200].forEach(ms => setTimeout(_sweepWordLayers, ms));
    },

    /** Called by pdfViewer.js after a zoom change, so word-layer positions stay correct next time they're rebuilt. */
    onZoomChanged() {
      for (const p of _pages) {
        if (p.wordLayerEl) { p.wordLayerEl.remove(); p.wordLayerEl = null; p.wordLayerBuilt = false; p.wordTapWired = false; }
      }
      // Search highlights reference now-removed spans — rebuild if a search is active.
      if (_searchQuery) _runSearch(_searchQuery);
      else [200, 600, 1200].forEach(ms => setTimeout(_sweepWordLayers, ms));
    },

    /** Called by pdfViewer.js's close(). */
    onClose() {
      _pdfDoc = null; _pages = []; _textCache = new Map();
      _panActive = false; _panDragging = false;
      _el('pdf-canvas-zone')?.classList.remove('pan-mode', 'panning');
      _el('pdf-btn-pan')?.classList.remove('active');
      this.closeSearch();
      _closeToc();
      _el('pdf-dict-popup')?.classList.add('hidden');
    },

    toggleToc() {
      const panel = _el('pdf-toc-panel');
      const btn = _el('pdf-btn-toc');
      if (!panel) return;
      const opening = panel.classList.contains('hidden');
      panel.classList.toggle('hidden', !opening);
      btn?.classList.toggle('active', opening);
      if (opening) { this.closeSearch(); _el('pdf-dict-popup')?.classList.add('hidden'); }
    },

    toggleSearch() {
      _searchOpen = !_searchOpen;
      _el('pdf-search-bar')?.classList.toggle('hidden', !_searchOpen);
      _el('pdf-btn-search')?.classList.toggle('active', _searchOpen);
      if (_searchOpen) {
        _closeToc();
        _el('pdf-dict-popup')?.classList.add('hidden');
        setTimeout(() => _el('pdf-search-input')?.focus(), 50);
      } else {
        this.closeSearch();
      }
    },

    closeSearch() {
      _searchOpen = false;
      _el('pdf-search-bar')?.classList.add('hidden');
      _el('pdf-btn-search')?.classList.remove('active');
      _clearSearchHighlights();
      _searchMatches = []; _searchIndex = -1; _searchQuery = '';
      _updateSearchCount();
    },

    onSearchInput(value) {
      clearTimeout(this._searchDebounce);
      this._searchDebounce = setTimeout(() => _runSearch(value), 300);
    },

    searchNext() {
      if (!_searchMatches.length) return;
      _searchIndex = (_searchIndex + 1) % _searchMatches.length;
      _highlightCurrentMatch(); _updateSearchCount();
    },

    searchPrev() {
      if (!_searchMatches.length) return;
      _searchIndex = (_searchIndex - 1 + _searchMatches.length) % _searchMatches.length;
      _highlightCurrentMatch(); _updateSearchCount();
    },

    togglePan() {
      _panActive = !_panActive;
      const zone = _el('pdf-canvas-zone');
      zone?.classList.toggle('pan-mode', _panActive);
      _el('pdf-btn-pan')?.classList.toggle('active', _panActive);
    },

    cycleTheme() {
      const cur = _currentTheme();
      const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
      try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
      _applyTheme(next);
    },

    closeDictionary() {
      _el('pdf-dict-popup')?.classList.add('hidden');
    },

    /** Wires the pan-tool pointer listeners and word-layer builder onto pages as they render — called once, at app boot. */
    initGlobalListeners() {
      const zone = _el('pdf-canvas-zone');
      if (!zone || zone.dataset.extrasWired) return;
      zone.dataset.extrasWired = '1';
      zone.addEventListener('pointerdown', _onPanDown);
      window.addEventListener('pointermove', _onPanMove);
      window.addEventListener('pointerup', _onPanUp);
      window.addEventListener('pointercancel', _onPanUp);

      // Lazily build the word-hit-layer for a page once it's actually
      // rendered — piggybacks on the same IntersectionObserver timing
      // as canvas rendering by simply checking on every scroll/render
      // tick which visible pages still need one. Cheap: a no-op for
      // pages that already have their layer built.
      zone.addEventListener('scroll', _sweepWordLayers, { passive: true });

      document.addEventListener('click', (e) => {
        const popup = _el('pdf-dict-popup');
        if (popup && !popup.classList.contains('hidden') && !popup.contains(e.target) && !e.target.closest('.pdf-word-run')) {
          popup.classList.add('hidden');
        }
      });
    }
  };
})();
