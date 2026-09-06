#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   OBFUSCATED BUILD (opt-in)
   ───────────────────────────────────────────────────────────────
   Copies the whole site into dist/, running every first-party JS
   file under js/ through javascript-obfuscator on the way. Third-
   party CDN files (jsdelivr) are left completely alone — they're
   pinned by SRI hash (see index.html), and re-obfuscating someone
   else's already-minified library would just break that hash for
   zero benefit, since the point of obfuscating YOUR code is to slow
   down someone reverse-engineering YOUR logic, not theirs.

   WHY THIS ISN'T WIRED INTO vercel.json AUTOMATICALLY: the current
   deploy has NO build step at all (outputDirectory: "." — Vercel
   serves the repository's own source files as-is). Pointing
   vercel.json at a dist/ folder instead is a real, separate change
   to how this site deploys, and this environment has no way to
   actually load the obfuscated output in a browser and click through
   the app to confirm nothing subtle broke — aggressive obfuscation
   (control-flow flattening especially) occasionally trips over code
   that relies on function.name, on a specific call stack depth, or
   on toString()-ing a function, none of which this codebase currently
   does as far as this pass found, but "as far as this pass found" is
   not the same guarantee as "tested in a real browser." Run this,
   manually smoke-test the app served from dist/ (e.g. `npx serve
   dist`), and only THEN switch vercel.json's outputDirectory once
   you're confident — flipping it blind is how a working site becomes
   a broken deploy.

   Usage:
     npm install --save-dev javascript-obfuscator   (one-time)
     node scripts/build-obfuscated.js
     npx serve dist                                  (smoke-test)
═══════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT  = path.join(ROOT, 'dist');

// Top-level entries copied into dist/ as-is; everything under js/ is
// obfuscated instead of plain-copied (see the loop below).
const COPY_ENTRIES = [
  'index.html', 'css', 'assets', 'manifest.json', 'sw.js',
  'supabase' // Edge Function source — not served to the browser at all, but harmless/expected to carry along for a "the whole deployable tree" build
];

function rimraf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function obfuscateDir(srcDir, destDir, obfuscator) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir)) {
    const srcPath = path.join(srcDir, entry);
    const destPath = path.join(destDir, entry);
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      obfuscateDir(srcPath, destPath, obfuscator);
      continue;
    }
    if (!entry.endsWith('.js')) { fs.copyFileSync(srcPath, destPath); continue; }

    const source = fs.readFileSync(srcPath, 'utf8');
    const result = obfuscator.obfuscate(source, {
      compact: true,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.75,
      deadCodeInjection: true,
      deadCodeInjectionThreshold: 0.3,
      stringArray: true,
      stringArrayEncoding: ['base64'],
      stringArrayThreshold: 0.75,
      identifierNamesGenerator: 'hexadecimal',
      renameGlobals: false,       // would break window.App.* consumed from inline onclick="" handlers in index.html
      selfDefending: true,
      disableConsoleOutput: false, // keep console.warn/error for real production debugging — this app already avoids logging sensitive data (see AGENTS/code comments), so nothing sensitive is hidden by turning this off
      sourceType: 'module',       // these are all type="module" ES files — must be told so, or import/export syntax fails to parse
      target: 'browser',
    });
    fs.writeFileSync(destPath, result.getObfuscatedCode(), 'utf8');
  }
}

function main() {
  let obfuscator;
  try {
    obfuscator = require('javascript-obfuscator');
  } catch (_) {
    console.error('javascript-obfuscator is not installed. Run:\n  npm install --save-dev javascript-obfuscator\nthen re-run this script.');
    process.exit(1);
  }

  rimraf(OUT);
  fs.mkdirSync(OUT, { recursive: true });

  for (const entry of COPY_ENTRIES) {
    const srcPath = path.join(ROOT, entry);
    if (fs.existsSync(srcPath)) copyRecursive(srcPath, path.join(OUT, entry));
  }

  obfuscateDir(path.join(ROOT, 'js'), path.join(OUT, 'js'), obfuscator);

  console.log(`✅ Obfuscated build written to ${OUT}`);
  console.log('   Smoke-test it before touching vercel.json:');
  console.log('     npx serve dist');
}

main();
