/* ═══════════════════════════════════════════════════════════════
   PDF COMPRESSOR — automatic, runs before every admin upload
   ───────────────────────────────────────────────────────────────
   Goal: students opening a lesson on mobile data should download as
   few bytes as possible, with zero effort from the admin and zero
   change in what they see.

   How: when a lesson PDF is selected for upload, each page is
   rasterized (via PDF.js, already loaded for the viewer) at a
   phone-appropriate resolution and re-encoded as a JPEG, then
   reassembled into a brand-new PDF (via pdf-lib). This is where
   almost all of a lesson's size lives — the embedded page images —
   so shrinking it here is what actually saves students data every
   time they open the file, not just the first page they scroll to.

   Safety, so this can never make an upload worse or lose content:
     1. Page count of the rebuilt PDF is checked against the
        original — if anything doesn't match, the original file is
        used unmodified.
     2. The rebuilt PDF's byte size is compared to the original —
        if it isn't actually smaller (this happens for PDFs that are
        mostly plain text/vector, which are already tiny), the
        original file is used unmodified. This never inflates a file.
     3. Any unexpected error (corrupt PDF, browser memory limits,
        pdf-lib/pdf.js failing to load, etc.) falls back to the
        original file — compression failing must never block an
        upload.

   This trades a few extra seconds of the admin's own upload time
   (rendering pages happens once, in the admin's browser) for a much
   smaller download for every student who opens the file afterward.
═══════════════════════════════════════════════════════════════ */

const TARGET_DPI    = 180;   // comfortable clarity on a phone screen, even at 150% zoom
const JPEG_QUALITY  = 0.75;  // visually near-lossless for lesson scans/slides at this DPI

export const PDFCompressor = {
  /**
   * @param {File} file - the original PDF selected in the admin panel
   * @param {(msg:string)=>void} [onProgress] - optional status callback, e.g. "page 4/22"
   * @returns {Promise<File>} - a smaller PDF File, or the original File if compression
   *                            didn't help or wasn't possible
   */
  async compress(file, onProgress) {
    try {
      if (!window.pdfjsLib || !window.PDFLib) {
        console.warn('[PDFCompressor] pdf.js or pdf-lib not loaded — uploading original file.');
        return file;
      }

      const originalBytes = new Uint8Array(await file.arrayBuffer());

      // pdf.js needs its own copy of the buffer (it may detach/transfer it)
      const srcDoc = await window.pdfjsLib.getDocument({ data: originalBytes.slice() }).promise;
      const numPages = srcDoc.numPages;

      const outDoc = await window.PDFLib.PDFDocument.create();
      const scale = TARGET_DPI / 72; // PDF units are 1/72 inch

      for (let n = 1; n <= numPages; n++) {
        onProgress?.(`جارٍ ضغط الملف… صفحة ${n} من ${numPages}`);

        const page = await srcDoc.getPage(n);
        const baseViewport = page.getViewport({ scale: 1 }); // true PDF point dimensions
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; // opaque background for any transparent scan areas
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        await page.render({ canvasContext: ctx, viewport }).promise;

        const jpegBytes = await new Promise((resolve, reject) => {
          canvas.toBlob(
            (blob) => {
              if (!blob) { reject(new Error('canvas.toBlob returned null')); return; }
              blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf))).catch(reject);
            },
            'image/jpeg',
            JPEG_QUALITY
          );
        });

        // Free the canvas ASAP — matters on long documents (50+ pages)
        canvas.width = 0;
        canvas.height = 0;

        const jpgImage = await outDoc.embedJpg(jpegBytes);
        const outPage = outDoc.addPage([baseViewport.width, baseViewport.height]);
        outPage.drawImage(jpgImage, {
          x: 0,
          y: 0,
          width: baseViewport.width,
          height: baseViewport.height,
        });
      }

      // ── Safety net 1: page count must match exactly ──
      if (outDoc.getPageCount() !== numPages) {
        console.warn('[PDFCompressor] Page count mismatch — uploading original file.');
        return file;
      }

      const compressedBytes = await outDoc.save();

      // ── Safety net 2: only use it if it's actually smaller ──
      if (compressedBytes.byteLength >= originalBytes.byteLength) {
        console.info('[PDFCompressor] Original already smaller/optimized — uploading original file.');
        return file;
      }

      return new File([compressedBytes], file.name, { type: 'application/pdf' });

    } catch (err) {
      // ── Safety net 3: never block an upload because compression failed ──
      console.error('[PDFCompressor] Compression failed, uploading original file:', err);
      return file;
    }
  },
};
