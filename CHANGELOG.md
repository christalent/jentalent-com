# Changelog

## 2026-11-11 — Washington notary journal compliance (RCW 42.45.180 / WAC 308-30-200)

The notary log now records everything Washington law requires of a journal
entry, and the electronic journal adds the authentication, tamper-evidence,
backup and copy capabilities required of an electronic journal.

### Required entry fields (RCW 42.45.180(4), WAC 308-30-200(1))

- **Time of the notarial act** — stored alongside the date, displayed as one
  combined "Date & Time" column. The add-entry form defaults to the current
  local date and time.
- **Principal address** — the full address of the individual for whom the act
  was performed (RCW 42.45.180(4)(c)).
- **Method of identifying the principal** — a select offering personal
  knowledge, government-issued photo ID, remote online notarization,
  satisfactory evidence/document owner, and other (WAC 308-30-200(1)(ii)).
- **Principal signature** — a pointer-events canvas signature pad with a
  typed-name fallback for accessibility and for devices without a stylus. The
  signature is stored as a PNG data URL or as the typed name, and round-trips
  through storage and every export (WAC 308-30-200(1)(iii)).
- **Number of statements/documents notarized** — an integer of 1 or more, as
  required when a single entry covers several statements or documents for the
  same individual on the same date (WAC 308-30-190(2)).

The existing fields (date, client name, document type, notarization type,
notes) are unchanged.

### Electronic journal capabilities (WAC 308-30-200(2))

- **(a) In addition to the tangible journal** — a plain-language notice at the
  top of the log page states that this electronic journal is maintained *in
  addition to* the tangible journal, that the tangible journal remains the
  primary record, and that this app does not replace it.
- **(c) Authentication** — a password gate. On first use the notary sets a
  password; thereafter the journal is locked until it is entered. The
  password is stored only as a PBKDF2-HMAC-SHA-256 hash with a per-journal
  random salt. A "forgot password" flow resets the lock *without* deleting
  any entry.
- **(d) Tamper-evident** — every entry is chained to the previous one with a
  SHA-256 hash. A "Check integrity" button recomputes the chain and reports
  any entry that was changed outside the app.
- **(e) Backup** — a one-click "Download backup" writes the full journal
  (including the hash chain and signature data) to a JSON file. A restore flow
  validates a backup file before it is allowed to overwrite anything, and a
  reminder banner prompts for a backup when the journal has not been backed
  up recently. Backups are never downloaded automatically.
- **(f) Copies** — a "Copy" action on any entry produces a standalone,
  printable view (or a copy of the text) that can be handed to a client or
  copied into the tangible journal.

### Legacy entries

Entries created before this update keep their original values and are shown
with a "Legacy — missing required fields" badge listing exactly which
required fields are absent. Nothing is invented for them: no time, address,
identification method, signature, or statement count is fabricated. They can
be edited to complete them.

### Exports

- The CSV export now includes every new field, keeps the formula-injection
  guard, keeps the newest-first order, and includes a combined date-and-time
  column plus the entry hash.
- A JSON export was added; it doubles as the backup file.

### Open Graph / Twitter card

- `og-image.png` (1200×630) is now published and referenced from all four
  pages, with `og:image:width`, `og:image:height` and `og:image:alt`.
- `twitter:card` is now `summary_large_image` on all four pages, with
  `twitter:image` and `twitter:image:alt`.
- The image was added to the JSON-LD structured data on every page.

### Other

- The log page now states the 10-year retention requirement
  (RCW 42.45.180(1)) and that the journal is the notary's exclusive property
  (WAC 308-30-200(3)). It describes what the tool does and is not legal
  advice.
- The node logic harness was extended to cover date+time parsing, the hash
  chain (including tamper detection), CSV output with the new fields, the
  backup/restore format, password hashing, and the legacy-entry migration
  path.

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