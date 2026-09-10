# Vendored third-party libraries

These files used to be loaded live from `cdn.jsdelivr.net` on every app boot
(see index.html's git history). That meant true offline support — a fresh
install opened for the first time with no connectivity, or any device whose
WebView HTTP cache got cleared (low storage, OS cache eviction, etc.) — was
never actually guaranteed: the whole app, not just the PDF viewer, depended
on these four scripts happening to already be sitting in the WebView's
ambient cache from an earlier online session. They're bundled locally here
instead so the app is offline-capable by construction, not by accident.

## Versions (must match index.html's `<script src="vendor/...">` tags)

| Package                | Version | File(s)                                    |
|-------------------------|---------|---------------------------------------------|
| @supabase/supabase-js  | 2.115.0 | `supabase-js/supabase.js`                   |
| dompurify              | 3.1.6   | `dompurify/purify.min.js`                   |
| pdfjs-dist             | 3.11.174| `pdfjs-dist/pdf.min.js`, `pdf.worker.min.js`, `cmaps/` |
| pdf-lib                | 1.17.1  | `pdf-lib/pdf-lib.min.js`                    |

## Provenance

Every file here was downloaded directly from the npm registry
(`registry.npmjs.org/<package>/-/<package>-<version>.tgz`) — a different
source than jsdelivr — and its SHA-384 hash was verified to match the
Subresource Integrity hash that was already pinned in index.html's old CDN
`<script>` tags before those tags were removed. That confirms these are the
exact same bytes the app was already trusting, not a substitute.

## Updating a version

1. Download the new tarball from `registry.npmjs.org`, extract the same
   file(s) listed above.
2. Replace the corresponding file(s) in this folder.
3. Update the version in the table above AND in the file-path comments in
   `index.html` / `js/pdfViewer.js` (the pdfjs-dist version number appears
   in comments there, not in any path, since these are local paths now).
4. Re-run `cap sync` and the Android build to confirm nothing broke.

There is deliberately no `integrity="..."` attribute on the local
`<script>` tags in index.html the way there was for the old CDN ones — SRI
protects against a *third-party host* serving different bytes than expected;
it adds nothing once the file is already inside this app's own signed
package, where the OS's own app-signing verification is the relevant
protection instead.
