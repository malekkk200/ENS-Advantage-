# ENS Advantage

Academic platform for ENS English Department students — summaries, full lessons,
and strategic guides, backed by Supabase.

This repo is a **refactor** of a single 3,500-line HTML file into a clean,
modular static site: separate CSS files, ES6 JavaScript modules, and a
lightweight `index.html` that only holds structure. No build tool, no
bundler, no framework — it runs as plain files, which keeps it trivial to
host on Vercel or GitHub Pages and easy for a future you (or any other
contributor) to navigate.

## Folder structure

```
.
├── index.html              # Structure only — links CSS, loads js/main.js
├── css/                     # 7 thematic stylesheets (see below)
├── js/                      # ES6 modules — one feature per file (see below)
├── assets/
│   └── logo.jpg              # Extracted from the base64 data-URI that used
│                              # to be embedded inline in the HTML
├── scripts/
│   └── inject-env.js         # Optional Vercel build step (see "Config" below)
├── vercel.json                # Deployment config
├── package.json                # Just enough for `npm run build` to work
├── .env.example                 # Optional — see "Config" below
└── .gitignore
```

### `css/` — one file per screen area, loaded in cascade order

| File | Covers |
|---|---|
| `base.css` | Font import, CSS reset, design tokens (`:root` variables), scroll-reveal animation primitives |
| `auth-header-hero.css` | Login/signup screen, site header, hero section |
| `sections-content.css` | Section wrappers, grading-system cards, curriculum accordion, content viewer |
| `subscription-badges.css` | "Get Premium" modal, plan cards, membership badges, community strip, footer, print/responsive rules |
| `protection-admin.css` | Anti-copy/anti-screenshot CSS layer, admin upload panel |
| `pdf-viewer.css` | The secure canvas PDF viewer (toolbar, watermark, skeleton loader, security notice) |
| `calculator.css` | Grade calculator |

They're split by **screen area**, not arbitrarily, so if you're working on
(say) the subscription modal, there's exactly one file to open.

### `js/` — one module per feature, ES6 `import`/`export` throughout

| File | Exports | Responsibility |
|---|---|---|
| `config.js` | `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Project connection constants |
| `supabaseClient.js` | `sb`, `Supabase` | Supabase client + Edge Function fetch helpers |
| `state.js` | `State` | The single mutable app-state object every other module reads/writes |
| `dom.js` | `$`, `escHtml`, `initScrollReveal` | DOM shorthand, HTML-escaping, scroll-reveal |
| `curriculum.js` | `Curriculum` | Module/UE data loaded from the DB |
| `courseMaterials.js` | `CourseMaterials` | PDF metadata cache (semester × module × category) |
| `router.js` | `render` | Top-level "which screen should be showing" decision |
| `realtime.js` | `Realtime` | `postgres_changes` subscription for live profile updates |
| `auth.js` | `Auth` | Login / signup / OTP / password reset / logout |
| `ui.js` | `UI` | Header, dropdown, auth-screen/main-app switching |
| `modules.js` | `Modules` | Semester tabs + module list rendering/expansion |
| `content.js` | `Content` | HTML-fallback lesson/guide viewer |
| `pdfViewer.js` | `PDFViewer` | Secure canvas-based PDF renderer (primary content path) |
| `protection.js` | `Protection` | Anti-copy / anti-screenshot measures |
| `subscription.js` | `Subscription` | "Get Premium" modal + request submission |
| `community.js` | `Community` | Help popover + Telegram community card |
| `calc.js` | `Calc` | Grade calculator |
| `adminPanel.js` | `AdminPanel` | No-code admin PDF upload panel |
| `listeners.js` | *(none — side effects only)* | Document-level `keydown`/`mousedown` handlers |
| `main.js` | *(none — entry point)* | Imports everything, wires `window.App`, boots the app |

`index.html` loads exactly one script: `<script type="module" src="js/main.js">`.
Every inline `onclick="App.Auth.login()"` handler still works exactly as
before — `main.js` wires the same `window.App` namespace the original file
did, so zero HTML markup changes were needed beyond the CSS/script tags.

**A note on the module graph:** a few modules import each other in both
directions (e.g. `ui.js` ↔ `adminPanel.js`, `ui.js` ↔ `realtime.js`). This is
intentional and safe — ES modules fully support circular imports as long as
nothing runs *at import time* off the circular binding, and here every
cross-module reference happens inside a method body (`open()`, `setup()`,
etc.) that only runs later, in response to a user action or the final boot
call. Browsers handle this correctly out of the box.

## Config: the Supabase key is meant to be public

`js/config.js` contains the Supabase project URL and **anon** key directly.
This is not an oversight — Supabase's security model relies on Row Level
Security (RLS) policies on your tables/storage buckets, not on hiding this
key, and it's designed to be shipped in client-side JS. ([Supabase docs](https://supabase.com/docs/guides/api/api-keys))
This app already has RLS + signed URLs doing the real access control (see
`pdfViewer.js` and the Edge Functions), so there's nothing extra to lock down
here.

If you'd still like to swap Supabase projects (e.g. a staging environment)
without touching code, `scripts/inject-env.js` will overwrite `js/config.js`
from `SUPABASE_URL` / `SUPABASE_ANON_KEY` environment variables. It's **not**
wired into the deploy by default (a missing/partially-uploaded `scripts/`
folder previously broke the Vercel build for this reason) — it's entirely
opt-in. To use it, run `npm run inject-env` yourself before deploying, or
add `node scripts/inject-env.js` back as a custom build command in your own
Vercel project settings.

## Running locally

No build step required. Any static file server works, e.g.:

```bash
npx serve .
# or
python3 -m http.server 8000
```

Then open the printed URL. (Opening `index.html` directly via `file://`
will *not* work — ES module imports require an HTTP origin.)

## Deploying

### Vercel
1. Push this repo to GitHub.
2. Import the repo in Vercel → Framework Preset: **Other**.
3. Leave the build command empty — this is a zero-build static site by
   default. Vercel will just serve the files as-is.
4. Deploy. `index.html` at the repo root is picked up automatically.

### GitHub Pages
1. Push this repo to GitHub.
2. Settings → Pages → Deploy from branch → root.
3. Done — no build step needed at all.

## PDF viewer

`pdfViewer.js` / `pdf-viewer.css` render documents full-screen (edge-to-edge
overlay, no rounded modal box) with **continuous vertical scroll** — every
page is its own canvas, stacked top to bottom, so reading is one natural
scroll/swipe gesture instead of a page-at-a-time carousel. Notable behavior:

- **Continuous scroll, lazily rendered**: `PDFViewer._buildPages()` creates
  one correctly-sized wrapper+canvas per page up front (so scroll height/
  proportions are right immediately), but only actually rasterizes a page's
  canvas once it's within ~1.5 screens of the viewport (`IntersectionObserver`,
  see `RENDER_MARGIN`). This matters for longer documents — rendering 100+
  pages at once on open would be slow and memory-heavy for no benefit.
- **Jump to page**: the page-number field in the toolbar is a real `<input>`
  — type a number and press Enter (or tap away) to scroll straight to it.
- **Resume where you left off**: as you scroll, a throttled scroll listener
  tracks whichever page is currently at the top of the viewport and saves it
  to `localStorage`, keyed per-user-per-document
  (`pdfProgress:<userId>:<materialId>`). Reopening the same document scrolls
  straight back to that page. Client-side only by design — a pure
  convenience feature with no access-control implications, so it doesn't
  need a Supabase round-trip. If you want it to sync across a student's
  devices later, `_saveProgress`/`_loadSavedPage` in `pdfViewer.js` are the
  two functions that would need to become a `reading_progress` table write.
- **Rendering quality**: canvas backing-store resolution is capped at 3×
  device pixel ratio (was 2×) — most current phones run 2.5–3×, so the old
  cap was visibly softening text on modern screens.

## Admin panel — who can access it, and where the real gate lives

The upload/delete panel is restricted to exactly one account:
`rahalmalik2018@gmail.com`. This is enforced in **three places**, and only
one of them actually matters for security:

1. `js/adminPanel.js` — hides the "📤 رفع درس جديد" button and blocks
   `AdminPanel.open()` for anyone else. **This is UI convenience only.**
   Anyone could bypass it instantly via browser dev tools.
2. `admin-upload-material` Edge Function — re-checks the caller's email
   (resolved server-side from their JWT, not anything sent in the request)
   before writing to storage or the DB.
3. `admin-delete-material` Edge Function (new) — same check, before
   deleting a storage object + its `course_materials` row.

**#2 and #3 are the actual security boundary.** The email is a hardcoded
constant (`AUTHORIZED_ADMIN_EMAIL`) in both functions rather than an
`is_admin` database column, deliberately — a flag on a table is one
accidental `UPDATE` away from granting access to the wrong account, which
had in fact already happened: at the time this was implemented, the
`is_admin` flag was set on a *different*, similarly-named account
(`rahalmalik18@gmail.com`) instead of the intended one. That's been
corrected in the database, but the panel no longer depends on that column
at all — changing who's authorized now means editing the email constant in
`js/adminPanel.js` **and both Edge Functions**, then redeploying the
functions (`supabase functions deploy admin-upload-material` /
`admin-delete-material`, or via the Supabase dashboard).

**Delete**: each row in the admin panel's existing-materials list has a 🗑️
button. It confirms once (irreversible — deletes the storage file *and* the
DB row), then calls `admin-delete-material` and refreshes both the admin
list and the student-facing module cards.

## Local SEO

The `<head>` in `index.html` targets first-year English Department students
searching (in French, English, and Arabic) across five Algerian ENS
campuses: **ENS Kouba, ENS Constantine, ENS Ouargla, ENS d'Oran, ENS Sétif
(Messaoud Zeghar)**. It includes:

- A keyword-blended `<title>` and `<meta name="description">` — natural
  sentences, not keyword-stuffed lists, since Google's ranking algorithms
  actively discriminate against stuffing.
- `<meta name="keywords">` — included because it was explicitly requested,
  but worth knowing: Google has publicly ignored this tag since 2009. It's
  harmless to keep for the handful of smaller search engines that still
  read it, just don't expect it to move the needle on Google rankings.
- Open Graph + Twitter Card tags, so links shared in WhatsApp/Telegram/Facebook
  groups (how Algerian students actually circulate study resources) render
  a proper title/description/image preview instead of a bare URL.
- A `schema.org` JSON-LD `WebSite` block — this is what actually earns rich
  results in Google today. It describes ENS Advantage as a platform *serving*
  students from these campuses, deliberately not claiming to *be* any of
  those official institutions.

**What would move rankings further** (not yet done, needs decisions only
you can make):
- A **Google Search Console** verification + sitemap submission — metadata
  alone doesn't get a new site crawled quickly.
- **Per-campus landing content** — right now all five campuses share one
  homepage. A real local-SEO win usually comes from a dedicated paragraph,
  or even a dedicated route (e.g. `/ens-kouba`), per campus with unique
  content, not just repeating names in metadata.
- **Backlinks** from each ENS's own student union pages/social groups, if
  you can get them — for a niche multi-campus audience like this, that
  usually outperforms on-page tweaks alone.

## Editing guide

- **Changing a color, spacing, or animation** → find the relevant file in
  `css/` from the table above.
- **Changing app behavior** (a button's logic, a new Supabase query, etc.)
  → find the relevant file in `js/` from the table above. Most files are
  100–350 lines, short enough to read end-to-end.
- **Adding a brand-new feature module** → create `js/yourFeature.js` with
  `export const YourFeature = { ... }`, import what it needs from other
  modules, import it into `main.js`, and add it to the `window.App = { ... }`
  object if any inline HTML `onclick` needs to reach it.
