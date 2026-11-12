// log.js — Notary log (localStorage-backed)
//
// All entries are stored client-side only. Nothing is sent to any server.
//
// Washington notarial journal support:
//   RCW 42.45.180(4)  — required content of a journal entry
//   WAC 308-30-200(1) — tangible journal content (ID method, signature)
//   WAC 308-30-200(2) — electronic journal: in addition to, authenticate,
//                        tamper-evident, backup, copies
//   WAC 308-30-190(2) — number of statements/documents per entry
//   RCW 42.45.180(1)  — 10-year retention
//   WAC 308-30-200(3) — journal is the notary's exclusive property
//
// The electronic journal here is an ADDITIONAL record. It does not replace
// the tangible journal (WAC 308-30-200(2)(a)).

(function () {
  'use strict';

  // ---------- Constants ----------

  const STORAGE_KEY = 'notaryLogEntries';
  const LOCK_KEY = 'notaryLogLock';
  const BACKUP_KEY = 'notaryLogBackup';

  // Hash-chain genesis. Every entry hash = SHA-256(prevHash + '|' + payload).
  const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

  // PBKDF2-HMAC-SHA-256 work factor for the journal password.
  const PBKDF2_ITERATIONS = 150000;

  // Reminder thresholds (WAC 308-30-200(2)(e) — create a duplicate backup).
  const BACKUP_REMINDER_DAYS = 7;
  const BACKUP_REMINDER_NEW_ENTRIES = 5;

  // Identification methods (WAC 308-30-200(1)(ii)).
  const ID_METHODS = [
    { value: 'personal-knowledge', label: 'Personal knowledge' },
    { value: 'government-id', label: 'Government-issued photo ID' },
    { value: 'ron', label: 'Remote online notarization (RON)' },
    { value: 'document-owner', label: 'Satisfactory evidence / document owner' },
    { value: 'other', label: 'Other (describe in notes)' },
  ];

  // ---------- Module state ----------

  // Entries live in memory for the whole session. They are only *rendered*
  // once the journal has been unlocked (see the lock screen below).
  let entries = loadEntries();
  let unlocked = false;
  let signatureCtx = null;
  let signatureHasInk = false;
  // The signature of the entry currently open in the form, so editing an
  // unrelated field keeps the original signature.
  let loadedSignature = null;

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

  // Normalize a stored record into the current shape. Legacy records (saved
  // before the WA-compliance fields existed) keep their original values; the
  // missing fields stay empty so nothing is ever fabricated.
  function normalizeEntry(entry) {
    return {
      id: typeof entry.id === 'string' ? entry.id : '',
      date: entry.date,
      time: typeof entry.time === 'string' ? entry.time : '',
      clientName: entry.clientName,
      clientAddress: typeof entry.clientAddress === 'string' ? entry.clientAddress : '',
      documentType: typeof entry.documentType === 'string' ? entry.documentType : '',
      notarizationType:
        typeof entry.notarizationType === 'string' ? entry.notarizationType : '',
      identificationMethod:
        typeof entry.identificationMethod === 'string' ? entry.identificationMethod : '',
      signature: normalizeSignature(entry.signature),
      statementCount: normalizeCount(entry.statementCount),
      notes: typeof entry.notes === 'string' ? entry.notes : '',
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
      hash: typeof entry.hash === 'string' ? entry.hash : '',
      prevHash: typeof entry.prevHash === 'string' ? entry.prevHash : '',
    };
  }

  function normalizeSignature(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.type !== 'drawn' && value.type !== 'typed') return null;
    if (typeof value.value !== 'string' || value.value === '') return null;
    return {
      type: value.type,
      value: value.value,
      signedAt: typeof value.signedAt === 'string' ? value.signedAt : '',
    };
  }

  // A statement count of null means "not recorded" (legacy entry). We never
  // guess a number for an entry the notary has not completed.
  function normalizeCount(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const int = Math.floor(n);
    return int >= 1 ? int : null;
  }

  function saveEntryList(list) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
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

  // ---------- Crypto ----------

  // crypto.subtle is only available in a secure context (https:// or
  // http://localhost). Detect it rather than throwing deep inside a save.
  function hasSubtleCrypto() {
    return (
      typeof crypto !== 'undefined' &&
      crypto !== null &&
      crypto.subtle &&
      typeof crypto.subtle.digest === 'function'
    );
  }

  function bytesToHex(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let out = '';
    for (let i = 0; i < view.length; i++) {
      out += view[i].toString(16).padStart(2, '0');
    }
    return out;
  }

  function hexToBytes(hex) {
    const clean = String(hex || '');
    const out = new Uint8Array(Math.floor(clean.length / 2));
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(clean.substr(i * 2, 2), 16) || 0;
    }
    return out;
  }

  async function sha256Hex(text) {
    if (!hasSubtleCrypto()) {
      throw new Error(
        'Web Crypto is unavailable. Open this page over https:// (or http://localhost) ' +
          'to use the journal lock and the tamper-evident hash chain.'
      );
    }
    const data = new TextEncoder().encode(String(text));
    const digest = await crypto.subtle.digest('SHA-256', data);
    return bytesToHex(digest);
  }

  // Per-journal random salt for the password hash and the backup file.
  function randomSalt(byteLength) {
    const bytes = byteLength || 16;
    const arr = new Uint8Array(bytes);
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(arr);
    } else {
      for (let i = 0; i < arr.length; i++) {
        arr[i] = Math.floor(Math.random() * 256);
      }
    }
    return bytesToHex(arr);
  }

  // Password hash: PBKDF2-HMAC-SHA-256 with a per-journal salt. Only the
  // salt and the derived hash are stored — never the password itself.
  async function derivePasswordHash(password, saltHex, iterations) {
    if (!hasSubtleCrypto()) {
      throw new Error('Web Crypto is unavailable, so the journal cannot be locked.');
    }
    const rounds = iterations || PBKDF2_ITERATIONS;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(String(password)),
      'PBKDF2',
      false,
      ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: hexToBytes(saltHex),
        iterations: rounds,
        hash: 'SHA-256',
      },
      key,
      256
    );
    return bytesToHex(bits);
  }

  function constantTimeEquals(a, b) {
    const x = String(a || '');
    const y = String(b || '');
    let diff = x.length ^ y.length;
    const max = Math.max(x.length, y.length);
    for (let i = 0; i < max; i++) {
      diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
    }
    return diff === 0;
  }

  // ---------- Hash chain (WAC 308-30-200(2)(d)) ----------

  // The canonical, order-stable representation of an entry that gets hashed.
  // `updatedAt` is deliberately excluded: it is bookkeeping, not record
  // content, and leaving it out keeps a re-seal of unchanged data stable.
  function entryPayload(entry) {
    const sig = entry && entry.signature ? entry.signature : null;
    return JSON.stringify([
      String((entry && entry.id) || ''),
      String((entry && entry.date) || ''),
      String((entry && entry.time) || ''),
      String((entry && entry.clientName) || ''),
      String((entry && entry.clientAddress) || ''),
      String((entry && entry.documentType) || ''),
      String((entry && entry.notarizationType) || ''),
      String((entry && entry.identificationMethod) || ''),
      sig ? [String(sig.type), String(sig.value), String(sig.signedAt)] : ['', '', ''],
      entry && entry.statementCount !== null && entry.statementCount !== undefined
        ? String(entry.statementCount)
        : '',
      String((entry && entry.notes) || ''),
      String((entry && entry.createdAt) || ''),
    ]);
  }

  async function computeEntryHash(prevHash, entry) {
    if (!hasSubtleCrypto()) {
      // No Web Crypto (insecure context): the chain cannot be computed. The
      // journal still works, but it is not tamper-evident — the integrity
      // check says so explicitly rather than pretending.
      return '';
    }
    return sha256Hex(String(prevHash || '') + '|' + entryPayload(entry));
  }

  // Recompute the whole chain from genesis.
  async function buildChain(list) {
    const out = list.map((e) => normalizeEntry(e));
    let prev = GENESIS_HASH;
    for (let i = 0; i < out.length; i++) {
      out[i].prevHash = prev;
      out[i].hash = await computeEntryHash(prev, out[i]);
      prev = out[i].hash;
    }
    return out;
  }

  // Recompute hashes from `index` onward. Entries before `index` keep the
  // hashes they already had, so editing one entry does not rewrite history.
  // `index` is the first entry that may need a new hash; if it is past the
  // end of the list (e.g. the last entry was deleted) nothing is rehashed.
  async function rechainFrom(list, index) {
    const out = list.map((e) => normalizeEntry(e));
    const start = Math.max(0, index);
    if (start >= out.length) return out;
    let prev = start === 0 ? GENESIS_HASH : out[start - 1].hash;
    for (let i = start; i < out.length; i++) {
      out[i].prevHash = prev;
      out[i].hash = await computeEntryHash(prev, out[i]);
      prev = out[i].hash;
    }
    return out;
  }

  // Seal entries that have no hash yet (legacy records, or a journal restored
  // from a backup without chain data). Existing hashes are NEVER rewritten
  // and an existing prevHash is never "repaired" here — a mismatch between
  // them is tampering, and verifyChain is what reports it.
  //
  // Entries are normalized on the way through, so a record written back to
  // storage always has the canonical shape. Normalizing never invents a
  // value: a missing field becomes "" (or null for the statement count) and
  // the record stays flagged as a legacy entry until the notary completes it.
  async function ensureChain(list) {
    const out = list.map((e) => normalizeEntry(e));
    let prev = GENESIS_HASH;
    let changed = false;
    for (let i = 0; i < out.length; i++) {
      if (!out[i].hash) {
        out[i].prevHash = prev;
        out[i].hash = await computeEntryHash(prev, out[i]);
        changed = true;
      }
      prev = out[i].hash;
    }
    return { entries: out, changed: changed };
  }

  // Recompute the chain and report anything that no longer matches the
  // recorded hashes — i.e. a record that was changed outside this app.
  async function verifyChain(list) {
    const problems = [];
    let prev = GENESIS_HASH;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const expected = await computeEntryHash(prev, e);
      if (!e.hash) {
        // Legacy record with no recorded hash: it cannot be verified, but the
        // chain still continues through it so later entries stay checkable.
        problems.push({
          index: i,
          type: 'unsealed',
          message: 'Entry ' + (i + 1) + ' has no recorded hash and cannot be verified.',
          expected: expected,
          actual: '',
        });
        prev = expected;
        continue;
      }
      if (e.prevHash && e.prevHash !== prev) {
        problems.push({
          index: i,
          type: 'broken-link',
          message: 'Entry ' + (i + 1) + ' is no longer linked to the previous entry.',
          expected: prev,
          actual: e.prevHash,
        });
      }
      if (expected !== e.hash) {
        problems.push({
          index: i,
          type: 'altered',
          message: 'Entry ' + (i + 1) + ' was changed outside this app.',
          expected: expected,
          actual: e.hash,
        });
      }
      prev = e.hash;
    }
    return {
      ok: problems.length === 0,
      total: list.length,
      problems: problems,
    };
  }

  // ---------- Required-field bookkeeping ----------

  // The fields RCW 42.45.180(4) and WAC 308-30-200(1) require.
  function missingRequiredFields(entry) {
    const missing = [];
    if (!entry || !entry.date) missing.push('date');
    if (!entry || !entry.time) missing.push('time');
    if (!entry || !entry.clientName) missing.push('principal name');
    if (!entry || !entry.clientAddress) missing.push('principal address');
    if (!entry || !entry.documentType) missing.push('document type');
    if (!entry || !entry.notarizationType) missing.push('notarization type');
    if (!entry || !entry.identificationMethod) missing.push('identification method');
    if (!entry || !entry.signature) missing.push('principal signature');
    if (!entry || entry.statementCount === null || entry.statementCount === undefined) {
      missing.push('number of statements/documents');
    }
    return missing;
  }

  function isLegacyEntry(entry) {
    return missingRequiredFields(entry).length > 0;
  }

  // ---------- Dates and times ----------

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

  // Current local wall-clock time as "HH:MM" (24-hour).
  function nowLocalTimeISO() {
    const now = new Date();
    return (
      String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')
    );
  }

  // "14:30" -> "2:30 PM". Returns '' for an unknown/missing time.
  function formatClockTime(time) {
    if (!time) return '';
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(time).trim());
    if (!match) return '';
    let hours = Number(match[1]);
    const minutes = match[2];
    if (!Number.isFinite(hours) || hours < 0 || hours > 23) return '';
    const suffix = hours >= 12 ? 'PM' : 'AM';
    let display = hours % 12;
    if (display === 0) display = 12;
    return display + ':' + minutes + ' ' + suffix;
  }

  // Human-readable combined date + time, e.g. "Nov 11, 2026 at 2:30 PM".
  function formatDateTime(dateStr, timeStr) {
    const datePart = formatDate(dateStr);
    const timePart = formatClockTime(timeStr);
    if (!datePart) return '';
    if (!timePart) return datePart;
    return datePart + ' at ' + timePart;
  }

  // Machine-readable combined date + time, e.g. "2026-11-11 14:30".
  function formatDateTimeISO(dateStr, timeStr) {
    if (!dateStr) return '';
    if (!timeStr) return dateStr;
    return dateStr + ' ' + timeStr;
  }

  // Newest first — the order the table shows and the order the CSV exports.
  // Within one date, the later notarial act comes first.
  function sortEntries(list) {
    return [...list].sort((a, b) => {
      const da = parseLocalDate(a.date);
      const db = parseLocalDate(b.date);
      const ta = da ? da.getTime() : 0;
      const tb = db ? db.getTime() : 0;
      if (tb !== ta) return tb - ta;
      const tsa = a.time || '';
      const tsb = b.time || '';
      if (tsa === tsb) return 0;
      return tsb > tsa ? 1 : -1;
    });
  }

  function sortedEntries() {
    return sortEntries(entries);
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

  function showEl(el, visible) {
    if (!el) return;
    if (visible) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
  }

  // ---------- Rendering ----------

  function makeCell(text) {
    const td = document.createElement('td');
    td.textContent = text;
    return td;
  }

  function makePrincipalCell(entry) {
    const td = document.createElement('td');
    const name = document.createElement('strong');
    name.textContent = entry.clientName || '';
    td.appendChild(name);
    if (entry.clientAddress) {
      const addr = document.createElement('div');
      addr.className = 'cell-sub';
      addr.textContent = entry.clientAddress;
      td.appendChild(addr);
    }
    return td;
  }

  function makeSignatureCell(entry) {
    const td = document.createElement('td');
    const sig = entry.signature;
    if (!sig) {
      td.textContent = '—';
      td.className = 'cell-muted';
      return td;
    }
    if (sig.type === 'typed') {
      td.textContent = sig.value;
      return td;
    }
    if (typeof sig.value === 'string' && sig.value.indexOf('data:image/png;base64,') === 0) {
      const img = document.createElement('img');
      img.className = 'sig-thumb';
      img.setAttribute('alt', 'Signature of ' + (entry.clientName || 'principal'));
      img.setAttribute('src', sig.value);
      td.appendChild(img);
      return td;
    }
    td.textContent = 'Signed';
    return td;
  }

  function makeStatusCell(entry) {
    const td = document.createElement('td');
    const missing = missingRequiredFields(entry);
    if (missing.length === 0) {
      const ok = document.createElement('span');
      ok.className = 'status-complete';
      ok.textContent = 'Complete';
      td.appendChild(ok);
      return td;
    }
    const badge = document.createElement('span');
    badge.className = 'status-badge';
    badge.textContent = 'Legacy — missing required fields';
    badge.setAttribute('title', 'Missing: ' + missing.join(', '));
    td.appendChild(badge);
    return td;
  }

  function makeActionsCell(index) {
    const td = document.createElement('td');
    td.className = 'row-actions';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn-small';
    editBtn.textContent = 'Edit';
    editBtn.setAttribute('aria-label', 'Edit entry');
    editBtn.addEventListener('click', () => editEntry(index));

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn-small';
    copyBtn.textContent = 'Copy';
    copyBtn.setAttribute('aria-label', 'Make a copy of this entry');
    copyBtn.addEventListener('click', () => openCopyModal(index));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-small btn-danger';
    delBtn.textContent = 'Delete';
    delBtn.setAttribute('aria-label', 'Delete entry');
    delBtn.addEventListener('click', () => deleteEntry(index));

    td.appendChild(editBtn);
    td.appendChild(document.createTextNode(' '));
    td.appendChild(copyBtn);
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

    sortedEntries().forEach((entry) => {
      const realIndex = entries.indexOf(entry);
      const tr = document.createElement('tr');
      tr.appendChild(makeCell(formatDateTime(entry.date, entry.time)));
      tr.appendChild(makePrincipalCell(entry));
      tr.appendChild(makeCell(entry.documentType || ''));
      tr.appendChild(makeCell(entry.notarizationType || ''));
      tr.appendChild(makeCell(idMethodLabel(entry.identificationMethod)));
      tr.appendChild(
        makeCell(
          entry.statementCount === null || entry.statementCount === undefined
            ? '—'
            : String(entry.statementCount)
        )
      );
      tr.appendChild(makeSignatureCell(entry));
      tr.appendChild(makeCell(entry.notes || '—'));
      tr.appendChild(makeStatusCell(entry));
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
    updateBackupReminder();
  }

  function idMethodLabel(value) {
    if (!value) return '';
    const found = ID_METHODS.find((m) => m.value === value);
    return found ? found.label : value;
  }

  // ---------- Filtering ----------

  function filterEntries() {
    const query = (getEl('searchInput')?.value || '').toLowerCase().trim();
    const rows = getEl('logTableBody')?.querySelectorAll('tr') || [];
    rows.forEach((row) => {
      // Match only the data cells. Matching row.textContent would also match
      // the literal "Edit"/"Delete"/"Copy" button labels in the actions cell.
      const cells = row.querySelectorAll('td:not(:last-child)');
      let text = '';
      cells.forEach((cell) => {
        text += ' ' + cell.textContent;
      });
      row.style.display = !query || text.toLowerCase().includes(query) ? '' : 'none';
    });
  }

  // ---------- Signature pad (WAC 308-30-200(1)(iii)) ----------

  function setupSignaturePad() {
    const canvas = getEl('signatureCanvas');
    if (!canvas || typeof canvas.getContext !== 'function') return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    signatureCtx = ctx;
    signatureHasInk = false;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    let drawing = false;

    const pointFor = (event) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) * (canvas.width / (rect.width || 1)),
        y: (event.clientY - rect.top) * (canvas.height / (rect.height || 1)),
      };
    };

    canvas.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      drawing = true;
      signatureHasInk = true;
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch (err) {
        /* capture is a nicety; drawing still works without it */
      }
      const p = pointFor(event);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + 0.01, p.y);
      ctx.stroke();
      clearTypedSignature();
      updateSignatureStatus();
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!drawing) return;
      event.preventDefault();
      const p = pointFor(event);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    });

    const stop = (event) => {
      if (!drawing) return;
      drawing = false;
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch (err) {
        /* ignore */
      }
      updateSignatureStatus();
    };

    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
    canvas.addEventListener('pointerleave', stop);
  }

  function clearPad() {
    const canvas = getEl('signatureCanvas');
    loadedSignature = null;
    if (!canvas || !signatureCtx) {
      signatureHasInk = false;
      return;
    }
    signatureCtx.clearRect(0, 0, canvas.width, canvas.height);
    signatureCtx.fillStyle = '#ffffff';
    signatureCtx.fillRect(0, 0, canvas.width, canvas.height);
    signatureHasInk = false;
    updateSignatureStatus();
  }

  function clearTypedSignature() {
    const typed = getEl('signatureTyped');
    if (typed && typed.value) typed.value = '';
  }

  function updateSignatureStatus() {
    const status = getEl('sigStatus');
    if (!status) return;
    const typed = (getEl('signatureTyped')?.value || '').trim();
    if (signatureHasInk) status.textContent = 'Signature drawn';
    else if (typed) status.textContent = 'Typed signature: ' + typed;
    else status.textContent = 'No signature captured';
  }

  // Current signature, or null when the principal has not signed.
  // When an existing entry is being edited, the stored signature is kept
  // unless the notary draws a new one or types a new name — so editing an
  // unrelated field does not silently replace the captured signature (and
  // does not change the entry's hash).
  function currentSignature() {
    const typed = (getEl('signatureTyped')?.value || '').trim();
    if (typed) {
      return { type: 'typed', value: typed, signedAt: new Date().toISOString() };
    }
    const canvas = getEl('signatureCanvas');
    if (signatureHasInk && canvas && typeof canvas.toDataURL === 'function') {
      try {
        const dataUrl = canvas.toDataURL('image/png');
        if (dataUrl && dataUrl.indexOf('data:image/png;base64,') === 0) {
          return { type: 'drawn', value: dataUrl, signedAt: new Date().toISOString() };
        }
      } catch (err) {
        console.warn('notary log: could not read signature image', err);
      }
    }
    if (loadedSignature) {
      return {
        type: loadedSignature.type,
        value: loadedSignature.value,
        signedAt: loadedSignature.signedAt,
      };
    }
    return null;
  }

  // Put a stored signature back into the form when editing.
  function loadSignatureIntoForm(sig) {
    clearPad();
    loadedSignature = sig || null;
    const typed = getEl('signatureTyped');
    if (typed) typed.value = '';
    if (!sig) {
      updateSignatureStatus();
      return;
    }
    if (sig.type === 'typed') {
      if (typed) typed.value = sig.value;
      updateSignatureStatus();
      return;
    }
    const canvas = getEl('signatureCanvas');
    if (
      typeof Image === 'undefined' ||
      !canvas ||
      !signatureCtx ||
      typeof sig.value !== 'string' ||
      sig.value.indexOf('data:image/png;base64,') !== 0
    ) {
      return;
    }
    const img = new Image();
    img.onload = () => {
      signatureCtx.drawImage(img, 0, 0, canvas.width, canvas.height);
      signatureHasInk = true;
      updateSignatureStatus();
    };
    img.src = sig.value;
  }

  // ---------- Modal (add / edit) ----------

  let lastFocusedElement = null;
  let copyIndex = -1;

  function openAddModal() {
    setText('modalTitle', 'Add Entry');
    const form = getEl('entryForm');
    if (form) form.reset();
    getEl('entryId').value = '';
    getEl('entryDate').value = todayLocalISO();
    getEl('entryTime').value = nowLocalTimeISO();
    getEl('statementCount').value = '1';
    loadSignatureIntoForm(null);
    showSignatureError('');
    showModal();
  }

  function openEditModal(entry, index) {
    setText('modalTitle', 'Edit Entry');
    getEl('entryId').value = String(index);
    getEl('entryDate').value = entry.date || '';
    getEl('entryTime').value = entry.time || '';
    getEl('clientName').value = entry.clientName || '';
    getEl('clientAddress').value = entry.clientAddress || '';
    getEl('documentType').value = entry.documentType || '';
    getEl('notarizationType').value = entry.notarizationType || '';
    getEl('identificationMethod').value = entry.identificationMethod || '';
    getEl('statementCount').value =
      entry.statementCount === null || entry.statementCount === undefined
        ? ''
        : String(entry.statementCount);
    getEl('notes').value = entry.notes || '';
    loadSignatureIntoForm(entry.signature);
    showSignatureError('');
    showModal();
  }

  function showModal() {
    // Only remember the opener the first time; re-showing an already-open
    // dialog must not overwrite it with a field inside the dialog.
    if (!getEl('entryModal').classList.contains('show')) {
      lastFocusedElement = document.activeElement;
    }
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

  function showSignatureError(message) {
    const box = getEl('signatureError');
    if (!box) return;
    if (message) {
      box.textContent = message;
      box.removeAttribute('hidden');
    } else {
      box.textContent = '';
      box.setAttribute('hidden', '');
    }
  }

  async function saveEntry(event) {
    event.preventDefault();
    const idVal = getEl('entryId').value;

    const countRaw = getEl('statementCount').value;
    const countNum = Number(countRaw);
    if (!countRaw || !Number.isFinite(countNum) || Math.floor(countNum) < 1) {
      showSignatureError('');
      const countField = getEl('statementCount');
      if (countField) countField.focus();
      alert('Enter how many statements or documents were notarized (1 or more).');
      return;
    }

    const signature = currentSignature();
    if (!signature) {
      showSignatureError(
        'A principal signature is required. Ask the principal to sign in the box, or type their full name.'
      );
      const canvas = getEl('signatureCanvas');
      if (canvas && typeof canvas.focus === 'function') canvas.focus();
      return;
    }
    showSignatureError('');

    const existing =
      idVal === '' ? null : entries[Number(idVal)] || null;

    const record = {
      id: existing && existing.id ? existing.id : newEntryId(),
      date: getEl('entryDate').value,
      time: getEl('entryTime').value,
      clientName: getEl('clientName').value.trim(),
      clientAddress: getEl('clientAddress').value.trim(),
      documentType: getEl('documentType').value,
      notarizationType: getEl('notarizationType').value,
      identificationMethod: getEl('identificationMethod').value,
      signature: signature,
      statementCount: Math.floor(countNum),
      notes: getEl('notes').value.trim(),
      createdAt: existing && existing.createdAt ? existing.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hash: '',
      prevHash: '',
    };

    if (!record.date || !record.clientName || !record.documentType || !record.notarizationType) {
      return; // HTML required attributes should have caught this already.
    }

    // Seal anything unsealed first so the chain links are complete, then
    // apply the change and re-chain from the touched entry onward.
    const sealed = await ensureChain(entries);
    const list = sealed.entries;

    let replacedIndex = -1;
    if (idVal === '' || existing === null) {
      list.push(record);
      replacedIndex = list.length - 1;
    } else {
      replacedIndex = Number(idVal);
      if (!Number.isInteger(replacedIndex) || replacedIndex < 0 || replacedIndex >= list.length) {
        list.push(record);
        replacedIndex = list.length - 1;
      } else {
        list[replacedIndex] = record;
      }
    }

    const chained = await rechainFrom(list, replacedIndex);

    if (!saveEntryList(chained)) {
      // Roll back the in-memory change so the UI and storage stay in sync.
      entries = sealed.entries;
      return;
    }

    entries = chained;
    renderEntries();
    // Keep the integrity status in step with the journal it describes.
    runIntegrityCheck();
    closeModal();
  }

  function newEntryId() {
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'e-' + Date.now().toString(36) + '-' + randomSalt(6);
  }

  function editEntry(index) {
    if (index >= 0 && index < entries.length) {
      openEditModal(entries[index], index);
    }
  }

  async function deleteEntry(index) {
    if (index < 0 || index >= entries.length) return;
    const entry = entries[index];
    const label = entry.clientName ? `"${entry.clientName}"` : 'this entry';
    if (!confirm(`Delete ${label}? This cannot be undone.`)) return;

    const sealed = await ensureChain(entries);
    const list = sealed.entries;
    list.splice(index, 1);
    const chained = await rechainFrom(list, index);

    if (!saveEntryList(chained)) {
      entries = sealed.entries;
      return;
    }
    entries = chained;
    renderEntries();
    runIntegrityCheck();
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

  const CSV_HEADERS = [
    'Date',
    'Time',
    'Date & Time',
    'Principal Name',
    'Principal Address',
    'Document Type',
    'Notarization Type',
    'Identification Method',
    'Principal Signature',
    'Signature Type',
    'Number of Statements/Documents',
    'Notes',
    'Entry Hash',
    'Missing Required Fields',
  ];

  // The signature value as it should appear in a flat export: a typed name,
  // or the full PNG data URL for a drawn signature.
  function signatureText(entry) {
    const sig = entry && entry.signature;
    if (!sig) return '';
    return sig.value || '';
  }

  function buildCsv(list) {
    const rows = sortEntries(list).map((e) => [
      e.date || '',
      e.time || '',
      formatDateTimeISO(e.date, e.time),
      e.clientName || '',
      e.clientAddress || '',
      e.documentType || '',
      e.notarizationType || '',
      idMethodLabel(e.identificationMethod),
      signatureText(e),
      e.signature ? e.signature.type : '',
      e.statementCount === null || e.statementCount === undefined ? '' : String(e.statementCount),
      e.notes || '',
      e.hash || '',
      missingRequiredFields(e).join('; '),
    ]);
    return (
      [CSV_HEADERS, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n'
    );
  }

  function exportLog() {
    if (entries.length === 0) {
      alert('No entries to export.');
      return;
    }
    const csv = buildCsv(entries);
    downloadFile(
      `notary-log-${todayLocalISO()}.csv`,
      csv,
      'text/csv;charset=utf-8'
    );
  }

  // ---------- JSON export / backup (WAC 308-30-200(2)(e)) ----------

  function buildBackup(list) {
    const sorted = sortEntries(list);
    return {
      format: 'jentalent-notary-journal-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      notary: 'Jenifer Talent, Notary Public',
      chain: {
        algorithm: 'SHA-256',
        linked: true,
        genesis: GENESIS_HASH,
      },
      entryCount: list.length,
      entries: list,
      summary: {
        earliest: sorted.length ? sorted[sorted.length - 1].date : null,
        latest: sorted.length ? sorted[0].date : null,
      },
    };
  }

  function exportJson() {
    if (entries.length === 0) {
      alert('No entries to export.');
      return;
    }
    const payload = buildBackup(entries);
    downloadFile(
      `notary-journal-backup-${todayLocalISO()}.json`,
      JSON.stringify(payload, null, 2),
      'application/json'
    );
    recordBackupTaken();
  }

  function downloadFile(filename, content, type) {
    const blob = new Blob([content], { type: type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---------- Restore (WAC 308-30-200(2)(e)) ----------

  // Validate a backup file *before* it is allowed to overwrite anything.
  function parseBackup(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      return { ok: false, error: 'That file is not valid JSON.' };
    }
    if (!data || typeof data !== 'object') {
      return { ok: false, error: 'That file does not contain a journal backup.' };
    }
    if (data.format !== 'jentalent-notary-journal-backup') {
      return { ok: false, error: 'That file is not a jentalent.com notary journal backup.' };
    }
    if (!Array.isArray(data.entries)) {
      return { ok: false, error: 'The backup file contains no entry list.' };
    }
    const usable = data.entries.filter(isEntryShape).map(normalizeEntry);
    if (usable.length !== data.entries.length) {
      return { ok: false, error: 'The backup file contains entries that cannot be read.' };
    }
    return {
      ok: true,
      entries: usable,
      exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : '',
      entryCount: usable.length,
    };
  }

  function handleRestoreFile(file) {
    const panel = getEl('restorePanel');
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const result = parseBackup(String(reader.result || ''));
      if (!result.ok) {
        setText('restoreMessage', result.error);
        showEl(panel, true);
        return;
      }
      const range =
        result.entries.length > 0
          ? formatDateTime(result.entries[0].date, result.entries[0].time) +
            (result.entryCount > 1
              ? ' – ' + formatDateTime(result.entries[result.entries.length - 1].date, result.entries[result.entries.length - 1].time)
              : '')
          : 'no entries';
      setText(
        'restoreMessage',
        'Backup contains ' +
          result.entryCount +
          ' entr' +
          (result.entryCount === 1 ? 'y' : 'ies') +
          ' (' +
          range +
          '). Restoring replaces the journal currently on this device (' +
          entries.length +
          ' entries). This cannot be undone.'
      );
      showEl(panel, true);
      getEl('restoreConfirmBtn').disabled = false;
      getEl('restoreConfirmBtn').dataset.pending = JSON.stringify(result.entries);
    };
    reader.onerror = () => {
      setText('restoreMessage', 'That file could not be read.');
      showEl(panel, true);
    };
    reader.readAsText(file);
  }

  async function confirmRestore() {
    const btn = getEl('restoreConfirmBtn');
    const raw = btn.dataset.pending;
    showEl(getEl('restorePanel'), false);
    if (!raw) return;
    let restored;
    try {
      restored = JSON.parse(raw);
    } catch (err) {
      return;
    }
    btn.dataset.pending = '';
    btn.disabled = true;

    // Keep the hashes that came in the backup file: if the backup's chain is
    // broken, that stays visible instead of being quietly re-sealed. Only
    // records with no hash at all (older backups) get sealed here.
    const sealed = await ensureChain(restored);
    if (!saveEntryList(sealed.entries)) {
      entries = sealed.entries;
      renderEntries();
      return;
    }
    entries = sealed.entries;
    renderEntries();
    setText('integrityStatus', 'Journal restored from backup.');
    setIntegrityTone('ok');
    runIntegrityCheck();
  }

  // ---------- Backup reminder (WAC 308-30-200(2)(e)) ----------

  function readBackupMeta() {
    try {
      const raw = localStorage.getItem(BACKUP_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== 'object') return { lastBackupAt: '', entryCount: 0 };
      return {
        lastBackupAt: typeof parsed.lastBackupAt === 'string' ? parsed.lastBackupAt : '',
        entryCount: Number(parsed.entryCount) || 0,
      };
    } catch (err) {
      return { lastBackupAt: '', entryCount: 0 };
    }
  }

  function recordBackupTaken() {
    try {
      localStorage.setItem(
        BACKUP_KEY,
        JSON.stringify({
          lastBackupAt: new Date().toISOString(),
          entryCount: entries.length,
        })
      );
    } catch (err) {
      /* the reminder is advisory only */
    }
    updateBackupReminder();
  }

  function updateBackupReminder() {
    const banner = getEl('backupReminder');
    if (!banner) return;
    const meta = readBackupMeta();
    const last = meta.lastBackupAt ? parseLocalDate(meta.lastBackupAt) : null;
    let reason = '';

    if (entries.length === 0) {
      reason = '';
    } else if (!meta.lastBackupAt) {
      reason = 'This journal has not been backed up yet.';
    } else if (last && Date.now() - last.getTime() > BACKUP_REMINDER_DAYS * 86400000) {
      reason =
        'It has been more than ' +
        BACKUP_REMINDER_DAYS +
        ' days since the last backup.';
    } else if (entries.length > meta.entryCount) {
      reason =
        'There are ' +
        (entries.length - meta.entryCount) +
        ' new entr' +
        (entries.length - meta.entryCount === 1 ? 'y' : 'ies') +
        ' since the last backup.';
    } else if (entries.length - meta.entryCount >= BACKUP_REMINDER_NEW_ENTRIES) {
      reason = 'Several entries have been added since the last backup.';
    }

    if (reason) {
      setText('backupReminderText', reason + ' Download a backup to keep a duplicate record.');
      showEl(banner, true);
    } else {
      showEl(banner, false);
    }
  }

  // ---------- Integrity check (WAC 308-30-200(2)(d)) ----------

  function setIntegrityTone(tone) {
    const box = getEl('integrityStatus');
    if (!box) return;
    box.className = 'integrity-' + tone;
  }

  async function runIntegrityCheck() {
    const status = getEl('integrityStatus');
    if (!status) return;
    if (!hasSubtleCrypto()) {
      status.textContent =
        'Integrity checking is unavailable: Web Crypto needs an https:// (or localhost) page.';
      setIntegrityTone('warn');
      return;
    }
    const result = await verifyChain(entries);
    if (result.ok) {
      status.textContent =
        'Integrity verified — all ' +
        result.total +
        (result.total === 1 ? ' entry matches' : ' entries match') +
        ' the recorded hash chain.';
      setIntegrityTone('ok');
      return;
    }
    const altered = result.problems.filter((p) => p.type === 'altered');
    const others = result.problems.length - altered.length;
    status.textContent =
      'Integrity problem: ' +
      altered.length +
      (altered.length === 1 ? ' entry appears' : ' entries appear') +
      ' to have been changed outside this app' +
      (others > 0
        ? ', plus ' + others + (others === 1 ? ' other issue' : ' other issues')
        : '') +
      '. Details: ' +
      result.problems.map((p) => p.message).join(' ');
    setIntegrityTone('bad');
  }

  // ---------- Per-entry copy (WAC 308-30-200(2)(f)) ----------

  function copyTextFor(entry) {
    const lines = [
      'NOTARIAL JOURNAL ENTRY — COPY',
      'Jenifer Talent, Notary Public — Longview, WA',
      'Copy of an entry in the electronic journal maintained in addition to the tangible journal.',
      '',
      'Date & Time: ' + formatDateTime(entry.date, entry.time),
      'Principal: ' + (entry.clientName || ''),
      'Principal Address: ' + (entry.clientAddress || ''),
      'Document Type: ' + (entry.documentType || ''),
      'Notarization Type: ' + (entry.notarizationType || ''),
      'Identification Method: ' + idMethodLabel(entry.identificationMethod),
      'Principal Signature: ' + (entry.signature ? entry.signature.type === 'typed' ? entry.signature.value : '[signed by hand — see image]' : 'not recorded'),
      'Number of Statements/Documents: ' +
        (entry.statementCount === null || entry.statementCount === undefined
          ? 'not recorded'
          : String(entry.statementCount)),
      'Notes: ' + (entry.notes || ''),
      'Entry Hash (SHA-256): ' + (entry.hash || 'not sealed'),
    ];
    return lines.join('\n');
  }

  function openCopyModal(index) {
    const entry = entries[index];
    if (!entry) return;
    copyIndex = index;
    const body = getEl('copyBody');
    if (body) {
      clearChildren(body);
      const list = document.createElement('dl');
      list.className = 'copy-list';
      const addRow = (label, value) => {
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value;
        list.appendChild(dt);
        list.appendChild(dd);
      };
      addRow('Date & Time', formatDateTime(entry.date, entry.time));
      addRow('Principal', entry.clientName || '');
      addRow('Principal Address', entry.clientAddress || '');
      addRow('Document Type', entry.documentType || '');
      addRow('Notarization Type', entry.notarizationType || '');
      addRow('Identification Method', idMethodLabel(entry.identificationMethod));
      addRow(
        'Number of Statements/Documents',
        entry.statementCount === null || entry.statementCount === undefined
          ? 'not recorded'
          : String(entry.statementCount)
      );
      addRow('Notes', entry.notes || '');
      addRow('Entry Hash (SHA-256)', entry.hash || 'not sealed');
      body.appendChild(list);

      if (entry.signature && entry.signature.type === 'drawn') {
        if (typeof entry.signature.value === 'string' && entry.signature.value.indexOf('data:image/png;base64,') === 0) {
          const img = document.createElement('img');
          img.className = 'sig-full';
          img.setAttribute('alt', 'Signature of ' + (entry.clientName || 'principal'));
          img.setAttribute('src', entry.signature.value);
          body.appendChild(img);
        }
      } else if (entry.signature && entry.signature.type === 'typed') {
        const p = document.createElement('p');
        p.className = 'copy-signature-typed';
        p.textContent = 'Typed signature: ' + entry.signature.value;
        body.appendChild(p);
      }

      const missing = missingRequiredFields(entry);
      if (missing.length > 0) {
        const warn = document.createElement('p');
        warn.className = 'copy-warning';
        warn.textContent =
          'This entry is missing required fields: ' +
          missing.join(', ') +
          '. Edit and complete it before relying on this copy.';
        body.appendChild(warn);
      }
    }

    // Printable copy — printed on its own page, separate from the app.
    const printArea = getEl('printArea');
    if (printArea) {
      clearChildren(printArea);
      const heading = document.createElement('h1');
      heading.textContent = 'Notarial Journal Entry — Copy';
      printArea.appendChild(heading);
      const pre = document.createElement('pre');
      pre.className = 'print-copy';
      pre.textContent = copyTextFor(entry);
      printArea.appendChild(pre);
    }

    showEl(getEl('copyModal'), true);
    getEl('copyModal').classList.add('show');
    document.body.classList.add('modal-open');
    const closeBtn = getEl('closeCopyBtn');
    if (closeBtn) closeBtn.focus();
  }

  function closeCopyModal() {
    const modal = getEl('copyModal');
    if (modal) {
      modal.classList.remove('show');
    }
    copyIndex = -1;
    document.body.classList.remove('modal-open');
  }

  function printCopy() {
    if (typeof window.print === 'function') window.print();
  }

  function copyToClipboard() {
    const entry = entries[copyIndex];
    if (!entry) {
      setText('copyStatus', 'That entry is no longer available.');
      return;
    }
    const text = copyTextFor(entry);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => setText('copyStatus', 'Copied to the clipboard.'),
        () => setText('copyStatus', 'Copy failed — select the text and copy manually.')
      );
    } else {
      setText('copyStatus', 'Clipboard is unavailable in this browser — use Print instead.');
    }
  }

  // ---------- Password lock (WAC 308-30-200(2)(c)) ----------

  function readLockRecord() {
    try {
      const raw = localStorage.getItem(LOCK_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== 'object' || !parsed.salt || !parsed.hash) return null;
      return parsed;
    } catch (err) {
      return null;
    }
  }

  function writeLockRecord(record) {
    localStorage.setItem(LOCK_KEY, JSON.stringify(record));
  }

  function showLockScreen(mode) {
    const screen = getEl('lockScreen');
    if (!screen) return;
    screen.classList.add('show');
    document.body.classList.add('locked');

    const setupFields = getEl('lockSetupFields');
    const unlockFields = getEl('lockUnlockFields');
    const resetPanel = getEl('lockResetPanel');
    const title = getEl('lockTitle');
    const intro = getEl('lockIntro');
    const submit = getEl('lockSubmitBtn');
    const forgot = getEl('forgotPasswordBtn');

    showEl(resetPanel, false);
    setText('lockError', '');

    if (mode === 'setup') {
      setText('lockTitle', 'Protect this journal');
      setText(
        'lockIntro',
        entries.length > 0
          ? 'Choose a password to protect the journal. Your ' +
              entries.length +
              ' existing entr' +
              (entries.length === 1 ? 'y' : 'ies') +
              ' will be kept.'
          : 'Choose a password to protect the journal. You will be asked for it each time you open this page.'
      );
      showEl(setupFields, true);
      showEl(unlockFields, false);
      submit.textContent = 'Save password and open journal';
      showEl(forgot, false);
    } else {
      setText('lockTitle', 'Journal locked');
      setText('lockIntro', 'Enter the journal password to open the notary journal.');
      showEl(setupFields, false);
      showEl(unlockFields, true);
      submit.textContent = 'Unlock journal';
      showEl(forgot, true);
    }

    const first = getEl('lockPassword') || getEl('newPassword');
    if (first) first.focus();
  }

  function hideLockScreen() {
    const screen = getEl('lockScreen');
    if (!screen) return;
    screen.classList.remove('show');
    document.body.classList.remove('locked');
  }

  function setLockError(message) {
    setText('lockError', message || '');
  }

  async function handleLockSubmit(event) {
    event.preventDefault();
    setLockError('');

    const record = readLockRecord();
    const setupMode = !record;

    if (setupMode) {
      const password = getEl('newPassword').value;
      const confirmPassword = getEl('confirmPassword').value;
      if (!password || password.length < 8) {
        setLockError('Use a password of at least 8 characters.');
        return;
      }
      if (password !== confirmPassword) {
        setLockError('The two passwords do not match.');
        return;
      }
      const salt = randomSalt(16);
      const hash = await derivePasswordHash(password, salt, PBKDF2_ITERATIONS);
      writeLockRecord({
        v: 1,
        algo: 'PBKDF2-HMAC-SHA-256',
        iterations: PBKDF2_ITERATIONS,
        salt: salt,
        hash: hash,
        createdAt: new Date().toISOString(),
      });
      getEl('newPassword').value = '';
      getEl('confirmPassword').value = '';
      finishUnlock();
      return;
    }

    const password = getEl('lockPassword').value;
    if (!password) {
      setLockError('Enter the journal password.');
      return;
    }
    const candidate = await derivePasswordHash(
      password,
      record.salt,
      record.iterations || PBKDF2_ITERATIONS
    );
    if (!constantTimeEquals(candidate, record.hash)) {
      setLockError('That password is not correct.');
      getEl('lockPassword').value = '';
      getEl('lockPassword').focus();
      return;
    }
    getEl('lockPassword').value = '';
    finishUnlock();
  }

  function finishUnlock() {
    unlocked = true;
    hideLockScreen();

    // Legacy records saved before the hash chain existed are sealed now, so
    // the whole journal becomes tamper-evident. Sealing never invents the
    // required entry fields — a legacy record keeps its empty fields and is
    // still flagged as "missing required fields" until it is edited.
    ensureChain(entries)
      .then((sealed) => {
        if (sealed.changed) {
          if (saveEntryList(sealed.entries)) {
            entries = sealed.entries;
          }
        }
        renderEntries();
        return runIntegrityCheck();
      })
      .catch((err) => {
        console.warn('notary log: could not seal the journal', err);
        renderEntries();
        runIntegrityCheck();
      });
  }

  // Forgetting the password must never destroy the journal. This removes the
  // password only — every entry stays exactly where it is.
  function resetLock() {
    const kept = entries.length;
    const ok = confirm(
      'Reset the journal password?\n\n' +
        'This removes the password from this browser only. All ' +
        kept +
        ' journal entr' +
        (kept === 1 ? 'y' : 'ies') +
        ' are kept and will be shown again after you set a new password.'
    );
    if (!ok) return;
    try {
      localStorage.removeItem(LOCK_KEY);
    } catch (err) {
      /* nothing to remove */
    }
    showEl(getEl('lockResetPanel'), false);
    setLockError('');
    setText(
      'lockIntro',
      'The password was removed. Your ' +
        kept +
        ' entr' +
        (kept === 1 ? 'y' : 'ies') +
        ' were not deleted. Choose a new password to open the journal.'
    );
    showLockScreen('setup');
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
      if (event.key === 'Escape') {
        if (getEl('copyModal') && getEl('copyModal').classList.contains('show')) {
          closeCopyModal();
          return;
        }
        closeModal();
      }
    });

    const addBtn = getEl('addEntryBtn');
    if (addBtn) addBtn.addEventListener('click', openAddModal);

    const exportBtn = getEl('exportBtn');
    if (exportBtn) exportBtn.addEventListener('click', exportLog);

    const exportJsonBtn = getEl('exportJsonBtn');
    if (exportJsonBtn) exportJsonBtn.addEventListener('click', exportJson);

    const backupBtn = getEl('backupBtn');
    if (backupBtn) backupBtn.addEventListener('click', exportJson);

    const integrityBtn = getEl('integrityBtn');
    if (integrityBtn) integrityBtn.addEventListener('click', runIntegrityCheck);

    const lockBtn = getEl('lockBtn');
    if (lockBtn) {
      lockBtn.addEventListener('click', () => {
        unlocked = false;
        showLockScreen('unlock');
      });
    }

    const restoreBtn = getEl('restoreBtn');
    const restoreInput = getEl('restoreFile');
    if (restoreBtn && restoreInput) restoreBtn.addEventListener('click', () => restoreInput.click());
    if (restoreInput) {
      restoreInput.addEventListener('change', () => {
        handleRestoreFile(restoreInput.files && restoreInput.files[0]);
      });
    }

    const restoreConfirmBtn = getEl('restoreConfirmBtn');
    if (restoreConfirmBtn) restoreConfirmBtn.addEventListener('click', confirmRestore);

    const restoreCancelBtn = getEl('restoreCancelBtn');
    if (restoreCancelBtn) {
      restoreCancelBtn.addEventListener('click', () => {
        showEl(getEl('restorePanel'), false);
        if (restoreConfirmBtn) restoreConfirmBtn.disabled = true;
      });
    }

    const closeBtn = getEl('closeModalBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    const cancelBtn = getEl('cancelBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

    const form = getEl('entryForm');
    if (form) form.addEventListener('submit', saveEntry);

    const search = getEl('searchInput');
    if (search) search.addEventListener('input', filterEntries);

    // Signature pad
    setupSignaturePad();
    const clearSigBtn = getEl('clearSignatureBtn');
    if (clearSigBtn) {
      clearSigBtn.addEventListener('click', () => {
        clearPad();
        const typed = getEl('signatureTyped');
        if (typed) typed.value = '';
        updateSignatureStatus();
      });
    }
    const typedSig = getEl('signatureTyped');
    if (typedSig) {
      typedSig.addEventListener('input', () => {
        if (typedSig.value.trim()) {
          clearPad();
        }
        updateSignatureStatus();
      });
    }

    // Copy modal
    const closeCopy = getEl('closeCopyBtn');
    if (closeCopy) closeCopy.addEventListener('click', closeCopyModal);
    const copyModal = getEl('copyModal');
    if (copyModal) {
      copyModal.addEventListener('click', (event) => {
        if (event.target === copyModal) closeCopyModal();
      });
    }
    const printBtn = getEl('printCopyBtn');
    if (printBtn) printBtn.addEventListener('click', printCopy);
    const copyTextBtn = getEl('copyTextBtn');
    if (copyTextBtn) copyTextBtn.addEventListener('click', copyToClipboard);

    // Lock screen
    const lockForm = getEl('lockForm');
    if (lockForm) lockForm.addEventListener('submit', handleLockSubmit);
    const forgotBtn = getEl('forgotPasswordBtn');
    if (forgotBtn) {
      forgotBtn.addEventListener('click', () => {
        showEl(getEl('lockResetPanel'), true);
        const confirmField = getEl('resetConfirm');
        if (confirmField) confirmField.focus();
      });
    }
    const resetConfirmBtn = getEl('resetLockBtn');
    if (resetConfirmBtn) resetConfirmBtn.addEventListener('click', resetLock);
    const resetCancelBtn = getEl('cancelResetBtn');
    if (resetCancelBtn) {
      resetCancelBtn.addEventListener('click', () => showEl(getEl('lockResetPanel'), false));
    }

    // The journal starts locked. On first use the notary sets a password;
    // afterwards the password is required to open the journal.
    showLockScreen(readLockRecord() ? 'unlock' : 'setup');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
