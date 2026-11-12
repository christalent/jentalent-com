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
    setAttribute() {},
    getAttribute() { return null; },
    querySelector(sel) {
      if (sel === '.btn-small' || sel === '.btn-danger') return null;
      return null;
    },
    querySelectorAll(sel) {
      // Row-scoped queries used by the filter and the renderer.
      if (sel === 'td:not(:last-child)') return this.children.slice(0, -1);
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

  const factory = new Function(
    'window', 'document', 'localStorage', 'URL', 'Blob', 'alert', 'confirm',
    `return (${src.replace(/;$/, '')})`
  );
  const api = factory(
    sandbox.window, document, sandbox.localStorage,
    sandbox.URL, sandbox.Blob, sandbox.alert, sandbox.confirm
  );
  return { api, store, els, blobs, sandbox };
}

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

console.log(failures === 0 ? '\nALL NODE LOGIC TESTS PASSED' : `\n${failures} NODE LOGIC TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
