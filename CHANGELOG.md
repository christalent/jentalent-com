# Changelog

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