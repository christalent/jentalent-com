// log.js — Notary log (server-backed)
//
// Entries live in a server-side database, not in the browser. The log is
// protected by a PIN that is verified server-side; the PIN itself is never
// present in this file or in any response from the server.
//
// Every user-supplied field is rendered with textContent (never innerHTML),
// so the XSS surface stays closed.

(function () {
  'use strict';

  const API = 'api.php';
  let authenticated = false;
  let entries = [];

  // ---------- API helpers ----------

  async function api(action, options = {}) {
    const opts = {
      method: options.method || 'GET',
      credentials: 'same-origin',
      headers: {},
    };
    if (options.body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(options.body);
    }
    const res = await fetch(`${API}?action=${encodeURIComponent(action)}`, opts);
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      data = { ok: false, error: 'The server returned an unreadable response.' };
    }
    if (!res.ok) {
      const error = new Error(data && data.error ? data.error : 'Request failed.');
      error.status = res.status;
      error.expired = res.status === 401;
      throw error;
    }
    return data;
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

  function show(el, visible) {
    if (el) el.hidden = !visible;
  }

  // ---------- PIN gate ----------

  async function checkSession() {
    try {
      const data = await api('status');
      authenticated = !!data.authenticated;
    } catch (err) {
      authenticated = false;
    }
    return authenticated;
  }

  async function doLogin(pin) {
    const data = await api('login', { method: 'POST', body: { pin } });
    authenticated = true;
    return data;
  }

  async function doLogout() {
    try {
      await api('logout', { method: 'POST', body: {} });
    } catch (err) {
      // Even if the server call fails, drop the local session state.
    }
    authenticated = false;
    entries = [];
    renderEntries();
    showPinGate();
  }

  function showPinGate() {
    show(getEl('pinGate'), true);
    show(getEl('logContent'), false);
    const pinInput = getEl('pinInput');
    if (pinInput) {
      pinInput.value = '';
      pinInput.focus();
    }
  }

  function showLogContent() {
    show(getEl('pinGate'), false);
    show(getEl('logContent'), true);
  }

  function showPinError(message) {
    const box = getEl('pinError');
    if (box) {
      box.textContent = message || '';
      box.hidden = !message;
    }
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

  // ---------- Rendering ----------

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

  // "Other" shows what was actually typed in the description box.
  function documentTypeLabel(entry) {
    if (entry.documentType === 'Other' && entry.documentTypeOther) {
      return 'Other — ' + entry.documentTypeOther;
    }
    return entry.documentType || '';
  }

  // The identification type and its number/details in a single cell.
  function identificationLabel(entry) {
    const type = entry.identificationType || '';
    const number = entry.identificationNumber || '';
    if (type && number) return type + ' — ' + number;
    return type || number || '';
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
      tr.appendChild(makeCell(documentTypeLabel(entry)));
      tr.appendChild(makeCell(entry.notarizationType || ''));
      tr.appendChild(makeCell(entry.notes || '—'));
      tr.appendChild(makeCell(identificationLabel(entry)));
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

  // Move focus back to the row the user was working on.
  function restoreFocusToEntry(entryId) {
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
    if (dateEl) {
      dateEl.value = todayLocalISO();
      dateEl.max = todayLocalISO();
    }
    const notesEl = getEl('notes');
    if (notesEl) notesEl.value = '';
    const otherEl = getEl('documentTypeOther');
    if (otherEl) otherEl.value = '';
    const idTypeEl = getEl('identificationType');
    if (idTypeEl) idTypeEl.value = '';
    const idNumEl = getEl('identificationNumber');
    if (idNumEl) idNumEl.value = '';
    toggleOtherField();
    clearImagePreview();
    showModal();
  }

  function openEditModal(entry) {
    setText('modalTitle', 'Edit Entry');
    const idEl = getEl('entryId');
    if (idEl) idEl.value = entry.id;
    const dateEl = getEl('entryDate');
    if (dateEl) {
      dateEl.value = entry.date || '';
      dateEl.max = todayLocalISO();
    }
    const clientEl = getEl('clientName');
    if (clientEl) clientEl.value = entry.clientName || '';
    const docEl = getEl('documentType');
    if (docEl) docEl.value = entry.documentType || '';
    const otherEl = getEl('documentTypeOther');
    if (otherEl) otherEl.value = entry.documentTypeOther || '';
    const notEl = getEl('notarizationType');
    if (notEl) notEl.value = entry.notarizationType || '';
    const notesEl = getEl('notes');
    if (notesEl) notesEl.value = entry.notes || '';
    const idTypeEl = getEl('identificationType');
    if (idTypeEl) idTypeEl.value = entry.identificationType || '';
    const idNumEl = getEl('identificationNumber');
    if (idNumEl) idNumEl.value = entry.identificationNumber || '';
    toggleOtherField();
    showImagePreview(entry);
    showModal();
  }

  function showModal() {
    lastFocusedElement = document.activeElement;
    getEl('entryModal').classList.add('show');
    // The scroll lock has to be applied to <html> too, or the document
    // keeps scrolling behind the fixed dialog.
    document.body.classList.add('modal-open');
    document.documentElement.classList.add('modal-open');
    // Move focus into the dialog so keyboard and screen-reader users land on
    // the first field instead of staying on the button behind the overlay.
    const firstField = getEl('entryDate');
    if (firstField) firstField.focus();
  }

  function closeModal() {
    getEl('entryModal').classList.remove('show');
    document.body.classList.remove('modal-open');
    document.documentElement.classList.remove('modal-open');
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

  // ---------- "Other" document type ----------

  // Show the description box only when "Other" is selected.
  function toggleOtherField() {
    const select = getEl('documentType');
    const group = getEl('otherTypeGroup');
    const input = getEl('documentTypeOther');
    if (!select || !group) return;
    const isOther = select.value === 'Other';
    group.hidden = !isOther;
    if (input) {
      input.required = isOther;
      if (!isOther) input.value = '';
    }
  }

  // ---------- Image attachment ----------

  let pendingImageFile = null;

  function clearImagePreview() {
    pendingImageFile = null;
    const preview = getEl('imagePreview');
    const img = getEl('imagePreviewImg');
    const label = getEl('imagePreviewLabel');
    const fileInput = getEl('entryImage');
    if (fileInput) fileInput.value = '';
    if (preview) preview.hidden = true;
    if (img) img.removeAttribute('src');
    if (label) label.textContent = '';
  }

  function showImagePreview(entry) {
    pendingImageFile = null;
    const preview = getEl('imagePreview');
    const img = getEl('imagePreviewImg');
    const label = getEl('imagePreviewLabel');
    const fileInput = getEl('entryImage');
    if (fileInput) fileInput.value = '';

    if (!entry || !entry.hasImage) {
      if (preview) preview.hidden = true;
      if (img) img.removeAttribute('src');
      if (label) label.textContent = '';
      return;
    }
    if (preview) preview.hidden = false;
    if (img) img.src = `${API}?action=image&id=${encodeURIComponent(entry.id)}`;
    if (label) label.textContent = 'Image attached';
  }

  function handleImageSelected(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      showFormError('The image must be smaller than 8 MB.', 'entryImage');
      event.target.value = '';
      return;
    }
    pendingImageFile = file;
    const preview = getEl('imagePreview');
    const img = getEl('imagePreviewImg');
    const label = getEl('imagePreviewLabel');
    if (preview) preview.hidden = false;
    if (img) img.src = URL.createObjectURL(file);
    if (label) label.textContent = file.name;
  }

  async function uploadImage(entryId) {
    if (!pendingImageFile) return null;
    const form = new FormData();
    form.append('image', pendingImageFile);
    form.append('id', entryId);
    const res = await fetch(`${API}?action=upload`, {
      method: 'POST',
      credentials: 'same-origin',
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'The image could not be uploaded.');
    }
    pendingImageFile = null;
    return data;
  }

  // ---------- Saving ----------

  function showFormError(message, fieldId) {
    const box = getEl('formError');
    if (box) {
      box.textContent = message;
      box.hidden = !message;
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

  async function saveEntry(event) {
    event.preventDefault();
    clearFormError();

    const idEl = getEl('entryId');
    const dateEl = getEl('entryDate');
    const clientEl = getEl('clientName');
    const docEl = getEl('documentType');
    const otherEl = getEl('documentTypeOther');
    const notEl = getEl('notarizationType');
    const notesEl = getEl('notes');
    const idTypeEl = getEl('identificationType');
    const idNumEl = getEl('identificationNumber');
    if (!idEl || !dateEl || !clientEl || !docEl || !notEl || !notesEl) return;

    const record = {
      id: idEl.value || '',
      date: dateEl.value,
      clientName: clientEl.value.trim(),
      documentType: docEl.value,
      documentTypeOther: otherEl ? otherEl.value.trim() : '',
      notarizationType: notEl.value,
      notes: notesEl.value.trim(),
      identificationType: idTypeEl ? idTypeEl.value : '',
      identificationNumber: idNumEl ? idNumEl.value.trim() : '',
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
    if (record.documentType === 'Other' && !record.documentTypeOther) {
      showFormError('Describe the document type.', 'documentTypeOther');
      return;
    }
    if (!record.notarizationType) {
      showFormError('Select a notarization type.', 'notarizationType');
      return;
    }
    if (record.identificationNumber && !record.identificationType) {
      showFormError('Select an identification type.', 'identificationType');
      return;
    }

    const saveBtn = getEl('saveEntryBtn');
    if (saveBtn) saveBtn.disabled = true;

    try {
      const data = await api('save', { method: 'POST', body: { entry: record } });
      const saved = data.entry;

      // Attach a newly chosen image to the saved entry.
      if (pendingImageFile && saved && saved.id) {
        await uploadImage(saved.id);
        saved.hasImage = true;
      }

      const idx = entries.findIndex((e) => e.id === saved.id);
      if (idx >= 0) {
        entries[idx] = saved;
      } else {
        entries.push(saved);
      }

      renderEntries();
      closeModal();
      restoreFocusToEntry(saved.id);
    } catch (err) {
      if (err.expired) {
        await handleSessionExpired();
        return;
      }
      showFormError(err.message || 'The entry could not be saved.');
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  function findEntryById(id) {
    return entries.find((e) => e.id === id) || null;
  }

  function editEntry(id) {
    const entry = findEntryById(id);
    if (entry) openEditModal(entry);
  }

  async function deleteEntry(id) {
    const entry = findEntryById(id);
    if (!entry) return;
    const label = entry.clientName ? `"${entry.clientName}"` : 'this entry';
    if (!confirm(`Delete ${label}? This cannot be undone.`)) return;
    try {
      await api('delete', { method: 'POST', body: { id } });
      entries = entries.filter((e) => e.id !== id);
      renderEntries();
      const tbody = getEl('logTableBody');
      const nextBtn = tbody && tbody.querySelector('button[data-entry-id]');
      if (nextBtn && typeof nextBtn.focus === 'function') nextBtn.focus();
    } catch (err) {
      if (err.expired) {
        await handleSessionExpired();
        return;
      }
      alert(err.message || 'The entry could not be deleted.');
    }
  }

  async function handleSessionExpired() {
    authenticated = false;
    entries = [];
    renderEntries();
    showPinGate();
    showPinError('Your session expired. Enter the PIN to continue.');
  }

  // ---------- Load ----------

  async function loadEntries() {
    try {
      const data = await api('list');
      entries = Array.isArray(data.entries) ? data.entries : [];
      renderEntries();
    } catch (err) {
      if (err.expired) {
        await handleSessionExpired();
        return;
      }
      alert(err.message || 'The log could not be loaded.');
    }
  }

  // ---------- CSV export ----------

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
    const trimmed = s.replace(/^[  ﻿]+/, '');
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
    const headers = [
      'Date',
      'Client Name',
      'Document Type',
      'Notarization Type',
      'Notes',
      'Identification Type',
      'Identification Number',
    ];
    const rows = sortedEntries().map((e) => [
      e.date,
      e.clientName || '',
      documentTypeLabel(e),
      e.notarizationType || '',
      e.notes || '',
      e.identificationType || '',
      e.identificationNumber || '',
    ]);
    const csv =
      [headers, ...rows]
        .map((r) => r.map(csvEscape).join(','))
        .join('\r\n') + '\r\n';

    // The BOM makes Excel read UTF-8 correctly instead of rendering
    // "JosÃ©" for a client named "José".
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
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

    const closeBtn = getEl('closeModalBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    const cancelBtn = getEl('cancelBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

    const form = getEl('entryForm');
    if (form) form.addEventListener('submit', saveEntry);

    const search = getEl('searchInput');
    if (search) search.addEventListener('input', filterEntries);

    const docSelect = getEl('documentType');
    if (docSelect) docSelect.addEventListener('change', toggleOtherField);

    const imageInput = getEl('entryImage');
    if (imageInput) imageInput.addEventListener('change', handleImageSelected);

    const pinForm = getEl('pinForm');
    if (pinForm) {
      pinForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        showPinError('');
        const input = getEl('pinInput');
        const pin = input ? input.value : '';
        const button = getEl('pinSubmitBtn');
        if (button) button.disabled = true;
        try {
          await doLogin(pin);
          showLogContent();
          await loadEntries();
        } catch (err) {
          showPinError(err.message || 'Incorrect PIN.');
          if (input) {
            input.value = '';
            input.focus();
          }
        } finally {
          if (button) button.disabled = false;
        }
      });
    }

    const logoutBtn = getEl('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        await doLogout();
      });
    }

    renderEntries();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Resume an existing session, or show the PIN gate.
  (async () => {
    const ok = await checkSession();
    if (ok) {
      showLogContent();
      await loadEntries();
    } else {
      showPinGate();
    }
  })();
})();
