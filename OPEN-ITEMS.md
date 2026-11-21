# Open Items — jentalent.com notary log

Tracking for work that is agreed on but not yet started. Nothing in this file
is implemented; it is a record of decisions and of the work still owed.

Last updated: 2026-11-21

**These are also tracked as GitHub Issues** — the repo's convention is that
work lives in the Issues tab, so this file is the long-form version and the
issues are the work queue:

| # | Item |
|---|---|
| [#11](https://github.com/christalent/jentalent-com/issues/11) | Backup and durability for the notary log |
| [#12](https://github.com/christalent/jentalent-com/issues/12) | Rotate the PIN off the chat log |
| [#13](https://github.com/christalent/jentalent-com/issues/13) | Reimplement "Clear All Entries" |
| [#14](https://github.com/christalent/jentalent-com/issues/14) | Notarial compliance fields (RCW 42.45.180) |
| [#15](https://github.com/christalent/jentalent-com/issues/15) | Remaining code-review items |
| [#16](https://github.com/christalent/jentalent-com/issues/16) | Encrypt the uploaded ID images at rest |
| [#17](https://github.com/christalent/jentalent-com/issues/17) | Merge the branch into master |
| [#18](https://github.com/christalent/jentalent-com/issues/18) | Rewrite the stale README |
| [#19](https://github.com/christalent/jentalent-com/issues/19) | Add a durable cache policy for the site assets |

---

## 9. Durable cache policy for the site assets

**Status:** OPEN — workaround in place, durable fix not done.

NFSHost sits behind an edge cache (`via: e7s`) that serves static assets by
URL. After a deploy it keeps returning the old stylesheet and JS for the same
URL. The version query on asset references is the current workaround, and
`deploy.sh` bumps it automatically. The open part is removing the manual
version from the equation — most likely by content-hashing the asset
filenames. Tracked in issue #19.

**Do not try `.htaccess`.** The account's Apache has no `mod_headers`; a
`Header set` directive produces a 500 on every CSS and JS request.

---

## 1. Backup and durability for the notary log

**Status:** OPEN — agreed in principle, deliberately not started.

**Decision (2026-11-21, Chris):** Keep the current PIN while prototyping.
Backup was discussed but explicitly deferred: *"Don't do anything yet, but keep
it as an open item(s) on this project."*

### Why this is open

The notary log is the only part of this site with **state that cannot be
rebuilt from the repo**. The HTML/CSS/JS live in git and are recoverable from
GitHub. The log data does not:

| Data | Where it lives | In git? | Recoverable? |
|---|---|---|---|
| SQLite database | `/home/tmp/log-data/notary.db` (on NFSHost) | No | **No** |
| Uploaded ID images | `/home/tmp/log-data/uploads/` (on NFSHost) | No | **No** |
| PIN hash | `/home/tmp/log-data/pin.hash` (on NFSHost) | No | Only by re-running setup |

`/home/tmp` is NFSHost's scratch space. It sits outside the webroot, which is
what makes it safe from URL access — but it is not a documented durable store.
Provider maintenance, an account change, or a migration could take it with it.
The uploaded images are **unencrypted at rest**, which raises the cost of a
loss: an ID photo would be gone rather than merely a ledger entry.

### Candidate paths

**Option A — rclone from BOSGAME to cloud and/or BOSGAME.**
Copy the data directory off NFSHost to BOSGAME, then mirror it onward to the
existing rclone remotes (`internxt`, `koofr`, `pcloud`, `onedrive`) and/or
keep a local copy on BOSGAME.

**Option B — run the log from BOSGAME.**
Move the whole application off NFSHost and onto BOSGAME, where it sits inside
the existing backup and Timeshift layers.

**Option C — both.**
Mirror to BOSGAME as the hot copy, and cloud as the offsite copy.

### Constraints that apply to any option

- **Never tar or copy a live SQLite database directly.** The file is being
  written to while a copy reads it, which yields a corrupt snapshot. Snapshot
  first — `sqlite3 notary.db ".backup /tmp/x"` — and copy the snapshot.
  (This is the same failure that bit `~/.hermes/state.db`; see
  `bosgame-system-backup` → `references/sections/34-never-tar-a-live-sqlite-db-directly.md`.)
- **The copy must exclude nothing and include everything.** The database and
  the `uploads/` directory are one unit. A database with orphaned image
  references, or images with no database row, are both broken states.
- **The PIN hash is part of the backup.** Restoring the database without
  `pin.hash` means Jen has to re-run setup; restoring without the uploaded
  images means the entries lose their photos.
- **Backups contain unencrypted ID documents.** Any cloud target therefore
  needs the same access control as the site itself — the images are protected
  by the PIN and the webroot boundary today, not by encryption at rest.
- **Retention matters.** These are images of state IDs, not disposable files.
  Decide a retention period before a recurring job exists, so the cloud does
  not accumulate years of ID photos with no deletion policy.
- **Restores must be tested.** A backup that has never been restored is a
  guess. Include a restore rehearsal in the definition of done.

### Related existing mechanisms

- BOSGAME system-config backup: `/home/chris/scripts/bosgame-config-backup.sh`
  (see `bosgame-system-backup` skill → `references/sections/09-adding-a-new-artifact-to-the-backup.md`
  for the procedure to add an artifact, and `BOSGAME-RESTORE.md` for the restore guide).
- rclone remotes already configured: `internxt`, `koofr`, `pcloud`, `onedrive`.
- Cloud retention chain in use elsewhere: pcloud + koofr at 28 days, internxt at 365 days.
- **Note:** the rclone PATH issue (`references/sections/32-the-rclone-path-issue.md`)
  applies to cron contexts — use the absolute path to `rclone` in any scheduled job.

### Also worth noting

- NFSHost `/home/private` is **not writable** by the PHP process; `/home/tmp` is
  the only writable path outside the webroot. Worth asking NFSHost whether
  `/home/private` can be made writable, since it would be a better home for
  the data than scratch space.
- The offsite copy of the data and the offsite copy of the *code* are separate
  concerns. The code is already in git; this item is only about the data.

---

## 2. PIN rotation

**Status:** OPEN — deferred during prototyping by the same decision as item 1.

**Decision (2026-11-21, Chris):** *"I think we'll keep the pin while
prototyping."*

**Context:** the PIN (`884000`) was supplied over Discord chat, so it exists in
a chat transcript and in the session archive. It is stored server-side as a
PBKDF2-HMAC-SHA256 hash (120k iterations, random salt), so the plaintext is not
on disk — but anyone with the transcript has the PIN.

**Rotate when:** prototyping ends, or sooner if the log starts holding real
client data. Rotation means re-running the one-time setup path with a new PIN
and a new salt. The current PIN should not be reused.

---

## 3. "Clear All Entries" needs reimplementing

**Status:** OPEN — removed, not replaced.

The action existed when the log was client-side and cleared `localStorage`. With
server-side storage there is no equivalent, so it was **removed rather than
left broken**. Nothing has taken its place.

It needs a server-side bulk delete with typed confirmation ("delete all N
entries") and a session re-authentication check. Note that it must also remove
the uploaded images, not just the database rows.

---

## 4. Notarial compliance fields (RCW 42.45.180)

**Status:** OPEN — partially addressed.

The statute requires the journal record to include the time and place of the
notarial act, and the signer's address and method of identification. What
exists today:

| Field | Status |
|---|---|
| Date | Present |
| Client name | Present |
| Document type (+ Other description) | Present |
| Notarization type | Present |
| Notes | Present |
| Identification type | Present (added 2026-11-21) |
| Identification number / details | Present (added 2026-11-21) |
| Identification image | Present (added 2026-11-21) |
| **Time of the act** | **Missing** |
| **Venue / county** | **Missing** |
| **Signer address** | **Missing** |

The identification fields get closer but do not close the gap — a journal
record without the time and place of the act is still non-compliant.

---

## 5. Remaining code-review items

**Status:** OPEN — from the original review, not yet addressed.

- `role="dialog"` sits on the modal wrapper rather than `.modal-content`.
- No skip-to-content link.
- The two statistics at the top of the log are separate live regions; they
  should be a single combined region.
- The log page sets no `Cache-Control` or CSP headers of its own.
- `main.js` is not deferred.
- The README still describes the old client-side `localStorage` log and the
  old `~/repos/websites/` deploy path. **It is stale** — see item 7.

---

## 6. Storage hardening

**Status:** OPEN — noted, low priority.

- Uploaded images are **not encrypted at rest**. They are protected by the PIN
  and the webroot boundary. For state ID photos this is a real consideration,
  not a theoretical one.
- The backup copies in item 1 would inherit the same property, so any cloud
  target needs equivalent access control.

---

## 7. Merge the branch

**Status:** OPEN.

The work lives on `fix/notary-log-integrity-a11y` (commits `74e8860`,
`361f8bd`, `92878b5`), pushed to origin, **not merged into `master`** and no
PR opened yet.

Branch: https://github.com/christalent/jentalent-com/tree/fix/notary-log-integrity-a11y

**Note:** the branch name no longer describes its contents. It now carries the
server-backed rewrite, the PIN gate, image attachments, the "Other" document
type, and the identification fields. A rename (e.g. `feat/notary-log-server`)
would be clearer before the PR.

---

## 8. README is stale

**Status:** OPEN.

`README.md` still says the log is client-side, describes `localStorage`, and
points at `~/repos/websites/deploy.sh` for deployment. The current deploy path
is `rsync` to `nfs-jentalent:/home/public/` (see the `nfshost-deploy` skill).
The Stack, Deploy, and Layout sections all need rewriting, and the data
directory at `/home/tmp/log-data` needs documenting — including the fact that
it is not covered by git.
