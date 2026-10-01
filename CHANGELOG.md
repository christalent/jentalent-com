# Changelog

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