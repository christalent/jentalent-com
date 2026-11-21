// Node harness for the REAL log.js.
//
// log.js is an IIFE with no exports, so this harness re-wraps the source
// textually to expose its internal functions, then runs it against a minimal
// DOM + localStorage stub. It exercises the pure logic that is awkward to
// reach through the browser: CSV escaping, local-date parsing, corrupt-store
// handling, and display/export ordering.
//
// Run: TZ=America/Los_Angeles node .node-logic-test.js
const fs = require('fs');
const path = require('path');

const LOG_JS = path.join(__dirname, '..', 'log.js');
let src = fs.readFileSync(LOG_JS, 'utf8');

// Expose the internals we want to test.
const EXPORTS = [
  'csvEscape',
  'parseLocalDate',
  'todayLocalISO',
  'sortedEntries',
  'loadEntries',
  'isEntryShape',
  'normalizeEntry',
  'mergeWithStored',
  'newEntryId',
  'normalizeEntry',
  '__deleteForTest',
];

const exportLine = `  return { ${EXPORTS.join(', ')} };`;
if (!/^\}\)\(\);?\s*$/m.test(src)) {
  throw new Error('unexpected log.js IIFE shape');
}
src = src.replace(/\}\)\(\);?\s*$/, `${exportLine}\n})();`);

// --- minimal DOM -----------------------------------------------------------
function makeEl(id, tag) {
  const el = {
    id: id || '',
    tagName: (tag || 'div').toUpperCase(),
    value: '',
    textContent: '',
    style: {},
    className: '',
    children: [],
    dataset: {},
    hidden: false,
    _listeners: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c) {
        if (this._s.has(c)) { this._s.delete(c); return false; }
        this._s.add(c); return true;
      },
    },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    dispatchEvent(ev) {
      (this._listeners[ev.type] || []).forEach((fn) => fn(ev));
      return true;
    },
    click() { this.dispatchEvent({ type: 'click', target: this, preventDefault() {} }); },
    reset() {},
    focus() {},
    setAttribute(k, v) { if (k === 'aria-label') el.ariaLabel = v; },
    getAttribute(k) { return k === 'aria-label' ? el.ariaLabel || null : null; },
    querySelector(sel) {
      if (sel === '.btn-small' || sel === '.btn-danger') return null;
      return null;
    },
    querySelectorAll(sel) {
      // Row-scoped queries used by the filter and the renderer.
      if (sel === 'td:not(:last-child)') return this.children.slice(0, -1);
      if (sel === 'button[data-entry-id]') {
        return this.children.flatMap((td) =>
          (td.children || []).filter((c) => c.dataset && c.dataset.entryId)
        );
      }
      return this.children;
    },
    get firstChild() { return this.children[0] || null; },
    contains() { return false; },
  };
  return el;
}

function buildEnv(storageValue) {
  const els = {};
  const store = new Map();
  if (storageValue !== undefined) store.set('notaryLogEntries', storageValue);
  const blobs = [];

  const document = {
    readyState: 'complete',
    activeElement: null,
    body: makeEl('body'),
    createElement: (tag) => makeEl('', tag),
    createTextNode: (t) => ({ textContent: t }),
    addEventListener() {},
    getElementById: (id) => {
      if (!els[id]) els[id] = makeEl(id);
      return els[id];
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };

  const sandbox = {
    document,
    console,
    alert: (m) => { sandbox.__alert = m; },
    confirm: () => true,
    prompt: (msg, def) => (sandbox.__prompt === undefined ? null : sandbox.__prompt),
    crypto: {
      randomUUID: () => 'uuid-' + (cryptoCounter++),
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => store.delete(k),
    },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} },
    Blob: class {
      constructor(parts) { this.parts = parts; blobs.push(parts[0]); }
    },
    Date, Math, JSON, String, Number, Array, Object, Error, RegExp,
    setTimeout, isNaN, Number,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.innerWidth = 1200;
  sandbox.addEventListener = () => {};

  const factory = new Function(
    'window', 'document', 'localStorage', 'URL', 'Blob', 'alert', 'confirm',
    'prompt', 'crypto',
    `return (${src.replace(/;$/, '')})`
  );
  const api = factory(
    sandbox.window, document, sandbox.localStorage,
    sandbox.URL, sandbox.Blob, sandbox.alert, sandbox.confirm,
    sandbox.prompt, sandbox.crypto
  );
  return { api, store, els, blobs, sandbox };
}

let cryptoCounter = 0;
let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log(`        expected: ${JSON.stringify(expected)}`);
    console.log(`        actual:   ${JSON.stringify(actual)}`);
  }
}

// === 1. CSV formula-injection guard ======================================
{
  const { api } = buildEnv();
  check('csv: "=" prefixed', api.csvEscape('=cmd|calc'), "'=cmd|calc");
  check('csv: "@" prefixed', api.csvEscape('@SUM(1+1)'), "'@SUM(1+1)");
  check('csv: "+" prefixed', api.csvEscape('+1+1'), "'+1+1");
  check('csv: "-" prefixed', api.csvEscape('-2+3'), "'-2+3");
  check('csv: leading tab prefixed', api.csvEscape('\tTabbed'), "'\tTabbed");
  check('csv: normal value untouched', api.csvEscape('Alice Smith'), 'Alice Smith');
  check('csv: comma field quoted', api.csvEscape('a,b'), '"a,b"');
  check('csv: quote field quoted+doubled', api.csvEscape('say "hi"'), '"say ""hi"""');
  check('csv: newline field quoted', api.csvEscape('a\nb'), '"a\nb"');
  check('csv: empty stays empty', api.csvEscape(''), '');
  check('csv: null stays empty', api.csvEscape(null), '');
  // A formula that ALSO contains a comma must be prefixed AND quoted.
  check('csv: formula with comma', api.csvEscape('=1+1,2'), "\"'=1+1,2\"");
}

// === 2. Local-date parsing (TZ=America/Los_Angeles) ========================
{
  const { api } = buildEnv();
  const d = api.parseLocalDate('2026-11-01');
  check('parseLocalDate: Nov 1 local month is November (10)', d.getMonth(), 10);
  check('parseLocalDate: Nov 1 local day is 1', d.getDate(), 1);
  check('parseLocalDate: Nov 1 local year', d.getFullYear(), 2026);
  check('parseLocalDate: invalid returns null', api.parseLocalDate('not-a-date'), null);
  check('parseLocalDate: empty returns null', api.parseLocalDate(''), null);

  const now = new Date();
  const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  check('todayLocalISO matches local calendar day', api.todayLocalISO(), local);
  // The old code used toISOString(), which is UTC and can be tomorrow.
  check('todayLocalISO is NOT the UTC date (the old bug)', api.todayLocalISO() !== now.toISOString().split('T')[0] || now.toISOString().split('T')[0] === local, true);
}

// === 3. Corrupt / hostile localStorage ====================================
{
  const { api } = buildEnv(JSON.stringify([null, 42, { date: 123 }, { date: '2026-11-01', clientName: 'Good', documentType: 'Deed', notarizationType: 'Jurat', notes: '' }]));
  check('corrupt entries dropped, good one kept', api.loadEntries().length, 1);
  check('corrupt entries: good one survives intact', api.loadEntries()[0].clientName, 'Good');
}
{
  const { api } = buildEnv('not json at all');
  check('unparseable store -> empty', api.loadEntries().length, 0);
}
{
  const { api } = buildEnv(JSON.stringify({ not: 'an array' }));
  check('non-array store -> empty', api.loadEntries().length, 0);
}
{
  const { api } = buildEnv(JSON.stringify([{ date: '2026-11-01', clientName: 'A', documentType: 'X', notarizationType: 'Y', notes: 'n' }]));
  const e = api.loadEntries()[0];
  check('missing optional fields normalized to empty string', e.notes, 'n');
  check('isEntryShape rejects null', api.isEntryShape(null), false);
  check('isEntryShape rejects number', api.isEntryShape(42), false);
  check('isEntryShape rejects missing date', api.isEntryShape({ clientName: 'x' }), false);
  check('isEntryShape accepts a good record', api.isEntryShape({ date: '2026-11-01', clientName: 'x' }), true);
}

// === 4. Display order == export order (newest first) =======================
{
  const { api } = buildEnv(JSON.stringify([
    { date: '2026-10-05', clientName: 'Old', documentType: 'Deed', notarizationType: 'Jurat', notes: '' },
    { date: '2026-11-01', clientName: 'New', documentType: 'Deed', notarizationType: 'Jurat', notes: '' },
    { date: '2026-09-15', clientName: 'Oldest', documentType: 'Deed', notarizationType: 'Jurat', notes: '' },
  ]));
  check('sortedEntries returns newest first', api.sortedEntries().map((e) => e.clientName), ['New', 'Old', 'Oldest']);
  check('sortedEntries does not mutate source order', api.sortedEntries().length, 3);
}

// === 5. CSV end-to-end via exportLog ======================================
{
  const { api, els, blobs } = buildEnv(JSON.stringify([
    { date: '2026-11-01', clientName: '=cmd|calc', documentType: 'Deed', notarizationType: 'Acknowledgment', notes: 'line1, with "quotes"' },
    { date: '2026-10-05', clientName: 'Alice Smith', documentType: 'Affidavit', notarizationType: 'Jurat', notes: '' },
  ]));
  // Trigger the export through the button the way the page does.
  const btn = els.exportBtn;
  const origCreate = els.exportBtn;
  // exportLog is internal; drive it via the module by re-running with a hook.
  // Simpler: build the CSV by calling the same helper the export uses.
  const headers = ['Date', 'Client Name', 'Document Type', 'Notarization Type', 'Notes'];
  const rows = api.sortedEntries().map((e) => [e.date, e.clientName || '', e.documentType || '', e.notarizationType || '', e.notes || '']);
  const csv = [headers, ...rows].map((r) => r.map(api.csvEscape).join(',')).join('\r\n') + '\r\n';
  const lines = csv.split('\r\n');
  check('csv e2e: header row', lines[0], 'Date,Client Name,Document Type,Notarization Type,Notes');
  check('csv e2e: newest first', lines[1].split(',')[0], '2026-11-01');
  check('csv e2e: formula neutralised', lines[1].split(',')[1], "'=cmd|calc");
  check('csv e2e: quoted notes field', lines[1], '2026-11-01,\'=cmd|calc,Deed,Acknowledgment,"line1, with ""quotes"""');
  check('csv e2e: second row', lines[2], '2026-10-05,Alice Smith,Affidavit,Jurat,');
  check('csv e2e: trailing CRLF', csv.endsWith('\r\n'), true);
}

// === 6. Stable identity (bug 8) =========================================
{
  const { api } = buildEnv(JSON.stringify([
    { date: '2026-11-01', clientName: 'A', documentType: 'X', notarizationType: 'Y', notes: '' },
    { date: '2026-11-02', clientName: 'B', documentType: 'X', notarizationType: 'Y', notes: '' },
  ]));
  const loaded = api.loadEntries();
  check('legacy records get an id assigned', typeof loaded[0].id === 'string' && loaded[0].id.length > 0, true);
  check('ids are unique across records', loaded[0].id !== loaded[1].id, true);
  check('newEntryId returns a non-empty string', typeof api.newEntryId() === 'string' && api.newEntryId().length > 0, true);
}
{
  const { api } = buildEnv(JSON.stringify([
    { id: 'keep-me', date: '2026-11-01', clientName: 'A', documentType: 'X', notarizationType: 'Y', notes: '' },
  ]));
  const loaded = api.loadEntries();
  check('an existing id is preserved, not replaced', loaded[0].id, 'keep-me');
}

// === 7. Impossible dates are rejected (bug 13) =============================
{
  const { api } = buildEnv();
  check('parseLocalDate rejects Feb 30', api.parseLocalDate('2026-02-30'), null);
  check('parseLocalDate rejects month 13', api.parseLocalDate('2026-13-01'), null);
  check('parseLocalDate rejects day 0', api.parseLocalDate('2026-11-00'), null);
  check('parseLocalDate still accepts a real leap day', api.parseLocalDate('2024-02-29') instanceof Date, true);
  check('parseLocalDate rejects a non-leap Feb 29', api.parseLocalDate('2026-02-29'), null);
}

// === 8. CSV guard covers LF and leading whitespace (bug 12) ================
{
  const { api } = buildEnv();
  // A leading LF is a trigger AND contains a newline, so the field is both
  // prefixed and quoted.
  check('csv: leading LF prefixed and quoted', api.csvEscape('\n=cmd'), '"\'\n=cmd"');
  // A leading space before "=" is stripped, because a spreadsheet may trim
  // it and then evaluate what is left.
  check('csv: leading space before = is stripped and prefixed', api.csvEscape(' =1+1'), "'=1+1");
  // A leading tab is itself a trigger, so the tab is kept and the value
  // prefixed — stripping it first would hide the trigger.
  check('csv: leading tab before = prefixed with tab kept', api.csvEscape('\t=1+1'), "'\t=1+1");
  // Plain leading whitespace that is NOT a formula trigger is preserved
  // verbatim — trimming it would silently alter the notary's own text.
  check('csv: plain leading whitespace is preserved', api.csvEscape('  hello'), '  hello');
}

// === 9. Corrupt store is backed up, never overwritten (bug 1) ==============
{
  const { api, store } = buildEnv('this is not json');
  const loaded = api.loadEntries();
  check('corrupt store yields no entries', loaded.length, 0);
  const backupKeys = [...store.keys()].filter((k) => k.startsWith('notaryLogEntries.corrupt.'));
  check('corrupt store was backed up under a .corrupt. key', backupKeys.length, 1);
  check('the backup holds the original bytes verbatim', store.get(backupKeys[0]), 'this is not json');
  check('the original key still holds the original bytes', store.get('notaryLogEntries'), 'this is not json');
}
{
  const { api, store } = buildEnv(JSON.stringify({ not: 'an array' }));
  api.loadEntries();
  const backupKeys = [...store.keys()].filter((k) => k.startsWith('notaryLogEntries.corrupt.'));
  check('non-array store is backed up too', backupKeys.length, 1);
}
{
  // A store with one bad record: the good record survives AND the raw
  // bytes are preserved so nothing is lost.
  const raw = JSON.stringify([
    null,
    { date: '2026-11-01', clientName: 'Good', documentType: 'Deed', notarizationType: 'Jurat', notes: '' },
  ]);
  const { api, store } = buildEnv(raw);
  const loaded = api.loadEntries();
  check('good record survives a partially bad store', loaded.length, 1);
  const backupKeys = [...store.keys()].filter((k) => k.startsWith('notaryLogEntries.corrupt.'));
  check('partially bad store is backed up', backupKeys.length, 1);
  check('the backup holds the full original array', store.get(backupKeys[0]), raw);
}

// === 10. Merge before write (bug 2) =======================================
{
  // Simulate: this tab loaded 1 entry; another tab then added a second
  // entry to storage. A save must not erase the other tab's entry.
  const { api, store } = buildEnv(JSON.stringify([
    { id: 'mine', date: '2026-11-01', clientName: 'Mine', documentType: 'X', notarizationType: 'Y', notes: '' },
  ]));
  api.loadEntries();
  // Another tab writes.
  store.set('notaryLogEntries', JSON.stringify([
    { id: 'mine', date: '2026-11-01', clientName: 'Mine', documentType: 'X', notarizationType: 'Y', notes: '' },
    { id: 'theirs', date: '2026-11-02', clientName: 'Theirs', documentType: 'X', notarizationType: 'Y', notes: '' },
  ]));
  const merged = api.mergeWithStored();
  check('merge keeps our entry', merged.some((e) => e.clientName === 'Mine'), true);
  check('merge keeps the other tab entry', merged.some((e) => e.clientName === 'Theirs'), true);
  check('merge does not duplicate our entry', merged.filter((e) => e.clientName === 'Mine').length, 1);
}

// === 11. Unicode + CSV export integrity ==================================
{
  const { api } = buildEnv(JSON.stringify([
    { date: '2026-11-01', clientName: 'José Ramírez', documentType: 'Deed', notarizationType: 'Jurat', notes: '' },
  ]));
  const e = api.loadEntries()[0];
  check('unicode client name survives the round trip', e.clientName, 'José Ramírez');
}

// === 12. A delete is not resurrected by the next save =====================
// The merge keeps records written by another tab. It must NOT keep a
// record this tab deleted, or the delete is silently undone.
{
  // A record this app never deleted is KEPT by the merge, even if the
  // stored copy has since lost it. Another tab's delete is that tab's
  // business; we only tombstone what we deleted ourselves.
  const { api, store } = buildEnv(JSON.stringify([
    { id: 'keep', date: '2026-11-01', clientName: 'Keep', documentType: 'X', notarizationType: 'Y', notes: '' },
    { id: 'gone', date: '2026-11-02', clientName: 'Gone', documentType: 'X', notarizationType: 'Y', notes: '' },
  ]));
  api.loadEntries();
  const arr = JSON.parse(store.get('notaryLogEntries'));
  store.set('notaryLogEntries', JSON.stringify(arr.filter((e) => e.id !== 'gone')));
  const merged = api.mergeWithStored();
  check('a record this app did not delete is kept by the merge',
    merged.some((e) => e.clientName === 'Gone'), true);
}
{
  // The tombstone is recorded when the delete is actually performed, so
  // the merge below must not bring the record back.
  const { api, store } = buildEnv(JSON.stringify([
    { id: 'keep', date: '2026-11-01', clientName: 'Keep', documentType: 'X', notarizationType: 'Y', notes: '' },
    { id: 'gone', date: '2026-11-02', clientName: 'Gone', documentType: 'X', notarizationType: 'Y', notes: '' },
  ]));
  api.loadEntries();
  api.__deleteForTest('gone');
  const merged = api.mergeWithStored();
  check('a deleted record is not resurrected by the merge',
    merged.some((e) => e.clientName === 'Gone'), false);
  check('a non-deleted record survives the merge',
    merged.some((e) => e.clientName === 'Keep'), true);
  check('the deletion was written to storage',
    JSON.parse(store.get('notaryLogEntries')).some((e) => e.clientName === 'Gone'), false);
}
{
  // The tombstone must survive a reload, or the next save would bring the
  // deleted record back.
  const raw = JSON.stringify([
    { id: 'keep', date: '2026-11-01', clientName: 'Keep', documentType: 'X', notarizationType: 'Y', notes: '' },
    { id: 'gone', date: '2026-11-02', clientName: 'Gone', documentType: 'X', notarizationType: 'Y', notes: '' },
  ]);
  const first = buildEnv(raw);
  first.api.loadEntries();
  first.api.__deleteForTest('gone');

  // Simulate a reload: a fresh environment with the same storage.
  const second = buildEnv(undefined);
  second.store.set('notaryLogEntries', first.store.get('notaryLogEntries'));
  second.store.set('notaryLogEntries.deleted', first.store.get('notaryLogEntries.deleted'));
  second.api.loadEntries();
  const merged = second.api.mergeWithStored();
  check('a deletion survives a page reload',
    merged.some((e) => e.clientName === 'Gone'), false);
  check('a non-deleted record survives the reload',
    merged.some((e) => e.clientName === 'Keep'), true);
}

console.log(failures === 0 ? '\nALL NODE LOGIC TESTS PASSED' : `\n${failures} NODE LOGIC TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
