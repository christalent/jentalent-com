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
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.warn('notary log: failed to parse stored entries, resetting', err);
      return [];
    }
  }

  function saveEntries() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  }

  // ---------- Escaping & formatting ----------

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDate(isoDate) {
    // Display as "Sep 30, 2026" to match the previous local format.
    // Accept either "YYYY-MM-DD" (HTML date input) or a full ISO string.
    if (!isoDate) return '';
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(isoDate) ? isoDate + 'T00:00:00' : isoDate);
    if (Number.isNaN(d.getTime())) return isoDate;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
  // the XSS surface closed even if the escape helper is ever bypassed.

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
    editBtn.addEventListener('click', () => editEntry(index));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-small btn-danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => deleteEntry(index));

    td.appendChild(editBtn);
    td.appendChild(document.createTextNode(' '));
    td.appendChild(delBtn);
    return td;
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

    const sorted = [...entries].sort(
      (a, b) => new Date(b.date) - new Date(a.date)
    );
    sorted.forEach((entry) => {
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
      const d = new Date(e.date);
      return (
        !Number.isNaN(d.getTime()) &&
        d.getMonth() === now.getMonth() &&
        d.getFullYear() === now.getFullYear()
      );
    }).length;
    setText('thisMonth', thisMonth);
  }

  // ---------- Filtering ----------

  function filterEntries() {
    const query = (getEl('searchInput')?.value || '').toLowerCase().trim();
    const rows = getEl('logTableBody')?.querySelectorAll('tr') || [];
    rows.forEach((row) => {
      const text = row.textContent.toLowerCase();
      row.style.display = !query || text.includes(query) ? '' : 'none';
    });
  }

  // ---------- Modal ----------

  function openAddModal() {
    setText('modalTitle', 'Add Entry');
    const form = getEl('entryForm');
    if (form) form.reset();
    getEl('entryId').value = '';
    getEl('entryDate').value = new Date().toISOString().split('T')[0];
    getEl('entryModal').classList.add('show');
  }

  function openEditModal(entry, index) {
    setText('modalTitle', 'Edit Entry');
    getEl('entryId').value = String(index);
    getEl('entryDate').value = entry.date || '';
    getEl('clientName').value = entry.clientName || '';
    getEl('documentType').value = entry.documentType || '';
    getEl('notarizationType').value = entry.notarizationType || '';
    getEl('notes').value = entry.notes || '';
    getEl('entryModal').classList.add('show');
  }

  function closeModal() {
    getEl('entryModal').classList.remove('show');
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

    if (idVal === '') {
      entries.push(record);
    } else {
      const idx = Number(idVal);
      if (Number.isInteger(idx) && idx >= 0 && idx < entries.length) {
        entries[idx] = record;
      } else {
        entries.push(record);
      }
    }

    saveEntries();
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
    saveEntries();
    renderEntries();
  }

  // ---------- Export ----------

  function csvEscape(value) {
    const s = value === null || value === undefined ? '' : String(value);
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
    const rows = entries.map((e) => [
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
    a.download = `notary-log-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---------- Wire-up ----------

  function init() {
    // Modal close on backdrop click.
    const modal = getEl('entryModal');
    if (modal) {
      modal.addEventListener('click', (event) => {
        if (event.target === modal) closeModal();
      });
    }

    // Close on Escape.
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeModal();
    });

    // Expose handlers for inline onclick attributes used in the HTML.
    window.openAddModal = openAddModal;
    window.closeModal = closeModal;
    window.saveEntry = saveEntry;
    window.editEntry = editEntry;
    window.deleteEntry = deleteEntry;
    window.filterEntries = filterEntries;
    window.exportLog = exportLog;

    renderEntries();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
