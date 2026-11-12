# jentalent.com

Static website for Jenifer Talent, Notary Public (Longview, WA).

## Live

https://www.jentalent.com

## Stack

- Plain HTML, CSS, vanilla JavaScript — no build step, no framework
- 4 pages: `index.html`, `services.html`, `resume.html`, `log.html`
- One stylesheet (`style.css`)
- Two scripts: `main.js` (mobile menu + smooth scroll, shared across all pages) and `log.js` (notary log CRUD + CSV export, loaded only on `log.html`)
- Hosted on NearlyFreeSpeech

## Notary Log (log.html)

A client-side notary journal. Everything is stored in the browser's
`localStorage`; **nothing is sent to any server**, and there is no build step
or runtime dependency.

### Washington notarial journal support

The log is built to support Washington's notarial journal rules:

| Requirement | Citation | How it is met |
|---|---|---|
| Entry made contemporaneously; date and time of the act | RCW 42.45.180(4)(a) | Date **and** time are required fields, stored separately and displayed as one "Date & Time" column. |
| Description of the record and type of notarial act | RCW 42.45.180(4)(b) | Document type and notarization type selects. |
| Full name **and address** of each individual | RCW 42.45.180(4)(c) | Principal name and principal address are required fields. |
| Additional information required by rule | RCW 42.45.180(4)(d) | Statement/document count (WAC 308-30-190(2)), identification method and signature (WAC 308-30-200(1)). |
| Method of identifying the principal | WAC 308-30-200(1)(ii) | Required select: personal knowledge, government-issued photo ID, remote online notarization, satisfactory evidence/document owner, other. |
| Principal signature, or notation of remote notarization | WAC 308-30-200(1)(iii) | Canvas signature pad with a typed-name fallback. |
| Number of statements/documents when one entry covers several | WAC 308-30-190(2) | Required integer, 1 or more. |
| Electronic journal only in addition to the tangible journal | WAC 308-30-200(2)(a) | A notice at the top of the page states this in plain language and says the tangible journal remains the primary record. |
| Access by password or other secure means of authentication | WAC 308-30-200(2)(c) | Password gate on first use; the journal is locked until the password is entered. |
| Tamper-evident | WAC 308-30-200(2)(d) | SHA-256 hash chain linking every entry to the previous one, plus an integrity check. |
| Duplicate record as a backup | WAC 308-30-200(2)(e) | One-click JSON backup download, a validating restore, and a backup reminder. |
| Capable of providing copies of any entry | WAC 308-30-200(2)(f) | A per-entry "Copy" action producing a printable standalone copy. |
| Retention of 10 years after the last act | RCW 42.45.180(1) | Stated in the notice on the log page. |
| Journal is the notary's exclusive property | WAC 308-30-200(3) | Stated in the notice on the log page. |

### Entry fields

| Field | Required | Notes |
|---|---|---|
| Date of the notarial act | yes | `<input type="date">`; defaults to today (local). |
| Time of the notarial act | yes | `<input type="time">`; defaults to now (local). |
| Principal name | yes | |
| Principal address | yes | Full address of the individual for whom the act was performed. |
| Document type | yes | Select. |
| Notarization type | yes | Select (acknowledgment, jurat, copy certification, RON, other). |
| Identification method | yes | Select (see WAC 308-30-200(1)(ii) above). |
| Number of statements/documents | yes | Integer ≥ 1. |
| Principal signature | yes | Drawn on the canvas, or typed as the principal's full name. |
| Notes | no | Free text. |

### The lock (WAC 308-30-200(2)(c))

- On first use the notary creates a password (minimum 8 characters).
- The password is never stored. Only a **PBKDF2-HMAC-SHA-256** hash
  (150,000 iterations) with a per-journal random salt is kept in
  `localStorage` under `notaryLogLock`.
- The **Lock journal** button re-locks the journal without closing the page.
- **Forgot your password?** → **Reset password, keep entries** clears only the
  password hash. **No entry is ever deleted by a password reset.**
- *Scope:* this is a privacy and lock-out control for a browser-local journal,
  not true security. Anyone with access to the browser profile and developer
  tools can read `localStorage`. If site data is cleared, the journal is gone
  with it — which is why the backup reminder matters.

### Tamper evidence and the integrity check (WAC 308-30-200(2)(d))

Each entry stores the SHA-256 hash of the previous entry's hash plus its own
content:

```
hash(n) = SHA-256( hash(n-1) + "|" + canonicalPayload(n) )
```

The first entry links to a genesis value. **Check integrity** recomputes the
whole chain and reports any entry that was changed outside the app (and any
broken link). Editing an entry through the app re-seals the chain from that
entry onward, so legitimate edits keep the journal verifiable.

### Backup and restore (WAC 308-30-200(2)(e))

- **Download backup** (and **Export JSON**) writes the full journal —
  entries, hash chain, and signature data — to
  `notary-journal-backup-YYYY-MM-DD.json`.
- **Restore backup** validates a file *before* it can overwrite anything: it
  must be valid JSON, carry the `jentalent-notary-journal-backup` format
  marker, and contain a readable entry list. The restore panel then states
  how many entries are in the file and how many are currently on the device
  before the notary confirms.
- A reminder banner appears when the journal has never been backed up, when
  the last backup is more than 7 days old, or when new entries have been
  added since the last backup. Backups are **never** downloaded
  automatically.

### Copies (WAC 308-30-200(2)(f))

Every entry row has a **Copy** action that opens a standalone view of that
entry with **Print / Save as PDF** (prints on its own page) and **Copy text**
buttons. The copy names the source as a copy of the electronic journal
maintained in addition to the tangible journal, and warns if the entry still
has missing required fields.

### Legacy entries

Entries saved before the compliance fields existed load without error and are
badged **"Legacy — missing required fields"**, with the missing fields listed
on hover. Nothing is fabricated for them — no time, address, identification
method, signature, or statement count is invented. Open the entry and fill in
the blanks to complete it; the badge clears once every required field is
present.

### Exports

- **Export CSV** — newest first, with the formula-injection guard (`=`, `+`,
  `-`, `@`, tab and CR prefixed values are neutralised), and every field:
  date, time, combined date & time, principal name, principal address,
  document type, notarization type, identification method, signature,
  signature type, statement count, notes, entry hash, and the list of missing
  required fields.
- **Export JSON** — the full journal, doubles as the backup file.

## Testing

```bash
node tests/log-logic.test.js
```

The harness re-wraps the real `log.js` textually to expose its internal
functions and runs them against a minimal DOM and `localStorage` stub. It
covers CSV escaping and ordering, local date/time parsing, corrupt-store
handling, required-field bookkeeping, the hash chain (including tamper
detection and re-sealing), the backup/restore format, password hashing, and
the legacy-entry migration path. No dependencies — plain Node.

## Deploy

From the parent `~/repos/websites/` directory:

```bash
./deploy.sh jentalent
```

`deploy.sh` opens a batched SFTP session to `talent_jentalent@ssh.nyc1.nearlyfreespeech.net` and syncs the contents of this directory into `/home/public/`.

## Local development

There is no build step. To preview locally:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

For the Notary Log page (`log.html`) to work in a browser, the page must be served over `http://` or `https://` — `file://` is blocked by browser `localStorage` policy in some setups.

## Repo conventions

- Single default branch: `master`
- Branch prefix for fixes/features: `fix/<slug>` / `feat/<slug>`
- PR description should include `Closes #N` for any issues it resolves
- Tracked issues live under the repo's Issues tab

## Layout

```
.
├── CHANGELOG.md
├── README.md
├── index.html       # home
├── services.html    # service list + pricing
├── resume.html      # bio + experience
├── log.html         # client-side notary log (uses log.js)
├── style.css        # shared styles
├── main.js          # mobile menu + smooth scroll
└── log.js           # notary log CRUD + CSV export
```
