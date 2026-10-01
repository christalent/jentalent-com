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
