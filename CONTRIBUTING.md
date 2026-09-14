# Contributing

Thanks for looking. Shelfy is deliberately small; the best contributions keep it that way.

## Ground rules

- **Zero build step, two runtime dependencies.** `ws` and `yjs` are the only things in `node_modules` at runtime.
  A PR that adds a framework, a bundler, or a native module will be declined no matter how good it is.
- **No inline scripts or styles.** Every page ships `script-src 'self'; style-src 'self'`. Build DOM with
  `createElement`/`textContent`; never `innerHTML` with anything user-controlled.
- **Single user, one shelf.** Accounts, sharing between users, folders, and rich text are out of scope
  (see the non-goals in [docs/SPEC.md](docs/SPEC.md)). Propose those as a fork, not a PR.
- **Every server change comes with a test.** `npm test` runs in a few seconds against a throwaway data dir.

## Getting started

```bash
git clone https://github.com/phineasfritsch/shelfy.git && cd shelfy
npm ci
PASSWORD=test DATA_DIR=./data npm start        # http://localhost:8080
npm test
```

Node 24 or newer. On Windows use `$env:PASSWORD='test'; $env:DATA_DIR='./data'; npm start`.

Open the app in a normal window and a private window (two sessions = two "devices") to try sync changes.
[docs/SPEC.md](docs/SPEC.md) §9 has a 27-step manual test script that covers everything the automated tests cannot.

## Layout

| Path | What lives there |
|---|---|
| `server.js` | entry point, wiring, graceful shutdown |
| `lib/config.js`, `lib/db.js`, `lib/log.js` | env parsing, SQLite schema, logger |
| `lib/auth.js`, `lib/routes-auth.js` | sessions, cookies, rate limiting, QR link |
| `lib/doc.js`, `lib/ws.js` | the Yjs document and the WebSocket relay |
| `lib/files.js`, `lib/routes-files.js`, `lib/routes-uploads.js` | file metadata, TTL sweeper, streaming and chunked uploads, downloads |
| `public/` | the browser code, served verbatim. `vendor/` and `icons/` are generated (`npm run vendor`, `npm run icons`) and committed |
| `public/textdiff.js` | the two pure functions that keep the caret still; unit-tested under node |
| `public/presence.js` | remote-caret / selection overlay for live presence |
| `test/` | `node --test` suites; `helpers.js` boots a real server on port 0 |
| `docs/` | design spec, module contracts, deployment, configuration, security |

## Regenerating vendored files

- `npm run vendor` after bumping `yjs` (bundles it to `public/vendor/yjs.js`) or `qrcode-generator`.
- `npm run icons` after changing `scripts/make-icons.mjs`.

Commit the output; the Docker image copies `public/` as-is.

## Pull requests

1. One change per PR, with a sentence on *why* in the description.
2. `npm test` green; `node --check` on anything you touched.
3. If the change is visible, say what you looked at in a browser (and on a phone if it is mobile-related).
4. Keep the tone of the docs: plain words, exact commands, no marketing.
