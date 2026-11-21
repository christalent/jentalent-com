# Changelog

## 2026-11-21 — Fixed: the entry dialog did not scroll, and the preview box rendered as a broken image

Two separate bugs, both found by Jen looking at the live site on a phone.

### The dialog did not scroll

The modal had `max-height: 90vh; overflow-y: auto` on its content, so it
*could* scroll — but the page behind it scrolled instead, and the fixed
dialog drifted away from the viewport. The Save button was unreachable.

- **`body.modal-open { overflow: hidden }` never stopped the document
  scrolling.** `overflow: hidden` on `<body>` only works when `<html>` is
  the scrolling element; here `<html>` was, so the page scrolled and the
  fixed overlay did not follow. The lock is now applied to `<html>` as
  well, and `log.js` adds and removes the class on `document.documentElement`.
- **`align-items: center` on the flex overlay clipped tall content at the
  top** instead of letting it scroll from the start. Changed to
  `flex-start`, with the overlay itself scrolling
  (`overflow-y: auto`, `overscroll-behavior: contain`).
- **The height cap now uses `dvh`** — `calc(100dvh - 2rem)` with a
  `calc(100vh - 2rem)` fallback — so the dialog accounts for mobile
  browser chrome as it collapses. `dvh` is the unit that tracks the
  collapsing address bar; `vh` does not.
- `.modal-content` keeps `margin: auto` so short dialogs stay vertically
  centered.

### The preview box rendered as a broken image

This was the more subtle one, and it was a **site-wide latent bug**.

- **The `[hidden]` attribute was being overridden.** The UA stylesheet's
  `[hidden] { display: none }` has very low specificity, so
  `.image-preview { display: flex }` beat it. The JavaScript set
  `preview.hidden = true` and the code *believed* the box was hidden — but
  it was rendering the whole time, with no image source, which the browser
  draws as a broken-image icon with the alt text wrapped into a cramped
  multi-line block. There was **no `[hidden]` rule anywhere in the
  stylesheet**. Any hidden element with a `display` property had this bug.
  Fixed with a global `[hidden] { display: none !important; }`, which
  protects every hidden element now and in future.
- **The preview `<img>` shipped with `src=""`.** An empty `src` makes the
  browser request the current page URL and render the alt text as a
  broken image. The attribute is now omitted entirely.
- The preview image now carries `min-width`/`min-height` and
  `color: transparent`, so a sourceless image collapses instead of
  wrapping into an unreadable block.

### Edge cache: stale assets after deploy

The origin sits behind an edge cache (`via: e7s`) that serves static
assets by URL and will hand back a stale stylesheet after a deploy — this
is why the fix looked un-applied on first verification.

- **The NFSHost account does not support `.htaccess` for cache headers.**
  `mod_headers` is absent; adding an `.htaccess` with a `Header set`
  directive produced a **500 on every CSS and JS request**. Removed
  immediately. The account's `.htaccess` support is limited to
  `AllowOverride`-permitted directives, which does not include
  `mod_headers`.
- **The version query on asset references is therefore the only lever.**
  Every `style.css`, `main.js` and `log.js` reference across all four
  pages now carries `?v=<version>`.
- **`deploy.sh` bumps the version automatically**, so a deploy can never
  ship stale-cached assets again. It also runs the syntax checks
  (`node --check`, `php -l`) before syncing.

### Tests

The suite grew from 97 to **106 assertions** (65 unit + 41 live API
integration). Nine new regression tests cover the global `[hidden]` rule,
the absence of an empty `src` on the preview image, the modal scroll
rules, the `dvh`/`vh` height caps, and the `<html>` scroll lock in both
the CSS and the JavaScript.


## 2026-11-21 — Open items tracked as GitHub Issues

No functional change. The remaining work on the notary log was written down
rather than left in a chat thread, in the repo's existing convention — issues
under the Issues tab.

- **#11 — Backup and durability for the notary log.** The log data is the
  only thing on this site that cannot be rebuilt from the repo: the SQLite
  database and the uploaded ID images live in `/home/tmp/log-data` on
  NFSHost, outside the webroot and outside git. Candidate paths are rclone
  to the existing cloud remotes and/or a local copy on BOSGAME, or moving
  the whole application onto BOSGAME. Records the constraints that apply to
  any option — most importantly, never copy a live SQLite database
  directly, and decide a retention period before a recurring job exists.
- **#12 — Rotate the PIN off the chat log.** The PIN was supplied over
  Discord, so it is in a transcript. Deferred during prototyping.
- **#13 — Reimplement "Clear All Entries."** Removed with the localStorage
  rewrite and not yet replaced.
- **#14 — Notarial compliance fields.** Time of the act, venue/county, and
  signer address are still missing under RCW 42.45.180.
- **#15 — Remaining code-review items.** Dialog role placement,
  skip-to-content link, combined stat live regions, cache/CSP headers,
  deferred `main.js`.
- **#16 — Encrypt the uploaded ID images at rest.**
- **#17 — Merge the branch into master.**
- **#18 — Rewrite the stale README.**

`OPEN-ITEMS.md` holds the long-form version of the same list.


## 2026-11-21 — Identification type and identification number fields

Added at Jen's request, between Notes and the image attachment.

- **"Identification Type"** is a select with the four options in
  alphabetical order: Driver's License, Passport, State ID, Thumb Print.
- **"Identification Number / Details"** is a free-text field below it, for
  the ID number or, in the case of a thumb print, whatever detail the
  notary records.
- Both fields are optional, but an ID number **requires** a type — the
  server rejects an entry that has one without the other, in both
  directions.
- The identification type is validated **server-side** against an
  allow-list. The client cannot smuggle an arbitrary string into the
  field.
- The table gains an **Identification** column showing `Driver's License —
  WA-DL-99887766`.
- The CSV export gains **Identification Type** and **Identification Number**
  columns.
- The existing database was migrated in place with `ALTER TABLE ADD
  COLUMN`, guarded by a `PRAGMA table_info` check so the migration is
  idempotent and re-runnable.

### Tests

- The suite grew from 77 to **97 assertions** (56 unit + 41 live API
  integration). New coverage: the identification label rendering, the
  dropdown options and their alphabetical order, the field order in the
  form (Notes -> Identification Type -> Identification Number -> Image),
  the table column, the API round-trip of both fields, rejection of an
  unknown identification type, and rejection of an ID number with no type.


## 2026-11-21 — Server-backed notary log: PIN, images, "Other" type

Jen's requirements for the notary log. The log moves off `localStorage` and
onto the server, so it works from any device — phone, laptop, desktop.

### Added — server-side storage

- **The log now lives in a server-side SQLite database**, not in the
  browser. `localStorage` meant a phone and a laptop held two different
  logs. The database is at `/home/tmp/log-data/notary.db`, outside the
  webroot, so it cannot be fetched by URL (verified: every path returns
  404).
- **The log is reachable from any device.** Sign in from the phone, add an
  entry, and it shows up on the desktop.
- **A PIN gate protects the log.** The PIN is verified **server-side** — it
  is not in the page source, where anyone could read it. It is stored as a
  PBKDF2-HMAC-SHA256 hash (120,000 iterations, random salt) and the
  one-time setup file is deleted after first use. The plaintext PIN appears
  nowhere on disk.
- **Sessions are proper cookies**: `HttpOnly`, `Secure`, `SameSite=Lax`,
  8-hour lifetime. `HttpOnly` means JavaScript cannot read the session, so
  an XSS bug cannot exfiltrate it.
- **Rate limiting.** Five wrong PINs triggers a 15-minute lockout, which
  makes brute-forcing the six-digit PIN impractical.

### Added — image attachments

- **Entries can carry a photo of a driver's license or other ID.** Accepts
  JPEG, PNG, WebP or HEIC, up to 8 MB.
- **The file type is sniffed on the server** with `finfo`, not trusted from
  the client's declared MIME type, so a renamed executable cannot be
  stored and served as an image.
- **Uploaded files are never web-reachable.** They are written to
  `/home/tmp/log-data/uploads/` (mode 0600) and served only through an
  authenticated endpoint that looks the filename up from the entry id.
- **Deleting an entry deletes its image** — no orphaned ID photos left on
  the server.
- **Storage is unencrypted.** The files are protected by the PIN and the
  webroot boundary, not by encryption at rest.

### Added — "Other" document type

- **"Other" is now an option under Document Type**, and the dropdown is
  sorted alphabetically.
- **Selecting "Other" reveals a description field.** It is required, so an
  entry can't be saved as a bare "Other" with no detail. The table shows
  it as `Other — Vehicle Title`.

### Changed

- **"Stored in this browser, on this device" is now "Stored on the server,
  protected by a PIN."** The old copy was accurate for the old
  implementation; it would have been a lie for the new one.
- **"Clear All Entries" was removed.** It was a `localStorage` operation and
  had no server-side equivalent. It has not been replaced — see below.
- **The Document Type dropdown is alphabetical.** "Travel Consent" sorts
  before "Trust"; a test asserts the order so it cannot regress.

### Security notes

- The PIN (`884000`) was supplied over chat and is therefore in a chat log.
  It should be rotated to something not shared in a transcript.
- A six-digit PIN with an 8-hour session is thin protection for state ID
  photos. The lockout and server-side verification are what make it
  non-trivial to guess, but a longer passphrase would be materially better.
- `/home/tmp` is the only PHP-writable path on this host. It sits outside
  the webroot, but NFSHost should be asked whether `/home/private` can be
  made writable — that would be the better home for the database.

### Tests

- The suite grew from 68 to **77 assertions** (45 unit + 32 live API
  integration against the deployed endpoint). The live layer covers auth
  rejection, the create/list/edit/delete round-trip, validation rejections,
  logout, and a full image round-trip: upload, fetch with a session, byte
  equality, 401 without a session, and removal on delete.
- A new test asserts the Document Type dropdown is alphabetical.
- Three bugs were found and fixed during this work:
  - The image endpoint required a `file` parameter the client never sent,
    so every image fetch 404'd. The filename is now looked up from the
    entry id.
  - The Document Type dropdown had "Trust" before "Travel Consent".
  - The image test ran after the entry was deleted, so it tested a 404
    against a missing entry rather than the image path.

### Still outstanding

- **"Clear All Entries" needs reimplementing** as a server-side bulk
  delete with typed confirmation.
- The notarial fields RCW 42.45.180 requires (time, venue/county, signer
  address, identification method) are still absent.
- The log page has no `Cache-Control`/`CSP` headers of its own.
- `role="dialog"` is still on the modal wrapper rather than
  `.modal-content`; there is still no skip-to-content link.


## 2026-11-21 — Notary log integrity + accessibility overhaul

Follows a full code review of the repo. The JS was disciplined (no XSS, no
exfiltration, no prototype pollution), but two genuine **data-loss paths**
existed in the notary log. Both are closed, along with the accessibility and
real-world failure modes that review surfaced.

### Fixed — data integrity

- **Corrupt store no longer destroys the journal (data loss).** `loadEntries()`
  caught a `JSON.parse` failure, returned `[]`, and the next `saveEntries()`
  **overwrote the original key** — one stray byte silently destroyed every
  record, with only a `console.warn`. Now the raw bytes are copied to
  `notaryLogEntries.corrupt.<timestamp>` before anything else can overwrite
  them, a persistent banner explains what happened, and the app **refuses to
  write over a known-corrupt store** until it is restored. The backup is
  written once per distinct corrupt value, not once per page load.
- **Multi-tab clobbering (data loss).** `entries` was a per-tab in-memory array
  and every save rewrote the whole thing. With no `storage` listener and no
  re-read before write, a save in tab B erased tab A's records with no error
  and no undo. Saves now merge with the stored copy before writing, and a
  `storage` listener pulls in changes made in other tabs.
- **A delete is no longer undone by the next save.** The merge above keeps
  records written by other tabs — which meant a deleted record was
  immediately resurrected from the stored copy. Deletions are now recorded as
  tombstones in `notaryLogEntries.deleted`, so they survive both the next save
  and a page reload. (Found by browser testing, not by the original review.)
- **Entries are identified by stable UUID, not array index.** `openEditModal()`
  stored an array *position*; any change to the array between open and save
  shifted that index, so an edit could **overwrite a different client's
  record**. Entries now carry a `crypto.randomUUID()` id and edit/delete
  resolve by id lookup. Legacy records without an id are assigned one on load.
- **An unparsable id no longer turns an edit into a duplicate add.** An id
  that matches no record is now an error, not a silent `entries.push()`.
- **A failed write is reported and rolled back.** A quota error or blocked
  storage now surfaces a message instead of losing the text the notary just
  typed.

### Fixed — accessibility

- **Focus is no longer lost after every edit and delete.** `saveEntry()`
  re-rendered the table *before* closing the modal, destroying the Edit button
  that `showModal()` had captured — `closeModal()` then called `.focus()` on a
  detached node, a no-op. Focus now moves to the equivalent row's Edit button
  after a save, and to the next row after a delete.
- **Every row's buttons now have distinct accessible names.** All Edit buttons
  announced "Edit entry" and all Delete buttons "Delete entry", so a screen
  reader heard a flat indistinguishable list. They now read
  "Edit entry for {client}".
- **Mobile navigation now works without JavaScript.** Under 768px the desktop
  nav was hidden and the mobile menu needed JS to become visible — with
  scripting blocked or failed to load, a mobile visitor had **zero navigation**
  and no indication a menu existed. The menu is now progressively enhanced: a
  `no-js`/`js` class on `<html>` shows the link list by default.
- **The mobile menu is dismissible.** It closed only on link click and Escape,
  so an open menu stayed over the content the user just tapped. It now also
  closes on outside click, on scroll, and on resize past the breakpoint.
- **Validation errors are announced.** A missing required field was a silent
  no-op relying on native validation; it now focuses the offending field and
  shows the message in a `role="alert"` region.
- **The mobile menu is a navigation landmark.** The `<ul id="mobileMenu">` sat
  outside the `<nav>` element, so its links were not part of any landmark.
- **Focus indication.** The stylesheet had **zero** `:focus`/`:focus-visible`
  rules, leaving indication to whatever the UA default happened to be.
  Added a 3px `:focus-visible` outline.
- **`prefers-reduced-motion`** is now honoured — the stylesheet animated
  transitions and `main.js` scrolled smoothly with no opt-out.
- **`@media print`** rules now strip the site chrome, so printing the log
  produces the table rather than the whole website.

### Fixed — real-world notary failure modes

- **`maxlength` on the text fields.** `clientName` and `notes` accepted
  unbounded input; a pasted 2 MB note exceeded the ~5 MB quota, the write
  failed, and the notary lost the text with no way to recover it. Now 120 and
  1,000 characters.
- **The date field cannot be set in the future** — no notarial act can be
  dated ahead.
- **CSV export has a UTF-8 BOM.** `José Ramírez` rendered as `JosÃ© RamÃrez`
  in Excel (the Windows default). The export now starts with `\uFEFF`.
- **The blob URL is no longer revoked synchronously.** `revokeObjectURL()`
  fired in the same tick as `a.click()`, which can cancel the download in
  Firefox/Safari — "Export CSV" silently produced no file. It is now deferred.
- **The CSV formula guard covers LF and leading whitespace.** The pattern was
  `/^[=+\-@\t\r]/` — LF was missing despite being in the OWASP set, and a
  cell starting with `" ="` was not prefixed even though a spreadsheet that
  trims leading whitespace would evaluate it. Leading whitespace is now
  handled, while ordinary leading whitespace in a non-formula cell is
  preserved verbatim rather than silently altered.
- **Impossible dates are rejected.** `new Date(2026, 1, 30)` rolls over to
  March 2, so the `NaN` guard never fired and a record dated `2026-02-30`
  displayed as "Mar 2, 2026" — a wrong date on a legal record. Dates are now
  round-trip validated.
- **Added a "Clear All Entries" control.** On a shared or borrowed machine the
  notary previously could not remove PII from `localStorage` without deleting
  entries one at a time. Requires typed confirmation.

### Changed

- **The log no longer claims to be secure.** `log.html` said "Track notarized
  documents and clients **securely**" and "Your data stays **private**" —
  false for unencrypted `localStorage` on a shared machine. The copy now
  states plainly that entries are stored in this browser on this device,
  unencrypted, and that this is a personal tracking aid, not the official
  notarial journal.
- **The public nav link is now "Local Log (private)"** rather than "Notary
  Log", so the site no longer advertises a notary engagement log to every
  visitor from all four public pages.
- **Dead CSS removed.** `credential-card`, `credential-detail`,
  `credential-icon`, `credential-meta`, `edu-block`, `link-inline`,
  `membership-list` and `resume-note` had no matching markup in any page.
  The latent `#888` contrast failure inside them (3.54:1, fails WCAG AA) is
  gone with them.
- **Form controls now inherit the page font.** `.btn`, `.btn-small` and the
  inputs set size and padding but no `font-family`, so on Linux/Android every
  button and field rendered in the UA default face.
- **Layout wraps on narrow screens.** `.log-stats`, `.log-buttons` and
  `.form-actions` were single-row flex with no `flex-wrap`, causing
  horizontal scroll at 320px.
- **`main.js` — dead `initSmoothScroll()` deleted.** There is not a single
  `href="#…"` in any HTML file.
- **Transitions narrowed** from `all 0.2s` to the specific properties
  animated, so layout-affecting properties are no longer animated.

### Tests

- The Node harness grew from 37 to **68 assertions**, covering the corrupt
  store round-trip, duplicate-backup prevention, multi-tab merging, delete
  tombstones (including across a simulated reload), UUID identity, impossible
  dates, and the full CSV injection matrix.
- The expanded suite caught two real defects during development: a
  temporal-dead-zone crash when loading a corrupt store, and a CSV trigger
  bug involving leading tabs. Both fixed.

### Not changed (decisions for Chris and Jen)

- The log is still a client-side tracker, not a legally sufficient journal —
  see the note below.
- Whether the localStorage log should be the system of record at all. If it
  must survive a device failure or serve as the journal of record, the real
  fix is a backend, not a better client-side store.
- The "Local Log (private)" nav entry itself — it is a product call whether
  to advertise a private log from a public site.

### Note for Chris and Jen

The notary log stores entries in `localStorage` only, and records neither the
time of the act nor the address of the signer. WA notary journals must record
the date *and time* of each act and the full name *and address* of each
individual, and be retained for 10 years (RCW 42.45.180). As it stands this
app is a convenience tracker, not a compliant journal. Adding address and time
fields, a backup/export path, and a PIN are product decisions, so nothing was
changed here.


## 2026-11-11 — Restore log page styles and harden the notary log

### Fixed

- **Restored the Notary Log page stylesheet (regression from `ed55dd8`).** Commit
  `ed55dd8` ("fix(log): extract broken inline script into log.js") removed the
  104-line inline `<style>` block from `log.html` and moved none of it into
  `style.css`. The `.modal` class had never existed in `style.css`, so
  `#entryModal` computed to `display: block; position: static` and the "Add
  Entry" form rendered inline in the page flow instead of as a hidden overlay —
  `openAddModal()` was a visual no-op and `closeModal()` could not hide it.
  The original rules were recovered from `ed55dd8^:log.html` and appended to
  `style.css` under a `/* === Notary Log === */` header. The page has no inline
  `<style>` block.
- **Fixed a timezone bug in the "This Month" counter.** `renderEntries()` parsed
  stored `YYYY-MM-DD` dates with `new Date(...)`, which treats them as UTC
  midnight — the previous local day in the Americas. Entries dated on the 1st
  of a month were counted in the previous month. Dates are now parsed as local
  time.
- **Fixed a timezone bug in the default entry date and CSV filename.**
  `openAddModal()` and `exportLog()` used `new Date().toISOString()`, which is
  UTC. In the evening Pacific, a new entry was pre-filled with *tomorrow's*
  date and the exported file was named with tomorrow's date. Both now use a
  local-date helper.
- **Fixed the search filter matching the action buttons.** `filterEntries()`
  matched `row.textContent`, which includes the literal "Edit" and "Delete"
  button labels, so searching for those words matched every row. The filter now
  matches only the data cells.
- **Fixed CSV formula injection.** `csvEscape()` quoted only on `,` `"` and
  newlines, so a client name like `=cmd|calc`, `@SUM(1+1)` or `+1+1` was written
  unquoted and executed as a formula when the export is opened in Excel or
  Google Sheets. Values starting with `=`, `+`, `-`, `@`, tab or CR are now
  prefixed with `'`.
- **Aligned CSV export order with the on-screen order.** `exportLog()` wrote
  rows in raw insertion order while the table sorts newest-first. The export now
  uses the same sort.
- **Preserved the active search filter across re-renders.** Adding, editing or
  deleting an entry re-rendered the table and dropped the filter; it is now
  re-applied.
- **Hardened `localStorage` handling.** A corrupt or hand-edited store (a
  `null` entry, a non-array, unparseable JSON) is now filtered to usable
  records instead of breaking rendering for every row. A failed write
  (quota exceeded, private browsing) now reports the failure and rolls the
  in-memory change back instead of silently losing the entry.

### Accessibility

- The add/edit dialog is now marked up as a real dialog
  (`role="dialog" aria-modal="true" aria-labelledby="modalTitle"`).
- Focus moves into the dialog when it opens and is restored to the trigger
  button when it closes (Escape, Cancel, backdrop click and the close button).
- Tab focus is trapped inside the open dialog.
- Background scrolling is locked while the dialog is open.
- The close button has an `aria-label` (it is a bare `&times;` glyph, so screen
  readers previously announced nothing).
- The search input has an associated `<label>`.
- The total-entries and this-month counters are `aria-live="polite"` status
  regions, so updates are announced.
- The table has a `<caption>` and `scope="col"` on its headers; the mobile menu
  button has `aria-expanded` and `aria-controls`, and the menu closes on
  Escape or after choosing a link.

### Changed

- **Removed the duplicate `toggleMobileMenu()` definition.** It was defined both
  in `main.js` and in an inline `<script>` at the bottom of `index.html`,
  `services.html` and `resume.html`; the inline copy always won. It now lives
  only in `main.js`.
- **Replaced the inline `onclick`/`onkeyup`/`onsubmit` handlers.** `log.html`
  and the nav buttons now bind their handlers with `addEventListener`, so
  `log.js` no longer has to export every function onto `window`. The handler
  behaviour is unchanged.

### Not changed (decisions for Chris)

- Longview ZIP `98632` in the index page's JSON-LD.
- `openingHoursSpecification` Mon–Fri 9–5 in the index page's JSON-LD.
- The missing `og-image.png` (1200x630) referenced by a TODO comment.
- The notary log remains a client-side tracker, not a legally sufficient
  journal — see the note below.

### Note for Chris and Jen

The notary log stores entries in `localStorage` only, and records neither the
time of the act nor the address of the signer. WA notary journals must record
the date *and time* of each act and the full name *and address* of each
individual, and be retained for 10 years (RCW 42.45.180). As it stands this
app is a convenience tracker, not a compliant journal. Adding address and time
fields, a backup/export path, and a PIN are product decisions, so nothing was
changed here.


## 2026-10-01

### SEO metadata + structured data (issue #5)
- Added per-page `<title>`, `<meta description>`, and `<link rel="canonical">` (was already present on most pages; made explicit on all).
- Added **Open Graph** tags (`og:title`, `og:description`, `og:type`, `og:url`, `og:site_name`, `og:locale`) plus `profile:first_name` / `profile:last_name` on the resume page. `og:image` left as a `<!-- TODO -->` — to publish, drop a 1200×630 PNG at `/public/og-image.png` on the server and uncomment the example line in each head.
- Added **Twitter Card** tags (`twitter:card=summary`, `twitter:title`, `twitter:description`).
- Added **JSON-LD structured data** in `<script type="application/ld+json">` blocks:
  - `index.html` → `LocalBusiness` with name, URL, email, address (Longview, WA 98632), areaServed (Longview / Kelso / Castle Rock / Cowlitz County), `knowsAbout`, `openingHoursSpecification` (Mon–Fri 09:00–17:00), `priceRange: "$$"`.
  - `services.html` → `WebPage` with `isPartOf.WebSite` and `about.LocalBusiness` pointing at the home page.
  - `resume.html` → `Person` with `jobTitle: Notary Public`, `worksFor.LocalBusiness` pointing at the home page, address, `knowsAbout` (notary + executive admin).
  - `log.html` → `WebPage` (also marked `<meta name="robots" content="noindex">` since the log is private).
- Phone number is **not** published in any JSON-LD — matches the home-page policy ("Phone: Available upon request").
- Added `robots.txt`: allows everything except `/log.html` (Disallow), points at `sitemap.xml`.
- Added `sitemap.xml`: lists `/`, `/services.html`, `/resume.html` (log.html intentionally excluded).
- **TODO for Chris before going live:**
  1. Confirm ZIP `98632` for Longview (and add a `streetAddress` if you want Google Maps preview).
  2. Adjust `openingHoursSpecification` if Mon–Fri 9–5 doesn't match your real schedule.
  3. Add an `og-image.png` (1200×630) when convenient and uncomment the corresponding meta tags in all 4 pages.
- Closes #5.

## 2026-10-01

### Site polish
- **Canonical name** across all pages: now `Jenifer Talent` everywhere (was a mix of `Jen`, `Jeni`, `Jenifer`). Logos, titles, meta descriptions, footers, and intro paragraph updated on all 4 pages.
- **Canonical contact email** across all pages: now `jeniffer@jeniffer.org` (the address used in footers/contact cards). Resume header no longer shows the alt `jentalent@gmail.com` address.
- **`resume.html` — phone number removed** from resume header to match the home page policy ("Phone: Available upon request"). Refs #7.
- **`resume.html` — fixed stray `</div>` after Administrative Experience** that was causing Notary Public / Volunteer sections to render at a different left margin. Refs #8.
- **`services.html` — "Birthday affidavits" → "Birth certificate affidavits"** in Personal Documents. Refs #4.
- **`services.html` — "swear or affirms" → "swears or affirms"** in Jurat / Subscribe & Swear description.
- **`main.js` — header comment** updated to canonical name.

Closes #2, #3, #4, #7, #8.

## 2026-10-01

### log.html / log.js (new)
- Extracted the broken inline `<script>` from `log.html` into a new `log.js`, loaded with `<script defer src="log.js">`. Fixes the page where Add/Edit/Save/Delete/Export all threw `ReferenceError`.
- Closed XSS hole: row rendering now uses `createElement` + `textContent` for every user-supplied field instead of interpolating into `tbody.innerHTML`.
- Removed the page-specific inline `<style>` block (selectors were scoped enough to live independently; can be folded into `style.css` later if desired).
- Date format kept as "Sep 30, 2026" to match the prior UI.
- Behavior preserved: add, edit, delete, search filter, CSV export, total / this-month counters, modal open/close + backdrop click + Escape key.
- See PR #6 / Issue #1.

## 2026-05-02

### style.css
- Changed color scheme from blue/amber to **green/amber** (green primary #2e7d32, dark green #1b5e20, amber accent #f9a825)

### services.html
- Added **Identification Requirements** section below "Notarization Types"
  - Included four ID types: Passport, Driver's License, Credible Witness, Personally Known
  - Follows same styling as existing Notarization Types cards

## 2026-05-02