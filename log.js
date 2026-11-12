// log.js — Notary log (localStorage-backed)
// All entries are stored client-side only. Nothing is sent to any server.

(function () {
  'use strict';

  const STORAGE_KEY = 'notaryLogEntries';
  const entries = loadEntries();

  // ---------- Storage ----------

  function loadEntries() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      // Drop anything that is not a usable record so a corrupt or hand-edited
      // store cannot break rendering for every row.
      return parsed.filter(isEntryShape).map(normalizeEntry);
    } catch (err) {
      console.warn('notary log: failed to parse stored entries, resetting', err);
      return [];
    }
  }

  function isEntryShape(value) {
    return (
      value !== null &&
      typeof value === 'object' &&
      typeof value.date === 'string' &&
      typeof value.clientName === 'string'
    );
  }

  function normalizeEntry(entry) {
    return {
      date: entry.date,
      clientName: entry.clientName,
      documentType: typeof entry.documentType === 'string' ? entry.documentType : '',
      notarizationType:
        typeof entry.notarizationType === 'string' ? entry.notarizationType : '',
      notes: typeof entry.notes === 'string' ? entry.notes : '',
    };
  }

  function saveEntries() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
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

  // ---------- Dates ----------

  // A bare "YYYY-MM-DD" string is parsed by Date as UTC midnight, which is the
  // previous day in the Americas. Parse dates as local time instead.
  function parseLocalDate(value) {
    if (!value) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [y, m, d] = value.split('-').map(Number);
      const date = new Date(y, m - 1, d);
      return Number.isNaN(date.getTime()) ? null : date;
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

  function makeActionsCell(index) {
    const td = document.createElement('td');

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn-small';
    editBtn.textContent = 'Edit';
    editBtn.setAttribute('aria-label', 'Edit entry');
    editBtn.addEventListener('click', () => editEntry(index));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-small btn-danger';
    delBtn.textContent = 'Delete';
    delBtn.setAttribute('aria-label', 'Delete entry');
    delBtn.addEventListener('click', () => deleteEntry(index));

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
      const realIndex = entries.indexOf(entry);
      const tr = document.createElement('tr');
      tr.appendChild(makeCell(formatDate(entry.date)));
      tr.appendChild(makeCell(entry.clientName || ''));
      tr.appendChild(makeCell(entry.documentType || ''));
      tr.appendChild(makeCell(entry.notarizationType || ''));
      tr.appendChild(makeCell(entry.notes || '—'));
      tr.appendChild(makeActionsCell(realIndex));
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
    getEl('entryId').value = '';
    getEl('entryDate').value = todayLocalISO();
    showModal();
  }

  function openEditModal(entry, index) {
    setText('modalTitle', 'Edit Entry');
    getEl('entryId').value = String(index);
    getEl('entryDate').value = entry.date || '';
    getEl('clientName').value = entry.clientName || '';
    getEl('documentType').value = entry.documentType || '';
    getEl('notarizationType').value = entry.notarizationType || '';
    getEl('notes').value = entry.notes || '';
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

  function saveEntry(event) {
    event.preventDefault();
    const idVal = getEl('entryId').value;
    const record = {
      date: getEl('entryDate').value,
      clientName: getEl('clientName').value.trim(),
      documentType: getEl('documentType').value,
      notarizationType: getEl('notarizationType').value,
      notes: getEl('notes').value.trim(),
    };

    if (!record.date || !record.clientName || !record.documentType || !record.notarizationType) {
      return; // HTML required attributes should have caught this already.
    }

    let replacedIndex = -1;
    let previousRecord = null;

    if (idVal === '') {
      entries.push(record);
    } else {
      const idx = Number(idVal);
      if (Number.isInteger(idx) && idx >= 0 && idx < entries.length) {
        replacedIndex = idx;
        previousRecord = entries[idx];
        entries[idx] = record;
      } else {
        entries.push(record);
      }
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
  }

  function editEntry(index) {
    if (index >= 0 && index < entries.length) {
      openEditModal(entries[index], index);
    }
  }

  function deleteEntry(index) {
    if (index < 0 || index >= entries.length) return;
    const entry = entries[index];
    const label = entry.clientName ? `"${entry.clientName}"` : 'this entry';
    if (!confirm(`Delete ${label}? This cannot be undone.`)) return;
    entries.splice(index, 1);
    if (!saveEntries()) {
      entries.splice(index, 0, entry);
      return;
    }
    renderEntries();
  }

  // ---------- Export ----------

  // Neutralise spreadsheet formula injection: a cell starting with = + - @
  // (or a leading tab/CR) is executed by Excel/Sheets when the CSV is opened.
  function csvEscape(value) {
    const s = value === null || value === undefined ? '' : String(value);
    const guarded = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
    if (/[",\n\r]/.test(guarded)) {
      return '"' + guarded.replace(/"/g, '""') + '"';
    }
    return guarded;
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

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `notary-log-${todayLocalISO()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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

    const closeBtn = getEl('closeModalBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    const cancelBtn = getEl('cancelBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

    const form = getEl('entryForm');
    if (form) form.addEventListener('submit', saveEntry);

    const search = getEl('searchInput');
    if (search) search.addEventListener('input', filterEntries);

    renderEntries();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
