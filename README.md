# jentalent.com

Website for Jenifer Talent, Notary Public (Longview, WA).

## Live

https://www.jentalent.com

## Stack

- Plain HTML, CSS, vanilla JavaScript — no build step, no framework
- 4 static pages: `index.html`, `services.html`, `resume.html`, `log.html`
- One stylesheet (`style.css`)
- `main.js` — mobile menu + smooth scroll, shared across all pages
- `log.js` — notary log client (loaded only on `log.html`)
- `api.php` — the notary log's server-side API (PHP 8.3 + SQLite)
- Hosted on NearlyFreeSpeech

## The notary log

`log.html` is a private, PIN-protected client log. Unlike the rest of the
site it has **server-side state**.

- **Storage:** SQLite at `/home/tmp/log-data/notary.db` on the NFSHost
  account. The database and the uploaded images live outside the webroot, so
  they are not reachable by URL (every path returns 404).
- **Auth:** the PIN is verified server-side and stored as a
  PBKDF2-HMAC-SHA256 hash (120k iterations, random salt). It is not in the
  page source and not in plaintext on disk. The session is an `HttpOnly`,
  `Secure`, `SameSite=Lax` cookie with an 8-hour lifetime. Five wrong
  attempts triggers a 15-minute lockout.
- **Images:** entries can carry a photo of a driver's license or other ID
  (JPEG, PNG, WebP, HEIC, up to 8 MB). The file type is sniffed server-side
  with `finfo`. Files are written at mode 0600 and served only through an
  authenticated endpoint. Deleting an entry deletes its image.
- **Not covered by git.** The database and the uploads are the only state on
  this site that cannot be rebuilt from the repo — see issue #11 for the
  backup plan.
- **Not encrypted at rest.** The images are protected by the PIN and the
  webroot boundary, not by encryption. See issue #16.

### API

`api.php?action=...` — `status`, `login`, `logout`, `list`, `save`,
`delete`, `upload`, `image`. Every action except `status` and `login`
requires the session cookie.

## Deploy

```bash
./deploy.sh
```

This bumps the asset version query, runs the syntax checks
(`node --check`, `php -l`), and rsyncs to `nfs-jentalent:/home/public/`.

**The asset version is not optional.** NFSHost sits behind an edge cache
(`via: e7s`) that serves static assets by URL and will hand back the old
stylesheet after a deploy. The `?v=` query on every asset reference is what
makes a change visible. `deploy.sh` handles it.

**Do not use `.htaccess` for cache headers.** The account's Apache has no
`mod_headers`, and a `Header set` directive produces a 500 on every CSS and
JS request.

**Watch the account.** `nfs-jentalent` (`talent_jentalent`) serves this
site. The `nfs` alias is a *different* account serving christalent.com, and
the docroot path is identical on both — deploying to the wrong one publishes
to the wrong site.

## Local development

There is no build step. To preview the static pages:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

The log page needs the PHP API, so it will not work from a plain static
server. Point a local PHP server at the project root instead.

## Tests

```bash
TZ=America/Los_Angeles node tests/log-logic.test.js
```

106 assertions: 65 unit + source-level checks, and 41 live API integration
tests that run only when `API_URL` is set:

```bash
API_URL=https://www.jentalent.com/api.php API_PIN=<pin> \
  TZ=America/Los_Angeles node tests/log-logic.test.js
```

The live layer covers auth rejection, the CRUD round-trip, validation
rejections, logout, and a full image round-trip.

## Repo conventions

- Single default branch: `master`
- Branch prefix for fixes/features: `fix/<slug>` / `feat/<slug>`
- PR description should include `Closes #N` for any issues it resolves
- Tracked issues live under the repo's Issues tab
- `OPEN-ITEMS.md` holds the long-form detail behind the open issues

## Layout

```
.
├── CHANGELOG.md      # what changed, and why
├── OPEN-ITEMS.md     # remaining work, in long form
├── README.md
├── deploy.sh         # version bump + syntax checks + rsync
├── index.html        # home
├── services.html     # service list + pricing
├── resume.html       # bio + experience
├── log.html          # the private notary log (uses log.js + api.php)
├── style.css         # shared styles
├── main.js           # mobile menu + smooth scroll
├── log.js            # notary log client
├── api.php           # notary log API: auth, CRUD, image storage
└── tests/
    └── log-logic.test.js
```
