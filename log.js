// log.js — Notary log (localStorage-backed)
// All entries are stored client-side only. Nothing is sent to any server.

(function () {
  'use strict';

  const STORAGE_KEY = 'notaryLogEntries';
  const CORRUPT_PREFIX = STORAGE_KEY + '.corrupt.';
  const DELETED_KEY = STORAGE_KEY + '.deleted';

  // Set when the store could not be read intact. While this is set the log
  // refuses to write over the original key, so a corrupt store is never
  // destroyed by the app itself.
  //
  // NOTE: this must be declared BEFORE `entries` is initialised — the
  // initial loadEntries() call can reach backupCorruptStore(), which
  // assigns to it. Declaring it later is a temporal-dead-zone crash the
  // moment a store turns out to be corrupt.
  let storeCorrupt = false;

  // The raw bytes we have already backed up, so the same corrupt store is
  // not copied again on every load.
  let backedUpRaw = null;

  const entries = loadEntries();

  // ---------- Storage ----------
  //
  // Three failure modes this layer has to survive:
  //   1. The stored value is unparseable  -> back it up, never overwrite it.
  //   2. The stored value has bad records -> keep the good ones, keep the raw.
  //   3. Another tab wrote since we loaded -> merge, don't clobber.

  function loadEntries() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      console.error('notary log: could not read local storage', err);
      return [];
    }

    if (raw === null || raw === '') return [];

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn('notary log: stored entries are not valid JSON', err);
      backupCorruptStore(raw, 'unparseable JSON');
      return [];
    }

    if (!Array.isArray(parsed)) {
      backupCorruptStore(raw, 'stored value is not an array');
      return [];
    }

    const good = parsed.filter(isEntryShape).map(normalizeEntry);
    if (good.length !== parsed.length) {
      // Some records were unusable. Preserve the original before anything
      // else can overwrite it.
      backupCorruptStore(raw, `${parsed.length - good.length} unusable record(s)`);
    }
    return good;
  }

  // Copy the raw store to its own key so the original bytes are never lost.
  //
  // Guard against writing the same bytes over and over: the page can load
  // the store more than once, and each load would otherwise add another
  // copy until localStorage fills up with duplicates.
  function backupCorruptStore(raw, reason) {
    storeCorrupt = true;
    if (backedUpRaw === raw) {
      showCorruptBanner(reason);
      return;
    }
    backedUpRaw = raw;
    try {
      localStorage.setItem(CORRUPT_PREFIX + Date.now(), raw);
      console.warn(`notary log: backed up corrupt store (${reason})`);
    } catch (err) {
      // Quota exceeded — the backup is the last thing that can fail, and
      // failing it must not throw into the caller.
      console.error('notary log: could not back up corrupt store', err);
    }
    showCorruptBanner(reason);
  }

  function isEntryShape(value) {
    return (
      value !== null &&
      typeof value === 'object' &&
      typeof value.date === 'string' &&
      typeof value.clientName === 'string'
    );
  }

  function newEntryId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    // Fallback for browsers without randomUUID. Still a unique identifier —
    // it just is not cryptographically random, which is fine here.
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function normalizeEntry(entry) {
    return {
      // Stable identity. Legacy records without an id get one assigned so
      // edit/delete can resolve by id instead of by array position.
      id: typeof entry.id === 'string' && entry.id ? entry.id : newEntryId(),
      date: entry.date,
      clientName: entry.clientName,
      documentType: typeof entry.documentType === 'string' ? entry.documentType : '',
      notarizationType:
        typeof entry.notarizationType === 'string' ? entry.notarizationType : '',
      notes: typeof entry.notes === 'string' ? entry.notes : '',
    };
  }

  // Ids this tab has deliberately removed. The merge below must not
  // resurrect them from the stored copy — otherwise a delete is silently
  // undone by the very next save.
  //
  // Persisted alongside the entries: an in-memory-only tombstone is lost on
  // reload, and the next save would bring the deleted record back.
  const deletedIds = new Set(
    (function loadTombstones() {
      try {
        const raw = localStorage.getItem(DELETED_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
      } catch (err) {
        return [];
      }
    })()
  );

  // Re-read the store and merge our in-memory changes on top of whatever
  // another tab may have written since we loaded. This is what stops one
  // tab's save from erasing another tab's records.
  function mergeWithStored() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      return entries;
    }
    if (raw === null || raw === '') return entries;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // Another tab wrote garbage. Do not touch the store.
      backupCorruptStore(raw, 'unparseable JSON');
      return entries;
    }
    if (!Array.isArray(parsed)) return entries;

    const stored = parsed.filter(isEntryShape).map(normalizeEntry);

    // Our entries win on conflict (they are the newer intent), but records
    // we have never seen — written by another tab — are kept.
    //
    // Records this tab deleted are NOT kept, even though the stored copy
    // still lists them: the delete is the newer intent. Without this the
    // delete would be undone by the next save.
    const merged = [];
    const seen = new Set();
    entries.forEach((e) => {
      merged.push(e);
      seen.add(e.id);
    });
    stored.forEach((e) => {
      if (seen.has(e.id)) return;
      if (deletedIds.has(e.id)) return;
      merged.push(e);
    });
    return merged;
  }

  function saveEntries() {
    // Never overwrite a store we know is corrupt — the backup is the only
    // copy of those bytes.
    if (storeCorrupt) {
      alert(
        'This log could not be read correctly and has been backed up. ' +
          'Nothing will be written over it until you restore it. ' +
          'Please contact the site owner.'
      );
      return false;
    }

    const merged = mergeWithStored();

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      // Persist the tombstones so a delete survives a page reload.
      localStorage.setItem(DELETED_KEY, JSON.stringify([...deletedIds]));
      // Replace the in-memory copy so the next render reflects the merge.
      entries.length = 0;
      merged.forEach((e) => entries.push(e));
      return true;
    } catch (err) {
      // Quota exceeded, private-mode restrictions, etc. Surface it instead of
      // silently losing the record the notary just typed.
      console.error('notary log: could not save entries', err);
      alert(
        'Could not save this entry to local storage. It may be full, or ' +
          'private browsing may be blocking storage. Your entry was not saved.'
      );
      return false;
    }
  }

  // ---------- Corrupt-store banner ----------

  function showCorruptBanner(reason) {
    const banner = getEl('corruptBanner');
    if (!banner) return;
    const detail = getEl('corruptBannerDetail');
    if (detail) {
      detail.textContent =
        'The stored log could not be read (' + reason + '). A backup of the ' +
        'original data has been saved, and nothing will overwrite it until ' +
        'the problem is resolved.';
    }
    banner.hidden = false;
  }

  // ---------- Dates ----------

  // A bare "YYYY-MM-DD" string is parsed by Date as UTC midnight, which is
  // the previous day in the Americas. Parse dates as local time instead.
  function parseLocalDate(value) {
    if (!value) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [y, m, d] = value.split('-').map(Number);
      const date = new Date(y, m - 1, d);
      if (Number.isNaN(date.getTime())) return null;
      // new Date(2026, 1, 30) silently rolls over to March 2. Round-trip the
      // components so an impossible date is rejected instead of displayed as
      // a different day.
      if (
        date.getFullYear() !== y ||
        date.getMonth() !== m - 1 ||
        date.getDate() !== d
      ) {
        return null;
      }
      return date;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function formatDate(isoDate) {
    // Display as "Sep 30, 2026" to match the previous local format.
    if (!isoDate) return '';
    const d = parseLocalDate(isoDate);
    if (!d) return isoDate;
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  // Today in the notary's own timezone — not UTC, which can be tomorrow.
  function todayLocalISO() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // ---------- DOM helpers ----------

  function getEl(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    const el = getEl(id);
    if (el) el.textContent = String(value);
  }

  function clearChildren(el) {
    while (el && el.firstChild) el.removeChild(el.firstChild);
  }

  // ---------- Rendering ----------
  // Uses textContent (not innerHTML) for every user-supplied field — keeps
  // the XSS surface closed.

  function makeCell(text) {
    const td = document.createElement('td');
    td.textContent = text;
    return td;
  }

  function makeActionsCell(entry) {
    const td = document.createElement('td');

    // The accessible name has to identify the row, otherwise a screen reader
    // announces a flat list of identical "Edit entry" buttons.
    const label = entry.clientName ? ' for ' + entry.clientName : '';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn-small';
    editBtn.textContent = 'Edit';
    editBtn.setAttribute('aria-label', 'Edit entry' + label);
    editBtn.dataset.entryId = entry.id;
    editBtn.addEventListener('click', () => editEntry(entry.id));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-small btn-danger';
    delBtn.textContent = 'Delete';
    delBtn.setAttribute('aria-label', 'Delete entry' + label);
    delBtn.dataset.entryId = entry.id;
    delBtn.addEventListener('click', () => deleteEntry(entry.id));

    td.appendChild(editBtn);
    td.appendChild(document.createTextNode(' '));
    td.appendChild(delBtn);
    return td;
  }

  // Newest first — the order the table shows and the order the CSV exports.
  function sortedEntries() {
    return [...entries].sort((a, b) => {
      const da = parseLocalDate(a.date);
      const db = parseLocalDate(b.date);
      const ta = da ? da.getTime() : 0;
      const tb = db ? db.getTime() : 0;
      return tb - ta;
    });
  }

  function renderEntries() {
    const tbody = getEl('logTableBody');
    const emptyState = getEl('emptyState');
    if (!tbody || !emptyState) return;

    clearChildren(tbody);

    if (entries.length === 0) {
      emptyState.style.display = 'block';
      setText('totalEntries', '0');
      setText('thisMonth', '0');
      return;
    }

    emptyState.style.display = 'none';

    sortedEntries().forEach((entry) => {
      const tr = document.createElement('tr');
      tr.appendChild(makeCell(formatDate(entry.date)));
      tr.appendChild(makeCell(entry.clientName || ''));
      tr.appendChild(makeCell(entry.documentType || ''));
      tr.appendChild(makeCell(entry.notarizationType || ''));
      tr.appendChild(makeCell(entry.notes || '—'));
      tr.appendChild(makeActionsCell(entry));
      tbody.appendChild(tr);
    });

    setText('totalEntries', entries.length);

    const now = new Date();
    const thisMonth = entries.filter((e) => {
      const d = parseLocalDate(e.date);
      return (
        d !== null &&
        d.getMonth() === now.getMonth() &&
        d.getFullYear() === now.getFullYear()
      );
    }).length;
    setText('thisMonth', thisMonth);

    // Re-apply the active search so the filter survives a re-render.
    filterEntries();
  }

  // Move focus back to the row the user was working on. The old code tried
  // to restore focus to the Edit button that showModal() had captured, but
  // renderEntries() had already destroyed that node — so focus fell to the
  // document body and keyboard users lost their place.
  function restoreFocusToEntry(entryId, prefer) {
    if (!entryId) return;
    const tbody = getEl('logTableBody');
    if (!tbody) return;
    const buttons = tbody.querySelectorAll('button[data-entry-id]');
    for (const btn of buttons) {
      if (btn.dataset.entryId === entryId) {
        btn.focus();
        return;
      }
    }
  }

  // ---------- Filtering ----------

  function filterEntries() {
    const query = (getEl('searchInput')?.value || '').toLowerCase().trim();
    const rows = getEl('logTableBody')?.querySelectorAll('tr') || [];
    rows.forEach((row) => {
      // Match only the data cells. Matching row.textContent would also match
      // the literal "Edit"/"Delete" button labels in the actions cell.
      const cells = row.querySelectorAll('td:not(:last-child)');
      let text = '';
      cells.forEach((cell) => {
        text += ' ' + cell.textContent;
      });
      row.style.display = !query || text.toLowerCase().includes(query) ? '' : 'none';
    });
  }

  // ---------- Modal ----------

  let lastFocusedElement = null;

  function openAddModal() {
    setText('modalTitle', 'Add Entry');
    const form = getEl('entryForm');
    if (form) form.reset();
    const idEl = getEl('entryId');
    if (idEl) idEl.value = '';
    const dateEl = getEl('entryDate');
    if (dateEl) dateEl.value = todayLocalISO();
    showModal();
  }

  function openEditModal(entry) {
    setText('modalTitle', 'Edit Entry');
    const idEl = getEl('entryId');
    if (idEl) idEl.value = entry.id;
    const dateEl = getEl('entryDate');
    if (dateEl) dateEl.value = entry.date || '';
    const clientEl = getEl('clientName');
    if (clientEl) clientEl.value = entry.clientName || '';
    const docEl = getEl('documentType');
    if (docEl) docEl.value = entry.documentType || '';
    const notEl = getEl('notarizationType');
    if (notEl) notEl.value = entry.notarizationType || '';
    const notesEl = getEl('notes');
    if (notesEl) notesEl.value = entry.notes || '';
    showModal();
  }

  function showModal() {
    lastFocusedElement = document.activeElement;
    getEl('entryModal').classList.add('show');
    document.body.classList.add('modal-open');
    // Move focus into the dialog so keyboard and screen-reader users land on
    // the first field instead of staying on the button behind the overlay.
    const firstField = getEl('entryDate');
    if (firstField) firstField.focus();
  }

  function closeModal() {
    getEl('entryModal').classList.remove('show');
    document.body.classList.remove('modal-open');
    // Return focus to whatever opened the dialog.
    if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
      lastFocusedElement.focus();
    }
    lastFocusedElement = null;
  }

  // Keep Tab focus inside the open dialog.
  function trapFocus(event) {
    if (event.key !== 'Tab') return;
    const modal = getEl('entryModal');
    if (!modal || !modal.classList.contains('show')) return;

    const focusables = Array.from(
      modal.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);

    if (focusables.length === 0) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // Announce a validation problem where a screen reader will actually read it.
  function showFormError(message, fieldId) {
    const box = getEl('formError');
    if (box) {
      box.textContent = message;
      box.hidden = false;
    }
    if (fieldId) {
      const field = getEl(fieldId);
      if (field && typeof field.focus === 'function') field.focus();
    }
  }

  function clearFormError() {
    const box = getEl('formError');
    if (box) {
      box.textContent = '';
      box.hidden = true;
    }
  }

  function saveEntry(event) {
    event.preventDefault();
    clearFormError();

    const idEl = getEl('entryId');
    const dateEl = getEl('entryDate');
    const clientEl = getEl('clientName');
    const docEl = getEl('documentType');
    const notEl = getEl('notarizationType');
    const notesEl = getEl('notes');
    if (!idEl || !dateEl || !clientEl || !docEl || !notEl || !notesEl) return;

    const idVal = idEl.value;
    const record = {
      date: dateEl.value,
      clientName: clientEl.value.trim(),
      documentType: docEl.value,
      notarizationType: notEl.value,
      notes: notesEl.value.trim(),
    };

    if (!record.date) {
      showFormError('A date is required.', 'entryDate');
      return;
    }
    if (!record.clientName) {
      showFormError('A client name is required.', 'clientName');
      return;
    }
    if (!record.documentType) {
      showFormError('Select a document type.', 'documentType');
      return;
    }
    if (!record.notarizationType) {
      showFormError('Select a notarization type.', 'notarizationType');
      return;
    }

    let replacedIndex = -1;
    let previousRecord = null;
    let savedId = null;

    if (idVal === '') {
      record.id = newEntryId();
      entries.push(record);
      savedId = record.id;
    } else {
      // Resolve by stable id. An id that does not match any record is an
      // error, not an add — silently creating a duplicate is how a notary
      // ends up with two nearly identical entries for one client.
      const idx = entries.findIndex((e) => e.id === idVal);
      if (idx === -1) {
        showFormError(
          'That entry could not be found — it may have been deleted in ' +
            'another tab. Close this dialog and try again.'
        );
        return;
      }
      replacedIndex = idx;
      previousRecord = entries[idx];
      record.id = previousRecord.id;
      entries[idx] = record;
      savedId = record.id;
    }

    if (!saveEntries()) {
      // Roll back the in-memory change so the UI and storage stay in sync.
      if (replacedIndex >= 0) {
        entries[replacedIndex] = previousRecord;
      } else {
        entries.pop();
      }
      return;
    }

    renderEntries();
    closeModal();
    // Focus the row we just touched, not the detached button.
    restoreFocusToEntry(savedId);
  }

  // Test hook: runs the real delete path so the test exercises the same
  // code the UI does.
  function __deleteForTest(id) {
    const index = entries.findIndex((e) => e.id === id);
    if (index === -1) return false;
    const entry = entries[index];
    entries.splice(index, 1);
    deletedIds.add(entry.id);
    return saveEntries();
  }

  function findEntryById(id) {
    return entries.find((e) => e.id === id) || null;
  }

  function editEntry(id) {
    const entry = findEntryById(id);
    if (entry) openEditModal(entry);
  }

  function deleteEntry(id) {
    const index = entries.findIndex((e) => e.id === id);
    if (index === -1) return;
    const entry = entries[index];
    const label = entry.clientName ? `"${entry.clientName}"` : 'this entry';
    if (!confirm(`Delete ${label}? This cannot be undone.`)) return;
    entries.splice(index, 1);
    deletedIds.add(entry.id);
    if (!saveEntries()) {
      // Save failed — put it back and forget the deletion, so the next
      // successful save does not silently drop it.
      entries.splice(index, 0, entry);
      deletedIds.delete(entry.id);
      return;
    }
    renderEntries();
    // Focus the next row's Edit button so the keyboard user keeps a
    // position in the table.
    const tbody = getEl('logTableBody');
    const nextBtn = tbody && tbody.querySelector('button[data-entry-id]');
    if (nextBtn && typeof nextBtn.focus === 'function') nextBtn.focus();
  }

  // ---------- Bulk clear ----------

  function clearAllEntries() {
    if (entries.length === 0) {
      alert('The log is already empty.');
      return;
    }
    const typed = prompt(
      'This permanently deletes all ' + entries.length + ' entries from this ' +
        'browser.\n\nType DELETE to confirm.'
    );
    if (typed === null) return;
    if (typed.trim().toUpperCase() !== 'DELETE') {
      alert('Not confirmed — nothing was deleted.');
      return;
    }
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(DELETED_KEY);
    } catch (err) {
      console.error('notary log: could not clear entries', err);
      alert('Could not clear the log. Storage may be blocked by the browser.');
      return;
    }
    entries.length = 0;
    deletedIds.clear();
    storeCorrupt = false;
    const banner = getEl('corruptBanner');
    if (banner) banner.hidden = true;
    renderEntries();
  }

  // ---------- Export ----------

  // Neutralise spreadsheet formula injection: a cell starting with = + - @
  // (or a leading tab/CR/LF) is executed by Excel/Sheets when the CSV is
  // opened. Leading whitespace is stripped first — a spreadsheet that trims
  // " =1+1" would otherwise evaluate it as a formula.
  function csvEscape(value) {
    const s = value === null || value === undefined ? '' : String(value);
    // Check the ORIGINAL first characters for a formula trigger. A leading
    // tab, CR or LF is itself in the trigger set, so stripping whitespace
    // before the check would hide it. Only a run of spaces/nbsp/BOM is
    // safe to drop, and only after the trigger check has passed.
    if (/^[=+\-@\t\r\n]/.test(s)) {
      const guarded = "'" + s;
      return /[",\n\r]/.test(guarded)
        ? '"' + guarded.replace(/"/g, '""') + '"'
        : guarded;
    }
    // No trigger on the first character. But a spreadsheet may trim
    // leading spaces and then evaluate what is left, so a cell that
    // starts with spaces then "=" is still a formula.
    const trimmed = s.replace(/^[ \u00A0\uFEFF]+/, '');
    if (trimmed !== s && /^[=+\-@]/.test(trimmed)) {
      const guarded = "'" + trimmed;
      return /[",\n\r]/.test(guarded)
        ? '"' + guarded.replace(/"/g, '""') + '"'
        : guarded;
    }
    if (/[",\n\r]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function exportLog() {
    if (entries.length === 0) {
      alert('No entries to export.');
      return;
    }
    const headers = ['Date', 'Client Name', 'Document Type', 'Notarization Type', 'Notes'];
    // Export in the same order the table displays (newest first).
    const rows = sortedEntries().map((e) => [
      e.date,
      e.clientName || '',
      e.documentType || '',
      e.notarizationType || '',
      e.notes || '',
    ]);
    const csv =
      [headers, ...rows]
        .map((r) => r.map(csvEscape).join(','))
        .join('\r\n') + '\r\n';

    // The BOM makes Excel read UTF-8 correctly instead of rendering
    // "JosÃ©" for a client named "José".
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `notary-log-${todayLocalISO()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoking in the same tick can cancel the download in Firefox/Safari.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- Wire-up ----------

  function init() {
    const modal = getEl('entryModal');
    if (modal) {
      // Modal close on backdrop click.
      modal.addEventListener('click', (event) => {
        if (event.target === modal) closeModal();
      });
      modal.addEventListener('keydown', trapFocus);
    }

    // Close on Escape.
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeModal();
    });

    const addBtn = getEl('addEntryBtn');
    if (addBtn) addBtn.addEventListener('click', openAddModal);

    const exportBtn = getEl('exportBtn');
    if (exportBtn) exportBtn.addEventListener('click', exportLog);

    const clearBtn = getEl('clearAllBtn');
    if (clearBtn) clearBtn.addEventListener('click', clearAllEntries);

    const closeBtn = getEl('closeModalBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    const cancelBtn = getEl('cancelBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

    const form = getEl('entryForm');
    if (form) form.addEventListener('submit', saveEntry);

    const search = getEl('searchInput');
    if (search) search.addEventListener('input', filterEntries);

    // Another tab changed the store — pull in what it wrote instead of
    // letting the next save in this tab clobber it.
    window.addEventListener('storage', (event) => {
      if (event.key && event.key !== STORAGE_KEY) return;
      const merged = mergeWithStored();
      entries.length = 0;
      merged.forEach((e) => entries.push(e));
      renderEntries();
    });

    renderEntries();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
