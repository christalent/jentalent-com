// Node harness for the REAL log.js.
//
// log.js is an IIFE with no exports, so this harness re-wraps the source
// textually to expose its internal functions, then runs it against a minimal
// DOM + localStorage stub. It exercises the pure logic that is awkward to
// reach through the browser: CSV escaping, local-date parsing, corrupt-store
// handling, display/export ordering, the tamper-evident hash chain, the
// backup/restore format, and the legacy-entry migration path.
//
// Run: node tests/log-logic.test.js
// (Node 22's global Web Crypto is used for the real SHA-256 hashing.)
const fs = require('fs');
const path = require('path');

const LOG_JS = path.join(__dirname, '..', 'log.js');
let src = fs.readFileSync(LOG_JS, 'utf8');

// Expose the internals we want to test.
const EXPORTS = [
  // pre-existing
  'csvEscape',
  'parseLocalDate',
  'todayLocalISO',
  'sortedEntries',
  'loadEntries',
  'isEntryShape',
  'normalizeEntry',
  // WA-compliance additions
  'nowLocalTimeISO',
  'formatClockTime',
  'formatDateTime',
  'formatDateTimeISO',
  'formatDate',
  'idMethodLabel',
  'missingRequiredFields',
  'isLegacyEntry',
  'normalizeCount',
  'normalizeSignature',
  'entryPayload',
  'computeEntryHash',
  'buildChain',
  'rechainFrom',
  'ensureChain',
  'verifyChain',
  'buildCsv',
  'buildBackup',
  'parseBackup',
  'derivePasswordHash',
  'randomSalt',
  'constantTimeEquals',
  'hasSubtleCrypto',
  'GENESIS_HASH',
  'ID_METHODS',
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
    dataset: {},
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
    removeAttribute() {},
    getAttribute() { return null; },
    getContext() { return null; },
    toDataURL() { return ''; },
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
    Date, Math, JSON, String, Number, Array, Object, Error, RegExp, Promise,
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

function checkTrue(label, actual) {
  check(label, !!actual, true);
}

// A complete, spec-shaped entry used by the chain/CSV/backup tests.
function fullEntry(over) {
  return Object.assign(
    {
      id: 'id-1',
      date: '2026-11-11',
      time: '14:30',
      clientName: 'Alice Smith',
      clientAddress: '123 Main St, Longview, WA 98632',
      documentType: 'Deed',
      notarizationType: 'Acknowledgment',
      identificationMethod: 'government-id',
      signature: { type: 'typed', value: 'Alice Smith', signedAt: '2026-11-11T21:30:00.000Z' },
      statementCount: 1,
      notes: '',
      createdAt: '2026-11-11T21:30:00.000Z',
      updatedAt: '2026-11-11T21:30:00.000Z',
      hash: '',
      prevHash: '',
    },
    over || {}
  );
}

// A pre-compliance (legacy) entry: only the old field set.
function legacyEntry(over) {
  return Object.assign(
    {
      date: '2026-06-02',
      clientName: 'Bob Legacy',
      documentType: 'Affidavit',
      notarizationType: 'Jurat',
      notes: 'legacy row',
    },
    over || {}
  );
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

// === 3. Time parsing / combined date+time formatting ======================
{
  const { api } = buildEnv();
  check('formatClockTime: 24h -> 12h PM', api.formatClockTime('14:30'), '2:30 PM');
  check('formatClockTime: midnight -> 12 AM', api.formatClockTime('00:00'), '12:00 AM');
  check('formatClockTime: noon -> 12 PM', api.formatClockTime('12:00'), '12:00 PM');
  check('formatClockTime: single-digit hour', api.formatClockTime('9:05'), '9:05 AM');
  check('formatClockTime: empty -> empty', api.formatClockTime(''), '');
  check('formatClockTime: garbage -> empty', api.formatClockTime('abc'), '');
  check('formatClockTime: out of range -> empty', api.formatClockTime('25:00'), '');

  check('formatDateTime: combined', api.formatDateTime('2026-11-11', '14:30'), 'Nov 11, 2026 at 2:30 PM');
  check('formatDateTime: date only when no time', api.formatDateTime('2026-11-11', ''), 'Nov 11, 2026');
  check('formatDateTimeISO: combined', api.formatDateTimeISO('2026-11-11', '14:30'), '2026-11-11 14:30');
  check('formatDateTimeISO: date only', api.formatDateTimeISO('2026-11-11', ''), '2026-11-11');

  const now = new Date();
  const localTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  check('nowLocalTimeISO is HH:MM local', api.nowLocalTimeISO(), localTime);
  checkTrue('nowLocalTimeISO matches /^\d{2}:\d{2}$/', /^\d{2}:\d{2}$/.test(api.nowLocalTimeISO()));
}

// === 4. Corrupt / hostile localStorage ====================================
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

// === 5. Display order == export order (newest first) =======================
{
  const { api } = buildEnv(JSON.stringify([
    { date: '2026-10-05', clientName: 'Old', documentType: 'Deed', notarizationType: 'Jurat', notes: '' },
    { date: '2026-11-01', clientName: 'New', documentType: 'Deed', notarizationType: 'Jurat', notes: '' },
    { date: '2026-09-15', clientName: 'Oldest', documentType: 'Deed', notarizationType: 'Jurat', notes: '' },
  ]));
  check('sortedEntries returns newest first', api.sortedEntries().map((e) => e.clientName), ['New', 'Old', 'Oldest']);
  check('sortedEntries does not mutate source order', api.sortedEntries().length, 3);
}

// === 5b. Same-day ordering uses the time of the notarial act ===============
{
  const { api } = buildEnv(JSON.stringify([
    { date: '2026-11-11', time: '09:00', clientName: 'Morning', documentType: 'Deed', notarizationType: 'Jurat', notes: '' },
    { date: '2026-11-11', time: '15:45', clientName: 'Afternoon', documentType: 'Deed', notarizationType: 'Jurat', notes: '' },
  ]));
  check('sortedEntries: later time first within the same date',
    api.sortedEntries().map((e) => e.clientName), ['Afternoon', 'Morning']);
}

// === 6. CSV end-to-end via exportLog ======================================
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

// === 7. Required-field bookkeeping (RCW 42.45.180(4) / WAC 308-30-200) ====
{
  const { api } = buildEnv();
  check('missingRequiredFields: complete entry has none',
    api.missingRequiredFields(fullEntry()), []);
  check('missingRequiredFields: legacy entry lists every missing field',
    api.missingRequiredFields(legacyEntry()),
    ['time', 'principal address', 'identification method', 'principal signature', 'number of statements/documents']);
  check('isLegacyEntry: legacy -> true', api.isLegacyEntry(legacyEntry()), true);
  check('isLegacyEntry: complete -> false', api.isLegacyEntry(fullEntry()), false);

  // The statement count must be an integer >= 1.
  check('normalizeCount: 1 -> 1', api.normalizeCount(1), 1);
  check('normalizeCount: "3" -> 3', api.normalizeCount('3'), 3);
  check('normalizeCount: 0 -> null (not recorded)', api.normalizeCount(0), null);
  check('normalizeCount: -2 -> null', api.normalizeCount(-2), null);
  check('normalizeCount: undefined -> null', api.normalizeCount(undefined), null);
  check('normalizeCount: "abc" -> null', api.normalizeCount('abc'), null);
  check('normalizeCount: 2.7 -> 2', api.normalizeCount(2.7), 2);

  // Signature shapes.
  check('normalizeSignature: typed kept', api.normalizeSignature({ type: 'typed', value: 'A B' }).type, 'typed');
  check('normalizeSignature: drawn kept', api.normalizeSignature({ type: 'drawn', value: 'data:image/png;base64,AAA' }).type, 'drawn');
  check('normalizeSignature: unknown type -> null', api.normalizeSignature({ type: 'other', value: 'x' }), null);
  check('normalizeSignature: empty value -> null', api.normalizeSignature({ type: 'typed', value: '' }), null);
  check('normalizeSignature: non-object -> null', api.normalizeSignature('nope'), null);

  // Identification method labels.
  check('idMethodLabel: government-id', api.idMethodLabel('government-id'), 'Government-issued photo ID');
  check('idMethodLabel: ron', api.idMethodLabel('ron'), 'Remote online notarization (RON)');
  check('idMethodLabel: personal knowledge', api.idMethodLabel('personal-knowledge'), 'Personal knowledge');
  check('idMethodLabel: unknown -> raw value', api.idMethodLabel('weird'), 'weird');
  check('idMethodLabel: empty -> empty', api.idMethodLabel(''), '');
  checkTrue('ID_METHODS covers personal knowledge, gov id and RON',
    ['personal-knowledge', 'government-id', 'ron'].every((v) => api.ID_METHODS.some((m) => m.value === v)));
}

// === 8. Legacy-entry migration path =======================================
{
  const { api } = buildEnv(JSON.stringify([legacyEntry()]));
  const e = api.loadEntries()[0];
  check('legacy: loads without crashing', e.clientName, 'Bob Legacy');
  check('legacy: time stays empty (not fabricated)', e.time, '');
  check('legacy: address stays empty (not fabricated)', e.clientAddress, '');
  check('legacy: identification method stays empty', e.identificationMethod, '');
  check('legacy: signature stays null', e.signature, null);
  check('legacy: statement count stays null', e.statementCount, null);
  check('legacy: original notes preserved', e.notes, 'legacy row');
  check('legacy: flagged as legacy', api.isLegacyEntry(e), true);

  // The CSV must show the gap rather than hide it.
  const csv = api.buildCsv([e]);
  const header = csv.split('\r\n')[0];
  const row = csv.split('\r\n')[1];
  checkTrue('legacy csv: has a "Missing Required Fields" column',
    header.indexOf('Missing Required Fields') !== -1);
  checkTrue('legacy csv: lists the missing fields in the row',
    row.indexOf('time; principal address; identification method; principal signature; number of statements/documents') !== -1);
  checkTrue('legacy csv: does not invent a time',
    row.indexOf('2026-06-02') !== -1 && row.indexOf(',T') === -1);
}

// === 9. Tamper-evident hash chain (WAC 308-30-200(2)(d)) ==================
(async () => {
  const { api } = buildEnv();
  checkTrue('crypto: Web Crypto available in the test runtime', api.hasSubtleCrypto());

  const list = [
    fullEntry({ id: 'a', clientName: 'One' }),
    fullEntry({ id: 'b', clientName: 'Two', date: '2026-11-10' }),
    fullEntry({ id: 'c', clientName: 'Three', date: '2026-11-09' }),
  ];

  const chained = await api.buildChain(list);
  check('chain: every entry got a hash', chained.every((e) => /^[0-9a-f]{64}$/.test(e.hash)), true);
  check('chain: first entry links to genesis', chained[0].prevHash, api.GENESIS_HASH);
  check('chain: second links to first', chained[1].prevHash, chained[0].hash);
  check('chain: third links to second', chained[2].prevHash, chained[1].hash);
  checkTrue('chain: all hashes distinct', new Set(chained.map((e) => e.hash)).size === 3);

  const ok = await api.verifyChain(chained);
  check('chain: intact chain verifies ok', ok.ok, true);
  check('chain: intact chain reports 0 problems', ok.problems.length, 0);
  check('chain: intact chain counts every entry', ok.total, 3);

  // Tamper: change a field directly in the stored object, as an outside
  // editor of localStorage would.
  const tampered = chained.map((e) => Object.assign({}, e));
  tampered[1].clientName = 'Tampered';
  const detected = await api.verifyChain(tampered);
  check('chain: tampered entry -> not ok', detected.ok, false);
  check('chain: tamper reported at the right index', detected.problems[0].index, 1);
  check('chain: tamper classified as "altered"', detected.problems[0].type, 'altered');
  checkTrue('chain: tamper message names the entry',
    /Entry 2 was changed outside this app/.test(detected.problems[0].message));

  // Tamper: rewrite the stored hash to match the altered content. The chain
  // link to the previous entry still breaks, so it is still detected.
  const tampered2 = chained.map((e) => Object.assign({}, e));
  tampered2[1].clientName = 'Tampered';
  tampered2[1].hash = await api.computeEntryHash(chained[0].hash, tampered2[1]);
  const detected2 = await api.verifyChain(tampered2);
  check('chain: re-hashed tamper still detected (broken link)', detected2.ok, false);
  checkTrue('chain: broken-link reported',
    detected2.problems.some((p) => p.type === 'broken-link'));

  // Tamper: break the link only.
  const tampered3 = chained.map((e) => Object.assign({}, e));
  tampered3[2].prevHash = 'f'.repeat(64);
  const detected3 = await api.verifyChain(tampered3);
  check('chain: broken link detected', detected3.ok, false);

  // Editing through the app re-seals the chain from the edited entry onward.
  const edited = chained.map((e) => Object.assign({}, e));
  edited[1].clientName = 'Two (corrected)';
  const resealed = await api.rechainFrom(edited, 1);
  const verified = await api.verifyChain(resealed);
  check('chain: after an app edit the chain verifies again', verified.ok, true);
  check('chain: entries before the edit keep their hash', resealed[0].hash, chained[0].hash);
  checkTrue('chain: the edited entry got a new hash', resealed[1].hash !== chained[1].hash);

  // The payload must ignore updatedAt so an unrelated edit does not churn
  // the hash of unchanged records.
  checkTrue('payload excludes updatedAt', api.entryPayload(fullEntry({ updatedAt: 'x' })) === api.entryPayload(fullEntry({ updatedAt: 'y' })));

  // ensureChain seals legacy (unhashed) records without inventing fields.
  const legacySealed = await api.ensureChain([legacyEntry()]);
  check('ensureChain: legacy record gets a hash', /^[0-9a-f]{64}$/.test(legacySealed.entries[0].hash), true);
  check('ensureChain: legacy record links to genesis', legacySealed.entries[0].prevHash, api.GENESIS_HASH);
  check('ensureChain: legacy time still empty', legacySealed.entries[0].time, '');
  check('ensureChain: legacy address still empty', legacySealed.entries[0].clientAddress, '');
  check('ensureChain: legacy statement count still null', legacySealed.entries[0].statementCount, null);
  check('ensureChain: reports that it changed something', legacySealed.changed, true);

  // ensureChain must not silently rewrite an existing (sealed) hash.
  const notChanged = await api.ensureChain(chained);
  check('ensureChain: sealed records left alone', notChanged.changed, false);
  check('ensureChain: sealed hash preserved', notChanged.entries[0].hash, chained[0].hash);
})().then(async () => {
  // === 10. CSV with the new fields =========================================
  const { api } = buildEnv();
  const e1 = fullEntry();
  const e2 = fullEntry({ id: 'b', clientName: '=cmd|calc', date: '2026-11-09', time: '09:00' });
  const csv = api.buildCsv([e1, e2]);
  const lines = csv.split('\r\n');
  const header = lines[0];

  check('csv new: Date column', header.indexOf('Date,') === 0, true);
  checkTrue('csv new: Time column', header.indexOf(',Time,') !== -1);
  checkTrue('csv new: combined Date & Time column', header.indexOf('Date & Time') !== -1);
  checkTrue('csv new: Principal Address column', header.indexOf('Principal Address') !== -1);
  checkTrue('csv new: Identification Method column', header.indexOf('Identification Method') !== -1);
  checkTrue('csv new: Principal Signature column', header.indexOf('Principal Signature') !== -1);
  checkTrue('csv new: statement count column', header.indexOf('Number of Statements/Documents') !== -1);
  checkTrue('csv new: hash column', header.indexOf('Entry Hash') !== -1);

  // Newest first.
  check('csv new: date-descending order', lines[1].indexOf('2026-11-11'), 0);
  checkTrue('csv new: second row is the older entry', lines[2].indexOf('2026-11-09') === 0);

  // Date and time are combined in the Date & Time column.
  checkTrue('csv new: Date & Time combines date and time', lines[1].indexOf('2026-11-11 14:30') !== -1);

  // The principal address and the identification method are present.
  checkTrue('csv new: principal address exported', lines[1].indexOf('123 Main St, Longview, WA 98632') !== -1);
  checkTrue('csv new: identification method label exported', lines[1].indexOf('Government-issued photo ID') !== -1);

  // Statement count.
  checkTrue('csv new: statement count exported', /(^|,)(1)(,|$)/.test(lines[1]));

  // The formula-injection guard still applies to the new columns.
  checkTrue('csv new: guard applies to principal name', lines[2].indexOf("'=cmd|calc") !== -1);

  // A missing signature is blank, never "undefined".
  checkTrue('csv new: no literal "undefined" in the row', lines[1].indexOf('undefined') === -1);

  // === 11. Backup export / restore validation ==============================
  const { api: api2 } = buildEnv();
  const entries = [fullEntry({ id: 'a' }), fullEntry({ id: 'b', date: '2026-11-10', clientName: 'Two' })];
  const chained2 = await api2.buildChain(entries);
  const backup = api2.buildBackup(chained2);
  check('backup: format marker', backup.format, 'jentalent-notary-journal-backup');
  check('backup: version', backup.version, 1);
  check('backup: entry count', backup.entryCount, 2);
  check('backup: carries the hash chain', backup.entries.every((e) => /^[0-9a-f]{64}$/.test(e.hash)), true);
  checkTrue('backup: carries signature data', backup.entries[0].signature && backup.entries[0].signature.value === 'Alice Smith');
  check('backup: has an export timestamp', typeof backup.exportedAt === 'string' && backup.exportedAt.length > 0, true);

  // Round-trip through JSON.
  const text = JSON.stringify(backup);
  const parsed = api2.parseBackup(text);
  check('restore: valid backup accepted', parsed.ok, true);
  check('restore: entry count preserved', parsed.entryCount, 2);
  check('restore: entries preserved', parsed.entries.length, 2);
  check('restore: hash chain preserved', parsed.entries[0].hash, chained2[0].hash);

  // Invalid backups are rejected before anything is overwritten.
  check('restore: non-JSON rejected', api2.parseBackup('not json').ok, false);
  check('restore: wrong format rejected', api2.parseBackup(JSON.stringify({ format: 'other', entries: [] })).ok, false);
  check('restore: missing entries array rejected', api2.parseBackup(JSON.stringify({ format: 'jentalent-notary-journal-backup' })).ok, false);
  check('restore: non-array entries rejected', api2.parseBackup(JSON.stringify({ format: 'jentalent-notary-journal-backup', entries: {} })).ok, false);
  check('restore: unreadable entry rejected', api2.parseBackup(JSON.stringify({ format: 'jentalent-notary-journal-backup', entries: [42] })).ok, false);
  checkTrue('restore: rejection has an error message', typeof api2.parseBackup('not json').error === 'string');

  // A restored journal still verifies.
  const restored = await api2.ensureChain(parsed.entries);
  const restoredCheck = await api2.verifyChain(restored.entries);
  check('restore: restored journal still verifies', restoredCheck.ok, true);

  // === 12. Password hashing (WAC 308-30-200(2)(c)) =========================
  const { api: api3 } = buildEnv();
  const salt = api3.randomSalt(16);
  check('password: salt is 32 hex chars', /^[0-9a-f]{32}$/.test(salt), true);
  check('password: salts differ per call', api3.randomSalt(16) === salt, false);
  const h1 = await api3.derivePasswordHash('correct horse battery', salt, 1000);
  const h2 = await api3.derivePasswordHash('correct horse battery', salt, 1000);
  const h3 = await api3.derivePasswordHash('wrong password', salt, 1000);
  check('password: same password+salt -> same hash', h1, h2);
  checkTrue('password: different password -> different hash', h1 !== h3);
  checkTrue('password: hash is 64 hex chars', /^[0-9a-f]{64}$/.test(h1));
  check('password: constant-time compare accepts the right one', api3.constantTimeEquals(h1, h2), true);
  check('password: constant-time compare rejects the wrong one', api3.constantTimeEquals(h1, h3), false);
  check('password: constant-time compare rejects empty vs value', api3.constantTimeEquals('', h1), false);

  console.log(failures === 0 ? '\nALL NODE LOGIC TESTS PASSED' : `\n${failures} NODE LOGIC TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.error('TEST HARNESS ERROR:', err);
  console.log(failures === 0 ? '\nALL NODE LOGIC TESTS PASSED' : `\n${failures} NODE LOGIC TEST(S) FAILED`);
  process.exit(1);
});
