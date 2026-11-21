# Changelog

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