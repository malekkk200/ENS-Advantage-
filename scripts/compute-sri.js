#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   COMPUTE SRI HASHES
   ───────────────────────────────────────────────────────────────
   Run this any time a version in the list below is bumped, then
   paste the printed integrity="..." value into BOTH index.html and
   mobile-app/www/index.html — see the comment above the <script>
   tags there for why hand-typing a hash instead of generating it is
   the one thing NOT to do here.

   Usage:  node scripts/compute-sri.js

   Fetches each package straight from the npm registry (the actual
   published tarball, not the CDN) and hashes the exact file jsdelivr
   serves for it — this only works because jsdelivr's /npm/ endpoint
   is guaranteed to mirror a package's tarball contents byte-for-byte;
   don't reuse this approach for a CDN (like cdnjs) that builds/
   packages its own copies independently of npm.
═══════════════════════════════════════════════════════════════ */
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const { Readable } = require('stream');

// Add/edit an entry here, then re-run.
const TARGETS = [
  { pkg: '@supabase/supabase-js', version: '2.115.0', fileInTarball: 'dist/umd/supabase.js' },
  { pkg: 'dompurify',             version: '3.1.6',   fileInTarball: 'dist/purify.min.js' },
  { pkg: 'pdf-lib',               version: '1.17.1',  fileInTarball: 'dist/pdf-lib.min.js' },
  { pkg: 'pdfjs-dist',            version: '3.11.174',fileInTarball: 'build/pdf.min.js' },
  { pkg: 'pdfjs-dist',            version: '3.11.174',fileInTarball: 'build/pdf.worker.min.js' },
];

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ens-advantage-sri-tool' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchBuffer(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} for ${url}`)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// Minimal tar reader — just enough to pull one named file out of an
// npm package tarball without adding a dependency for it.
function extractFromTar(tarBuffer, targetPath) {
  let offset = 0;
  const wanted = `package/${targetPath}`;
  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeOctal, 8) || 0;
    offset += 512;
    if (name === wanted) return tarBuffer.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
  }
  return null;
}

async function main() {
  for (const { pkg, version, fileInTarball } of TARGETS) {
    const metaUrl = `https://registry.npmjs.org/${pkg}/${version}`;
    const meta = JSON.parse((await fetchBuffer(metaUrl)).toString('utf8'));
    const tarballUrl = meta.dist.tarball;
    const gz = await fetchBuffer(tarballUrl);
    const tar = zlib.gunzipSync(gz);
    const fileBuf = extractFromTar(tar, fileInTarball);
    if (!fileBuf) { console.error(`❌ ${pkg}@${version}: ${fileInTarball} not found in tarball`); continue; }
    const hash = crypto.createHash('sha384').update(fileBuf).digest('base64');
    console.log(`${pkg}@${version} :: ${fileInTarball}`);
    console.log(`  integrity="sha384-${hash}"\n`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
