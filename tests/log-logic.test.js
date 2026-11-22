// Test harness for the server-backed notary log.
//
// Two layers:
//
//   1. Unit tests — the pure logic in log.js that is awkward to reach
//      through the browser: CSV escaping, local-date parsing, the "Other"
//      document-type label, and the CSV shape the export builds.
//
//   2. API integration tests — a live round-trip against api.php. These
//      require the endpoint to be reachable and a PIN to be configured, and
//      are skipped (not failed) when it is not.
//
// Run: TZ=America/Los_Angeles node tests/log-logic.test.js
//
//      API_URL=https://www.jentalent.com/api.php API_PIN=884000 \
//        TZ=America/Los_Angeles node tests/log-logic.test.js
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
  'documentTypeLabel',
  'identificationLabel',
];

const exportLine = `  return { ${EXPORTS.join(', ')} };`;
if (!/\}\)\(\);?\s*$/m.test(src)) {
  throw new Error('unexpected log.js IIFE shape');
}
src = src.replace(/\}\)\(\);?\s*$/, `${exportLine}\n})();`);

// --- minimal DOM -----------------------------------------------------------
function makeEl(id, tag) {
  const el = {
    id: id || '',
    tagName: (tag || 'div').toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    attrs: {},
    className: '',
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    offsetParent: {},
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
    get firstChild() { return this.children[0] || null; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    dispatchEvent(ev) {
      (this._listeners[ev.type] || []).forEach((fn) => fn(ev));
      return true;
    },
    click() { this.dispatchEvent({ type: 'click', target: this, preventDefault() {} }); },
    reset() { this.value = ''; },
    focus() { if (this._ownerDocument) this._ownerDocument.activeElement = this; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    removeAttribute(k) { delete this.attrs[k]; },
    querySelector() { return null; },
    querySelectorAll(sel) {
      if (sel === 'td:not(:last-child)') return this.children.slice(0, -1);
      if (sel === 'button[data-entry-id]') {
        return this.children.flatMap((td) =>
          (td.children || []).filter((c) => c.dataset && c.dataset.entryId)
        );
      }
      return this.children;
    },
    contains() { return false; },
  };
  return el;
}

let cryptoCounter = 0;

function buildEnv() {
  const els = {};
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
    crypto: { randomUUID: () => 'uuid-' + (cryptoCounter++) },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} },
    Blob: class {
      constructor(parts) { this.parts = parts; blobs.push(parts[0]); }
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, authenticated: false, entries: [] }),
    }),
    FormData: class {
      constructor() { this.data = {}; }
      append(k, v) { this.data[k] = v; }
    },
    Date, Math, JSON, String, Number, Array, Object, Error, RegExp,
    setTimeout, isNaN, Promise,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.location = { protocol: 'https:' };
  sandbox.addEventListener = () => {};

  // Wire every element to the stub document so focus() can update
  // document.activeElement without relying on a global.
  for (const key of Object.keys(els)) els[key]._ownerDocument = document;
  const origCreate = document.createElement;
  document.createElement = (tag) => {
    const el = origCreate(tag);
    el._ownerDocument = document;
    return el;
  };

  const factory = new Function(
    'window', 'document', 'URL', 'Blob', 'fetch', 'FormData',
    `return (${src.replace(/;$/, '')})`
  );
  const api = factory(
    sandbox.window, document, sandbox.URL, sandbox.Blob,
    sandbox.fetch, sandbox.FormData
  );
  return { api, els, blobs, sandbox };
}

let failures = 0;
let passed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
  } else {
    failures++;
    console.log(`FAIL  ${label}`);
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
  check('csv: leading CR prefixed', api.csvEscape('\r=1+1'), '"\'\r=1+1"');
  check('csv: leading LF prefixed', api.csvEscape('\n=1+1'), '"\'\n=1+1"');
  check('csv: spaces then formula prefixed', api.csvEscape('  =1+1'), "'=1+1");
  check('csv: normal value untouched', api.csvEscape('Alice Smith'), 'Alice Smith');
  check('csv: comma field quoted', api.csvEscape('a,b'), '"a,b"');
  check('csv: quote field quoted+doubled', api.csvEscape('say "hi"'), '"say ""hi"""');
  check('csv: newline field quoted', api.csvEscape('a\nb'), '"a\nb"');
  check('csv: empty stays empty', api.csvEscape(''), '');
  check('csv: null stays empty', api.csvEscape(null), '');
  // A formula that ALSO contains a comma must be prefixed AND quoted.
  check('csv: formula with comma', api.csvEscape('=1+1,2'), "\"'=1+1,2\"");
  // Ordinary whitespace in a non-formula cell must survive intact.
  check('csv: ordinary whitespace preserved', api.csvEscape('  normal  '), '  normal  ');
  check('csv: plain leading whitespace preserved', api.csvEscape('  hello'), '  hello');
  // A leading LF is a trigger AND contains a newline, so it is both
  // prefixed and quoted.
  check('csv: leading LF prefixed and quoted', api.csvEscape('\n=cmd'), '"\'\n=cmd"');
  // A leading tab is itself a trigger, so the tab is kept and the value
  // prefixed — stripping it first would hide the trigger.
  check('csv: leading tab before = prefixed with tab kept', api.csvEscape('\t=1+1'), "'\t=1+1");
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
  // An impossible date must be rejected, not silently rolled over.
  check('parseLocalDate: Feb 30 rejected', api.parseLocalDate('2026-02-30'), null);
  check('parseLocalDate: month 13 rejected', api.parseLocalDate('2026-13-01'), null);
  check('parseLocalDate: day 0 rejected', api.parseLocalDate('2026-11-00'), null);
  check('parseLocalDate: Feb 29 non-leap rejected', api.parseLocalDate('2026-02-29'), null);
  const leap = api.parseLocalDate('2028-02-29');
  check('parseLocalDate: Feb 29 leap accepted', leap === null ? null : leap.getDate(), 29);
  check('parseLocalDate: a real leap day is a Date', api.parseLocalDate('2024-02-29') instanceof Date, true);

  const now = new Date();
  const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  check('todayLocalISO matches local calendar day', api.todayLocalISO(), local);
}

// === 3. "Other" document type label =======================================
{
  const { api } = buildEnv();
  check('label: normal type unchanged', api.documentTypeLabel({ documentType: 'Deed' }), 'Deed');
  check(
    'label: Other shows the description',
    api.documentTypeLabel({ documentType: 'Other', documentTypeOther: 'Vehicle Title' }),
    'Other — Vehicle Title'
  );
  check(
    'label: Other with no description',
    api.documentTypeLabel({ documentType: 'Other', documentTypeOther: '' }),
    'Other'
  );
  check('label: empty type', api.documentTypeLabel({ documentType: '' }), '');
}

// === 4. CSV end-to-end (the shape exportLog builds) =======================
{
  const { api } = buildEnv();
  const headers = ['Date', 'Client Name', 'Document Type', 'Notarization Type', 'Notes'];
  const rows = [
    ['2026-11-01', '=cmd|calc', 'Deed', 'Acknowledgment', 'line1, with "quotes"'],
    ['2026-10-05', 'Alice Smith', 'Affidavit', 'Jurat', ''],
  ];
  const csv = [headers, ...rows].map((r) => r.map(api.csvEscape).join(',')).join('\r\n') + '\r\n';
  const lines = csv.split('\r\n');
  check('csv e2e: header row', lines[0], 'Date,Client Name,Document Type,Notarization Type,Notes');
  check('csv e2e: formula neutralised', lines[1].split(',')[1], "'=cmd|calc");
  check(
    'csv e2e: quoted notes field',
    lines[1],
    '2026-11-01,\'=cmd|calc,Deed,Acknowledgment,"line1, with ""quotes"""'
  );
  check('csv e2e: second row', lines[2], '2026-10-05,Alice Smith,Affidavit,Jurat,');
  check('csv e2e: trailing CRLF', csv.endsWith('\r\n'), true);
}

// === 5. The Document Type dropdown must be alphabetical ====================
{
  const html = fs.readFileSync(path.join(__dirname, '..', 'log.html'), 'utf8');

  // Pull the documentType <select> block out of the markup.
  const selectMatch = html.match(
    /<select id="documentType"[^>]*>([\s\S]*?)<\/select>/
  );
  check('html: the documentType select exists', !!selectMatch, true);

  if (selectMatch) {
    const labels = [...selectMatch[1].matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map(
      (m) => m[1].trim()
    );
    const types = labels.slice(1); // drop the "Select type..." placeholder

    check('html: "Other" is offered', types.includes('Other'), true);

    // Sort the way a person reads the list: ignore the descriptive suffix
    // after " / " and any parenthetical, then compare case-insensitively.
    const key = (s) =>
      s
        .split(' / ')[0]
        .split(' (')[0]
        .trim()
        .toLowerCase();
    const expected = [...types].sort((a, b) =>
      key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0
    );
    check(
      'html: the Document Type dropdown is alphabetical',
      JSON.stringify(types) === JSON.stringify(expected),
      true
    );
    if (JSON.stringify(types) !== JSON.stringify(expected)) {
      console.log('        actual order:   ' + JSON.stringify(types));
      console.log('        expected order: ' + JSON.stringify(expected));
    }
  }

  // The "Other" description field must exist and start hidden.
  check('html: the Other description field exists', /id="documentTypeOther"/.test(html), true);
  check(
    'html: the Other description group starts hidden',
    /id="otherTypeGroup"[^>]*hidden/.test(html),
    true
  );
}

// === 6. The Identification Type field ======================================
{
  const { api } = buildEnv();
  check(
    'label: identification type only',
    api.identificationLabel({ identificationType: 'Passport', identificationNumber: '' }),
    'Passport'
  );
  check(
    'label: identification type and number',
    api.identificationLabel({ identificationType: 'State ID', identificationNumber: 'S-12345' }),
    'State ID — S-12345'
  );
  check(
    'label: identification number only',
    api.identificationLabel({ identificationType: '', identificationNumber: 'S-12345' }),
    'S-12345'
  );
  check(
    'label: no identification',
    api.identificationLabel({ identificationType: '', identificationNumber: '' }),
    ''
  );

  const html = fs.readFileSync(path.join(__dirname, '..', 'log.html'), 'utf8');

  // The Identification Type dropdown must exist and be alphabetical.
  const idMatch = html.match(/<select id="identificationType"[^>]*>([\s\S]*?)<\/select>/);
  check('html: the identificationType select exists', !!idMatch, true);
  if (idMatch) {
    const labels = [...idMatch[1].matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) =>
      m[1].trim()
    );
    const types = labels.slice(1);
    check(
      'html: the identification types are Driver\'s License, Passport, State ID, Thumb Print',
      JSON.stringify(types),
      JSON.stringify(["Driver's License", 'Passport', 'State ID', 'Thumb Print'])
    );
    const sorted = [...types].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
    check(
      'html: the identification types are alphabetical',
      JSON.stringify(types) === JSON.stringify(sorted),
      true
    );
  }

  // The number field must exist below the type field.
  check('html: the identificationNumber field exists', /id="identificationNumber"/.test(html), true);

  // Field order: Notes, then Identification Type, then Identification Number,
  // then Identification Image.
  const order = ['id="notes"', 'id="identificationType"', 'id="identificationNumber"', 'id="entryImage"'];
  const positions = order.map((needle) => html.indexOf(needle));
  check('html: all four fields are present', positions.every((p) => p >= 0), true);
  check(
    'html: the fields are ordered Notes -> Identification Type -> Identification Number -> Image',
    positions.every((p, i) => i === 0 || p > positions[i - 1]),
    true
  );

  // The table needs an Identification column.
  check('html: the table has an Identification column', /<th scope="col">Identification<\/th>/.test(html), true);
}

// === 7. Modal layout and the [hidden] override bug ========================
{
  const fs2 = require('fs');
  const path2 = require('path');
  const css = fs2.readFileSync(path2.join(__dirname, '..', 'style.css'), 'utf8');
  const html2 = fs2.readFileSync(path2.join(__dirname, '..', 'log.html'), 'utf8');

  // The UA stylesheet's [hidden] { display: none } loses to any class that
  // sets a display property, so .image-preview stayed visible while the
  // code believed it was hidden. A global [hidden] rule fixes it.
  check(
    'css: a global [hidden] rule exists',
    /\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(css),
    true
  );

  // The preview img must not ship with an empty src: an empty src makes the
  // browser request the current page and render a broken image.
  check(
    'html: the preview img has no empty src attribute',
    /id="imagePreviewImg"[^>]*\ssrc="/.test(html2),
    false
  );

  // The modal must scroll rather than clip its content.
  check('css: the modal overlay scrolls', /\.modal\s*\{[^}]*overflow-y:\s*auto/.test(css), true);
  check(
    'css: the modal content is height-capped',
    /\.modal-content\s*\{[^}]*max-height:\s*calc\(100dvh/.test(css),
    true
  );
  check(
    'css: the modal content caps at a viewport-relative height',
    /\.modal-content\s*\{[^}]*max-height:\s*calc\(100vh/.test(css),
    true
  );

  // The page behind the dialog must be locked on <html> as well as <body>;
  // overflow:hidden on <body> alone does not stop the document scrolling.
  check('css: html gets the modal scroll lock', /html\.modal-open/.test(css), true);
  check('css: body gets the modal scroll lock', /body\.modal-open/.test(css), true);

  const js2 = fs2.readFileSync(path2.join(__dirname, '..', 'log.js'), 'utf8');
  check(
    'js: the modal scroll lock is applied to documentElement',
    /document\.documentElement\.classList\.add\('modal-open'\)/.test(js2),
    true
  );
  check(
    'js: the modal scroll lock is removed from documentElement',
    /document\.documentElement\.classList\.remove\('modal-open'\)/.test(js2),
    true
  );
}

// === 13. The RCW 42.45.180 compliance fields =============================
{
  const html = fs.readFileSync(path.join(__dirname, '..', 'log.html'), 'utf8');
  const api = fs.readFileSync(path.join(__dirname, '..', 'api.php'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'log.js'), 'utf8');

  // The statute requires the journal to record the time and place of the
  // notarial act, so the form must collect them.
  check('html: the time-of-act field exists', html.includes('id="entryTime"'), true);
  check('html: the venue field exists', html.includes('id="venue"'), true);
  check('html: the county field exists', html.includes('id="county"'), true);
  check('html: the signer-address field exists', html.includes('id="signerAddress"'), true);

  // The time of act and the venue are mandatory.
  const timeField = html.match(/<input[^>]*id="entryTime"[^>]*>/);
  check('html: the time-of-act field is required', !!timeField && timeField[0].includes('required'), true);
  const venueField = html.match(/<input[^>]*id="venue"[^>]*>/);
  check('html: the venue field is required', !!venueField && venueField[0].includes('required'), true);
  const countyField = html.match(/<input[^>]*id="county"[^>]*>/);
  check('html: the county field is required', !!countyField && countyField[0].includes('required'), true);

  // The schema carries all four.
  for (const column of ['entry_time', 'venue', 'county', 'signer_address']) {
    check(`api: the ${column} column exists in the schema`, api.includes(column), true);
  }
  // And the migration covers the pre-existing database.
  const migration = api.match(/foreach \(\[([\s\S]*?)\] as \$column/);
  check('api: there is a column migration block', !!migration, true);
  if (migration) {
    for (const column of ['entry_time', 'venue', 'county', 'signer_address']) {
      check(`api: the migration adds ${column}`, migration[1].includes(column), true);
    }
  }

  // The client sends them, reloads them, and renders them.
  check('js: the client submits entryTime', js.includes('entryTime: timeEl'), true);
  check('js: the client submits venue', js.includes('venue: venueEl'), true);
  check('js: the client submits county', js.includes('county: countyEl'), true);
  check('js: the client submits signerAddress', js.includes('signerAddress: addrEl'), true);
  check('js: the edit form reloads entryTime', js.includes('timeEl.value = entry.entryTime'), true);
  check('js: the table renders a time/place cell', js.includes('venueLabel(entry)'), true);
  check('js: the CSV export includes the compliance columns', js.includes("'Time of Notarial Act'"), true);
  check('js: the CSV export includes the county', js.includes("'County'"), true);
}

// === 14. Accessibility items from the code review =========================
{
  const html = fs.readFileSync(path.join(__dirname, '..', 'log.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');

  // role="dialog" belongs on the dialog box, not the overlay wrapper.
  const dialogBox = html.match(/<div class="modal-content"[^>]*role="dialog"[^>]*>/);
  check('html: role="dialog" is on the modal content', !!dialogBox, true);
  const overlayWithRole = html.match(/<div id="entryModal"[^>]*role="dialog"/);
  check('html: role="dialog" is not on the overlay', !overlayWithRole, true);

  // The two statistics are one live region, not two.
  check('html: the stats block is a live region', /class="log-stats"[^>]*aria-live="polite"/.test(html), true);
  const individualLiveRegions = (html.match(/class="stat-box"[^>]*aria-live/g) || []).length;
  check('html: the stat boxes are not separate live regions', individualLiveRegions, 0);

  // The shared script is deferred so it cannot block parsing.
  check('html: main.js is deferred', /<script defer src="main\.js/.test(html), true);

  // A skip link lets a keyboard user bypass the navigation.
  check('html: the log page has a skip link', html.includes('class="skip-link"'), true);
  check('html: the skip link targets the main content', html.includes('href="#mainContent"'), true);
  check('html: the main content has the skip-link target', html.includes('id="mainContent"'), true);
  check('css: the skip link is hidden until focused', /\.skip-link\s*\{[^}]*top:\s*-100px/.test(css), true);
  // The rule is written as a two-selector list (:focus and :focus-visible),
  // so the assertion has to allow for the comma.
  check(
    'css: the skip link becomes visible on focus',
    /\.skip-link:focus\s*(,[^{]*)?\{[^}]*top:\s*0/.test(css),
    true
  );
  check(
    'css: the skip link also matches :focus-visible',
    /\.skip-link:focus-visible/.test(css),
    true
  );

  // Every page in the site gets the skip link, not just the log.
  for (const page of ['index.html', 'services.html', 'resume.html']) {
    const p = fs.readFileSync(path.join(__dirname, '..', page), 'utf8');
    check(`html: ${page} has a skip link`, p.includes('class="skip-link"'), true);
    check(`html: ${page} has the mainContent target`, p.includes('id="mainContent"'), true);
  }
}

// === 8. Live API integration — skipped unless API_URL is provided ==========
(async () => {
  const API_URL = process.env.API_URL;
  const API_PIN = process.env.API_PIN;

  if (!API_URL) {
    console.log('\n(skip) live API tests — set API_URL to enable');
  } else {
    const base = API_URL;
    let cookie = '';

    async function call(action, options = {}) {
      const headers = Object.assign({}, options.headers || {});
      if (cookie) headers.Cookie = cookie;
      let body;
      if (options.raw !== undefined) {
        body = options.raw;
      } else if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(options.body);
      }
      const res = await fetch(`${base}?action=${action}`, {
        method: options.method || 'GET',
        headers,
        body,
        redirect: 'manual',
      });
      const setCookie = res.headers && res.headers.getSetCookie
        ? res.headers.getSetCookie()
        : [];
      if (setCookie && setCookie.length) {
        cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
      }
      let json = null;
      try {
        json = await res.json();
      } catch (e) {
        json = null;
      }
      return { status: res.status, body: json };
    }

    // Unauthenticated access must be refused.
    const status = await call('status');
    check('api: status responds without a session', status.status, 200);
    check('api: status reports not authenticated', status.body && status.body.authenticated, false);

    const denied = await call('list');
    check('api: listing without a session is refused', denied.status, 401);

    const deniedSave = await call('save', {
      method: 'POST',
      body: { entry: { date: '2026-11-21', clientName: 'x', documentType: 'Deed', notarizationType: 'Jurat' } },
    });
    check('api: saving without a session is refused', deniedSave.status, 401);

    const deniedDelete = await call('delete', { method: 'POST', body: { id: 'x' } });
    check('api: deleting without a session is refused', deniedDelete.status, 401);

    if (!API_PIN) {
      console.log('\n(skip) login tests — set API_PIN to enable');
    } else {
      // A wrong PIN must be rejected.
      const bad = await call('login', { method: 'POST', body: { pin: '000000-wrong' } });
      check('api: a wrong PIN is rejected', bad.status, 401);
      check('api: a wrong PIN returns ok:false', bad.body && bad.body.ok, false);

      // The correct PIN must be accepted and set a session cookie.
      const good = await call('login', { method: 'POST', body: { pin: API_PIN } });
      check('api: the correct PIN is accepted', good.status, 200);
      check('api: a session cookie is set', cookie.length > 0, true);

      const nowAuth = await call('list');
      check('api: listing with a session succeeds', nowAuth.status, 200);
      check('api: entries is an array', Array.isArray(nowAuth.body && nowAuth.body.entries), true);

      // Round-trip an entry.
      const created = await call('save', {
        method: 'POST',
        body: {
          entry: {
            id: '',
            date: '2026-11-21',
            clientName: 'ZZ API Test',
            documentType: 'Other',
            documentTypeOther: 'Vehicle Title',
            notarizationType: 'Acknowledgment',
            notes: 'created by the API test harness',
            entryTime: '14:30',
            venue: 'Test Venue',
            county: 'Cowlitz',
            signerAddress: '100 Test St, Longview WA',
          },
        },
      });
      check('api: saving an entry succeeds', created.status, 200);
      check('api: the saved entry has an id', !!(created.body && created.body.entry && created.body.entry.id), true);
      check(
        'api: the time of the notarial act is stored',
        created.body && created.body.entry && created.body.entry.entryTime,
        '14:30'
      );
      check(
        'api: the venue is stored',
        created.body && created.body.entry && created.body.entry.venue,
        'Test Venue'
      );
      check(
        'api: the county is stored',
        created.body && created.body.entry && created.body.entry.county,
        'Cowlitz'
      );
      check(
        'api: the signer address is stored',
        created.body && created.body.entry && created.body.entry.signerAddress,
        '100 Test St, Longview WA'
      );

      // RCW 42.45.180 requires the time and place of the act.
      const noVenue = await call('save', {
        method: 'POST',
        body: {
          entry: {
            id: '',
            date: '2026-11-21',
            clientName: 'ZZ API Test',
            documentType: 'Deed',
            notarizationType: 'Jurat',
            venue: '',
            county: 'Cowlitz',
          },
        },
      });
      check('api: saving without a venue is refused', noVenue.status, 400);

      const noCounty = await call('save', {
        method: 'POST',
        body: {
          entry: {
            id: '',
            date: '2026-11-21',
            clientName: 'ZZ API Test',
            documentType: 'Deed',
            notarizationType: 'Jurat',
            venue: 'Test Venue',
            county: '',
          },
        },
      });
      check('api: saving without a county is refused', noCounty.status, 400);

      const badTime = await call('save', {
        method: 'POST',
        body: {
          entry: {
            id: '',
            date: '2026-11-21',
            clientName: 'ZZ API Test',
            documentType: 'Deed',
            notarizationType: 'Jurat',
            entryTime: 'not a time',
            venue: 'Test Venue',
            county: 'Cowlitz',
          },
        },
      });
      check('api: saving with a malformed time is refused', badTime.status, 400);
      check(
        'api: the Other description is stored',
        created.body && created.body.entry && created.body.entry.documentTypeOther,
        'Vehicle Title'
      );

      const listed = await call('list');
      check(
        'api: the new entry appears in the list',
        (listed.body.entries || []).some((e) => e.clientName === 'ZZ API Test'),
        true
      );

      // Validation: an "Other" type with no description must be rejected.
      const badOther = await call('save', {
        method: 'POST',
        body: {
          entry: {
            id: '', date: '2026-11-21', clientName: 'ZZ Bad Other',
            documentType: 'Other', documentTypeOther: '',
            notarizationType: 'Acknowledgment', notes: '',
          },
        },
      });
      check('api: an Other type with no description is rejected', badOther.status, 400);

      // Validation: an impossible date must be rejected.
      const badDate = await call('save', {
        method: 'POST',
        body: {
          entry: {
            id: '', date: '2026-02-30', clientName: 'ZZ Bad Date',
            documentType: 'Deed', notarizationType: 'Acknowledgment', notes: '',
          },
        },
      });
      check('api: an impossible date is rejected', badDate.status, 400);

      // Validation: a missing client name must be rejected.
      const badName = await call('save', {
        method: 'POST',
        body: {
          entry: {
            id: '', date: '2026-11-21', clientName: '',
            documentType: 'Deed', notarizationType: 'Acknowledgment', notes: '',
          },
        },
      });
      check('api: a missing client name is rejected', badName.status, 400);

      // The identification fields must round-trip.
      const withId = await call('save', {
        method: 'POST',
        body: {
          entry: {
            id: created.body.entry.id,
            date: '2026-11-21',
            clientName: 'ZZ API Test',
            documentType: 'Other',
            documentTypeOther: 'Vehicle Title',
            notarizationType: 'Acknowledgment',
            notes: 'created by the API test harness',
            entryTime: '15:45',
            venue: 'Edited Venue',
            county: 'Clark',
            signerAddress: '200 Edited Ave, Vancouver WA',
            identificationType: 'Driver\'s License',
            identificationNumber: 'WA-DL-99887766',
          },
        },
      });
      check('api: saving the identification fields succeeds', withId.status, 200);
      check(
        'api: the identification type is stored',
        withId.body && withId.body.entry && withId.body.entry.identificationType,
        "Driver's License"
      );
      check(
        'api: the identification number is stored',
        withId.body && withId.body.entry && withId.body.entry.identificationNumber,
        'WA-DL-99887766'
      );

      const listedWithId = await call('list');
      const storedWithId = (listedWithId.body.entries || []).find(
        (e) => e.id === created.body.entry.id
      );
      check(
        'api: the listed entry reports the identification type',
        storedWithId && storedWithId.identificationType,
        "Driver's License"
      );

      // An identification type outside the allowed set must be rejected.
      const badIdType = await call('save', {
        method: 'POST',
        body: {
          entry: {
            id: '', date: '2026-11-21', clientName: 'ZZ Bad Id',
            documentType: 'Deed', notarizationType: 'Acknowledgment', notes: '',
            venue: 'Test Venue', county: 'Cowlitz',
            identificationType: 'Telepathy',
            identificationNumber: 'X',
          },
        },
      });
      check('api: an unknown identification type is rejected', badIdType.status, 400);

      // An ID number with no type must be rejected.
      const noIdType = await call('save', {
        method: 'POST',
        body: {
          entry: {
            id: '', date: '2026-11-21', clientName: 'ZZ No Id Type',
            documentType: 'Deed', notarizationType: 'Acknowledgment', notes: '',
            venue: 'Test Venue', county: 'Cowlitz',
            identificationType: '',
            identificationNumber: 'WA-DL-123',
          },
        },
      });
      check('api: an ID number with no type is rejected', noIdType.status, 400);

      // Edit the entry.
      const edited = await call('save', {
        method: 'POST',
        body: {
          entry: {
            id: created.body.entry.id,
            date: '2026-11-21',
            clientName: 'ZZ API Test Edited',
            documentType: 'Other',
            documentTypeOther: 'Vehicle Title',
            notarizationType: 'Jurat',
            notes: 'edited by the API test harness',
            entryTime: '15:45',
            venue: 'Edited Venue',
            county: 'Clark',
            signerAddress: '200 Edited Ave, Vancouver WA',
            identificationType: 'State ID',
            identificationNumber: 'S-12345',
          },
        },
      });
      check('api: editing an entry succeeds', edited.status, 200);
      check(
        'api: the edit updated the identification type',
        edited.body && edited.body.entry && edited.body.entry.identificationType,
        'State ID'
      );
      check(
        'api: the edit was applied',
        edited.body && edited.body.entry && edited.body.entry.clientName,
        'ZZ API Test Edited'
      );

      // Thumb Print is a valid type too, with free-text details.
      const thumb = await call('save', {
        method: 'POST',
        body: {
          entry: {
            id: '', date: '2026-11-21', clientName: 'ZZ Thumb',
            documentType: 'Deed', notarizationType: 'Jurat', notes: '',
            venue: 'Test Venue', county: 'Cowlitz',
            identificationType: 'Thumb Print',
            identificationNumber: 'Right thumb, rolled ink',
          },
        },
      });
      check('api: a Thumb Print entry saves', thumb.status, 200);
      check(
        'api: the Thumb Print type is stored',
        thumb.body && thumb.body.entry && thumb.body.entry.identificationType,
        'Thumb Print'
      );
      if (thumb.body && thumb.body.entry && thumb.body.entry.id) {
        await call('delete', { method: 'POST', body: { id: thumb.body.entry.id } });
      }

      // Image round-trip: upload, then fetch it back through the
      // authenticated endpoint. This runs BEFORE the delete so the entry
      // still exists to attach the image to.
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC',
        'base64'
      );
      const form = new FormData();
      form.append('image', new Blob([png], { type: 'image/png' }), 'license.png');
      form.append('id', created.body.entry.id);
      const uploaded = await fetch(`${base}?action=upload`, {
        method: 'POST',
        headers: { Cookie: cookie },
        body: form,
        redirect: 'manual',
      });
      const uploadedJson = await uploaded.json().catch(() => ({}));
      check('api: uploading an image succeeds', uploaded.status, 200);
      check('api: the upload reports hasImage', uploadedJson.hasImage, true);

      const imgRes = await fetch(`${base}?action=image&id=${created.body.entry.id}`, {
        headers: { Cookie: cookie },
      });
      check('api: fetching the image with a session succeeds', imgRes.status, 200);
      check(
        'api: the image comes back as a PNG',
        (imgRes.headers.get('content-type') || '').includes('image/png'),
        true
      );
      const imgBytes = Buffer.from(await imgRes.arrayBuffer());
      check('api: the image bytes match what was uploaded', imgBytes.equals(png), true);

      // The image must NOT be reachable without a session.
      const noAuthImg = await fetch(`${base}?action=image&id=${created.body.entry.id}`);
      check('api: fetching the image without a session is refused', noAuthImg.status, 401);

      // The stored entry must report the image.
      const withImg = await call('list');
      const imgEntry = (withImg.body.entries || []).find(
        (e) => e.id === created.body.entry.id
      );
      check('api: the stored entry reports hasImage', imgEntry && imgEntry.hasImage, true);

      // Now delete the entry and confirm both the entry and its image go.
      const deleted = await call('delete', {
        method: 'POST',
        body: { id: created.body.entry.id },
      });
      check('api: deleting an entry succeeds', deleted.status, 200);

      const after = await call('list');
      check(
        'api: the deleted entry is gone',
        (after.body.entries || []).some((e) => e.clientName === 'ZZ API Test Edited'),
        false
      );

      // Deleting the entry must remove the image file too.
      const imgAfterDelete = await fetch(`${base}?action=image&id=${created.body.entry.id}`, {
        headers: { Cookie: cookie },
      });
      check(
        'api: the image is gone after the entry is deleted',
        imgAfterDelete.status,
        404
      );

      // Sign out and confirm the session is dead.
      const out = await call('logout', { method: 'POST', body: {} });
      check('api: logout succeeds', out.status, 200);
      const afterOut = await call('list');
      check('api: listing after logout is refused', afterOut.status, 401);
    }
  }

  console.log('');
  if (failures === 0) {
    console.log(`ALL ${passed} TESTS PASSED`);
    process.exit(0);
  } else {
    console.log(`${passed} passed, ${failures} FAILED`);
    process.exit(1);
  }
})();
