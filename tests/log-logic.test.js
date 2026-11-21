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

// === 6. Live API integration — skipped unless API_URL is provided ==========
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
          },
        },
      });
      check('api: saving an entry succeeds', created.status, 200);
      check('api: the saved entry has an id', !!(created.body && created.body.entry && created.body.entry.id), true);
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
          },
        },
      });
      check('api: editing an entry succeeds', edited.status, 200);
      check(
        'api: the edit was applied',
        edited.body && edited.body.entry && edited.body.entry.clientName,
        'ZZ API Test Edited'
      );

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
