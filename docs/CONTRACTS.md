# Module contracts (build-time reference)

The spine (`server.js`, `lib/config.js`, `lib/log.js`, `lib/db.js`, `lib/password.js`, `lib/auth.js`, `lib/http.js`, `lib/static.js`, `lib/routes-auth.js`) is written and smoke-tested. Everything else is built against these contracts. `docs/SPEC.md` is the product/design spec; where this file and the spec disagree on an *interface*, this file wins; on *behaviour*, the spec wins.

## Ground rules for every module

- ESM (`"type": "module"`), Node ≥ 24. Runtime deps are **only** `ws` and `yjs` (server) - nothing else may be imported from `node_modules` at runtime. Browser code imports yjs from `./vendor/yjs.js` (already generated; exports the full `yjs` API: `Doc`, `Text`, `UndoManager`, `applyUpdate`, `encodeStateAsUpdate`, `encodeStateVector`, …). `./vendor/qrcode.js` exists as an ESM module with `export default qrcode` (qrcode-generator 2.x API: `const qr = qrcode(0, 'M'); qr.addData(str); qr.make(); qr.createSvgTag({ cellSize: 4, margin: 2 })`).
- Browser code runs under CSP `script-src 'self'; style-src 'self'` - **no inline `<script>`, no inline `style=""` attributes, no `onclick=` attributes, no `eval`**. Setting `el.style.width = '…'` from JS is fine (CSSOM), `el.setAttribute('style', …)` is not. Use classes for everything else.
- Build DOM with `document.createElement` / `textContent`; never `innerHTML` with user-controlled strings (file names, text).
- Timers on the server must be `.unref()`'d so tests and shutdown are not held open.
- Do not touch files owned by another builder. Do not run `npm install`. Run `node --check <file>` on every file you write. You may run the server on a random port to try things: `PASSWORD=test DATA_DIR=./.tmp-data-<yourname> PORT=0 node server.js` (the `listening` log line prints the port) - delete that dir when done. Note: until every module exists, `server.js` will fail to import; test your module in isolation with a small script if needed.
- Windows dev box: paths may contain backslashes; use `node:path`. No `sqlite3` CLI is installed - use `node:sqlite` from a script if you need to inspect the DB.

## Spine API you can rely on

### `lib/http.js`
```js
router.add(method, pattern, handler, opts)   // pattern '/api/files/:id'; handler(req, res, ctx)
// ctx = { params, query: URLSearchParams, url: URL, session|null, cfg, log }
// opts.auth: 'api' (default, 401 JSON) | 'page' (302 /login) | 'file' (302 if Accept has text/html, else 401) | 'none'
// opts.origin: true (default: Origin/Sec-Fetch-Site check on non-GET/HEAD → 403) | false
// The server already: authenticates, checks origin, slides the session cookie, catches HttpError → JSON, logs 500s.
json(res, status, body, headers?)   empty(res, status=204, headers?)   redirect(res, location, status=302)
readJson(req, { maxBytes }) → Promise<object>   (requires Content-Type: application/json)
new HttpError(status, code, message?, headers?)
parseCookies(req) → object     isHttps(req)     expectedHost(req, cfg)     originOk(req, cfg)     clientIp(req, cfg)     wantsHtml(req)
securityHeaders(res, { html, req, cfg })
```
Static files under `public/` are served automatically for any GET/HEAD path not matched by a route (except `index.html`/`login.html`, which `routes-auth.js` serves with auth gating). `/healthz` is built in.

### `lib/auth.js` (`auth` object)
```js
auth.authenticate(req) → Promise<session|null>   // session = { idHash, createdAt, lastSeenAt, ua, token }
auth.sessionExists(idHash) → boolean               // for the WS 60 s revalidation
auth.onSessionsRevoked = (idHashes: string[] | '*', reason) => void   // set by ws.js; server.js already wires it to ws.closeSessions
auth.listSessions(currentIdHash), auth.revokeByPrefix(prefix), auth.revokeAll(), auth.deleteSession(idHash)
auth.clientIp(req), auth.checkLoginAllowed(ip), auth.recordLoginFailure(ip), auth.recordLoginSuccess(ip)
auth.createLinkToken() → { token, expiresAt }, auth.claimLinkToken(token) → boolean
auth.prune(now)
```

### `lib/db.js` (`db` object)
```js
db.prepare(sql) → node:sqlite StatementSync (.run/.get/.all)   db.exec(sql)   db.transaction(fn) → fn's return (BEGIN IMMEDIATE…COMMIT, rollback on throw)
db.meta.get(key) / .set(key, value) / .del(key)
```
Schema (already created): `meta`, `sessions`, `login_attempts`, `link_tokens`, `doc_updates(seq, data BLOB)`, `snapshots(id, at, len, text)`, `files(id, name, size, mime, created_at, expires_at, has_thumb)`. Timestamps are ms since epoch. BLOBs go in/out as `Uint8Array`.

### `cfg` (from `lib/config.js`) - fields you need
`port, host, dataDir, filesDir, tmpDir, textMirrorFile, dbFile, appName, sessionMs, fileTtlMs (null = never expire), maxFileBytes, maxStorageBytes (null = unlimited), maxTextChars, maxTextKb, maxFileMb, fileTtlHours, maxStorageMb, sweepIntervalSec, shutdownTimeoutSec, trustProxy, allowedOrigins (Set), snapshotQuietMs (default 30000, tests override)`.

### `log` (from `lib/log.js`)
`log.info(msg, fields?)`, `.warn`, `.error`, `.debug`, `.child(name)`. Put an `Error` under the `err` field.

### `server.js`
```js
import { start } from '../server.js';
const app = await start({ DATA_DIR, PASSWORD: 'test', PORT: 0, FILE_TTL_HOURS: '0.0003', SWEEP_INTERVAL_SEC: '1', snapshotQuietMs: 200, logger });
// app = { port, cfg, log, db, auth, doc, files, ws, server, close({ reason, timeoutMs }) → Promise }
```
Wiring order in `server.js`: `createDoc` → `createFiles` → routes (`registerAuthRoutes`, `registerFileRoutes`, `registerHistoryRoutes`) → `createHttpServer` → `createWs` → `auth.onSessionsRevoked = ws.closeSessions` → `files.reconcile()`; sweeper calls `files.sweep()` + `auth.prune()` every `sweepIntervalSec`. Shutdown: `ws.shutdown(reason)` → `doc.flush()` → wait `files.inFlight()` → `doc.close()` → `db.close()`. `healthz` reports `files.count()` and `ws.clientCount()`.

---

## Contracts for modules to be built

### `lib/doc.js` - `createDoc({ cfg, db, log })`
```js
{
  ydoc,                                  // Y.Doc (gc on)
  ytext,                                 // ydoc.getText('t')
  applyUpdate(update: Uint8Array, origin: any),  // Y.applyUpdate; throws on malformed input (caller closes the socket with 4000)
  stateVector(): Uint8Array,             // Y.encodeStateVector(ydoc)
  diff(sv: Uint8Array | null): Uint8Array,   // Y.encodeStateAsUpdate(ydoc, sv)
  subscribe(fn: (update: Uint8Array, origin: any) => void): () => void,  // fires for every ydoc 'update' event AFTER the update row is persisted
  getText(): string,
  history: { list(): Array<{ id, at, len, preview }>, get(id): { id, at, text } | null },
  flush(): void,                         // synchronous: write text.txt mirror now; compact if due. Called on shutdown.
  close(): void,                         // clear timers
}
```
Behaviour per SPEC §5 "Server state and handling" and "Text history": load `doc_updates` in seq order with origin `'load'` before attaching the update listener; seed from `text.txt` when there are no rows but the file exists; `ydoc.on('update')` → `INSERT INTO doc_updates(data)` synchronously → count rows, compact (`DELETE` all + insert one `encodeStateAsUpdate`) inside `db.transaction` when rows > 2000 or bytes > 4 MB → notify subscribers → schedule mirror (1 s debounce, write `text.txt.tmp` then `rename`) → schedule snapshot (`cfg.snapshotQuietMs` quiet period; skip if identical to last; keep newest 50; trim while total text > 20 MB). Preview = first 80 chars, newlines → spaces. Timers `unref()`'d.

### `lib/files.js` - `createFiles({ cfg, db, log })`
```js
{
  list(): { files: FileMeta[], usedBytes: number },   // newest first, excludes expired rows
  count(): number,
  get(id): FileMeta | null,                            // null if unknown OR expired (expires_at <= now)
  newId(): string,                                     // randomBytes(12).toString('base64url') - 16 chars, matches /^[A-Za-z0-9_-]{16}$/
  sanitizeName(name): string,                          // strip / \ and control chars, trim, cap 200, default 'file'
  sanitizeMime(type): string,                          // must match /^[\w.+-]+\/[\w.+-]+$/ else 'application/octet-stream'; lowercase
  blobPath(id), thumbPath(id), tmpPath(id): string,    // DATA_DIR/files/<id>, DATA_DIR/files/<id>.thumb.jpg, DATA_DIR/tmp/<id>
  insert({ id, name, size, mime }): FileMeta,          // created_at = now, expires_at = now + cfg.fileTtlMs (null when fileTtlMs is null); emits change
  setThumb(id): FileMeta | null,                       // has_thumb = 1; emits change
  setKeep(id, keep: boolean): FileMeta | null,         // keep → expires_at NULL; unkeep → now + ttl (or NULL if ttl disabled); emits change
  remove(id): boolean,                                 // unlink blob + thumb (ENOENT tolerated) THEN delete row; emits change
  sweep(): { removed: number, bytes: number },         // expired rows: unlink then delete; emits change if removed > 0; logs 'sweep: removed N files (M bytes)'
  reconcile(): void,                                   // boot: unlink blobs without rows (ignore *.thumb.jpg whose base has a row), delete rows without blobs, empty tmp/
  usedBytes(): number,
  inFlight(): number, beginUpload(): void, endUpload(): void,
  onChange(fn: () => void): () => void,                // after any change (insert/thumb/keep/remove/sweep)
  toMeta(row): FileMeta,
}
// FileMeta = { id, name, size, mime, createdAt, expiresAt: number|null, hasThumb: boolean }
```

### `lib/routes-files.js` - `registerFileRoutes({ router, cfg, files, log })`
Endpoints exactly as SPEC §6 "Endpoints" and "Download response":
- `PUT /api/files?name=&type=` - raw body streamed to `files.tmpPath(id)`; `Content-Length` required (411); `> cfg.maxFileBytes` → 413 before reading; storage cap → 507 `{error:'storage_full'}`; byte counter destroys the request at declared length + 1 (400); on end `fsync` → `rename` to `blobPath` → `files.insert` → 201 FileMeta. Any error → unlink tmp. Wrap in `files.beginUpload()/endUpload()`.
- `PUT /api/files/:id/thumb` - `image/jpeg` ≤ 200 KB → `thumbPath`, `files.setThumb`, 204.
- `PATCH /api/files/:id` `{keep}` → 200 FileMeta. `DELETE /api/files/:id` → 204. `GET /api/files` → `{files, usedBytes}`.
- `GET|HEAD /f/:id/:name[?dl=1]` (`auth: 'file'`) - 404 when unknown/expired; headers: `Content-Type`, `Content-Length`, `Accept-Ranges: bytes`, single-range 206/416, `ETag: "<id>"`, `Cache-Control: private, max-age=86400`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `Content-Security-Policy: sandbox` (except `application/pdf`), `Content-Disposition: inline` only for the allowlist (png/jpeg/gif/webp/avif, mp4/webm/quicktime, audio/*, pdf, text/plain) else `attachment`; `?dl=1` forces attachment; always both `filename="<ascii>"` and `filename*=UTF-8''<enc>`.
- `GET /f/:id/thumb` (`auth: 'file'`) - the JPEG or 404.
- `POST /share` → 303 `/`, `GET /share` → 302 `/` (`auth: 'none'`, `origin: false`).
Route ids must match `/^[A-Za-z0-9_-]{16}$/` (400 otherwise).

### `lib/routes-history.js` - `registerHistoryRoutes({ router, cfg, doc, log })`
`GET /api/history` → `doc.history.list()`; `GET /api/history/:id` → `doc.history.get(id)` or 404.

### `lib/ws.js` - `createWs({ cfg, log, server, auth, doc, files })`
```js
{
  clientCount(): number,
  broadcastJson(obj, exceptWs?): void,
  broadcastFiles(): void,                    // {t:'files', ...files.list()} to every socket
  closeSessions(idHashes: string[] | '*', reason: string): void,   // send {t:'bye',reason} then close 4001
  shutdown(reason: string): void,            // {t:'bye',reason:'shutdown'} + close 1001 to all; stop timers
}
```
Behaviour per SPEC §4 "WebSocket auth" and §5 "Wire format"/"Server state and handling": `new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 })`; on `server.on('upgrade')`: path must be `/ws` (else 404), `await auth.authenticate(req)` (else raw `HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n` + destroy), `originOk(req, cfg)` **and** `Origin` header present (else 403 raw + destroy), then `handleUpgrade`. Per socket: `{ session, alive, sidHash }`. On open: send `hello` (`proto: 1, now, limits: { maxFileMB: cfg.maxFileMb, ttlHours: cfg.fileTtlHours, maxTextKB: cfg.maxTextKb, storageMB: cfg.maxStorageMb }, peers`), then binary `0x00‖stateVector`, then `files`, then broadcast `peers` to all. Binary `0x01‖update` → `doc.applyUpdate(u, ws)` (catch → `{t:'error'}` + close 4000) → always send `{t:'ack'}`. Binary `0x00‖sv` → send `0x01‖doc.diff(sv)` then `{t:'synced'}`. `doc.subscribe((u, origin) => broadcast 0x01‖u to every socket except origin)`. `files.onChange(broadcastFiles)`. JSON `ping` → `pong`. Server `ws.ping()` every 25 s, `terminate()` if no pong since last ping. Every 60 s: close sockets whose `auth.sessionExists(sidHash)` is false with 4001. On close: broadcast `peers`. Malformed JSON/unknown tag → close 4000. Never log tokens.

### `public/textdiff.js`
Exactly the two pure functions from SPEC §5 "Textarea binding": `export function splice(oldS, newS, caret)` and `export function shiftSelection(s, e, delta)`. Also `export function findUrls(text) → string[]` (http(s) URLs, deduped, max 20).

### `public/net.js` - `createNet({ doc, isComposing: () => boolean })`
```js
net.connect(); net.close();
net.on(event, fn) → unsubscribe
//  'status'  (status)  status ∈ 'connecting'|'live'|'saving'|'reconnecting'|'offline'
//  'hello'   ({ proto, now, limits, peers })
//  'synced'  ()
//  'files'   ({ files, usedBytes })
//  'peers'   ({ n })
//  'bye'     ({ reason })
//  'remote'  (update)   - after a remote update was applied to doc (or queued during composition)
net.status; net.limits; net.peers; net.serverNow() → ms (Date.now() + skew from hello); net.flushPending(); net.connected → boolean
```
Owns SPEC §5 "Client" and "Heartbeat"/"Reconnect": handshake state (`synced`, `sentStep2`, `unacked`), `doc.on('update')` → send `0x01` when origin is not `'remote'`/`'load'` and `sentStep2`, `pendingRemote` queue while `isComposing()`, ping 20 s / dead-after 30 s, backoff 500 ms → 10 s ± 20 %, reconnect on `online`/`pageshow`/`focus`/`visibilitychange`, close 4001 → clear `localStorage` keys starting with `shelf.` and `location.replace('/login')`, proto mismatch → one guarded reload. Also `localStorage` persistence of the doc (`shelf.doc`, base64, 300 ms debounce) lives here (`net.restoreLocal()` before connect - call it from app.js before the initial paint).

### `public/editor.js` - `createEditor({ doc, ytext, textarea, net, maxTextChars, toast })`
```js
editor.composing → boolean
editor.undo(); editor.redo()
editor.clear() → string (the text that was cleared, for the Undo toast)
editor.insertAtCaret(text); editor.append(text)   // origin 'ui'; append adds a leading '\n' if the doc is non-empty and does not end with one
editor.copyAll() → Promise<boolean>              // navigator.clipboard with execCommand fallback (SPEC §7 "Copy button")
editor.getText() → string
editor.onChange(fn) → unsubscribe                 // after any doc change (local or remote)
editor.focusDesktop()                              // autofocus only on (hover:hover) and (pointer:fine)
```
Implements SPEC §5 "Textarea binding", "IME / composition", "Undo": initial paint (`textarea.value = ytext.toString()` once), `input` → `splice` → transact origin `'local'`; `ytext.observe` delta walk with `setRangeText` + `shiftSelection` + scrollTop restore + divergence guard; composition queueing (calls `net.flushPending()` on `compositionend` (setTimeout 0) and `blur`); `Y.UndoManager` with `trackedOrigins: new Set(['local','ui'])`, `captureTimeout: 500`; intercept Ctrl/Cmd+Z, Shift+Z, Ctrl+Y and `beforeinput` historyUndo/historyRedo.

### `public/uploads.js` - `createUploads({ getLimits: () => ({ maxFileMB }), toast, onChange: (items) => void })`
```js
uploads.enqueue(files: Iterable<File>)   // renames unnamed pasted blobs to paste-YYYY-MM-DD-HH-mm-ss.<ext>
uploads.items → Array<{ id, name, size, state: 'queued'|'uploading'|'done'|'error', loaded, total, rate, error, file, serverId }>
uploads.cancel(id); uploads.retry(id); uploads.dismiss(id)
```
SPEC §6 "Upload queue UI" and "Client uses XMLHttpRequest": concurrency 2, FIFO, `PUT /api/files?name=<enc>&type=<mime>` with `Content-Type: file.type || application/octet-stream`, `xhr.upload.onprogress`, rate = bytes/s over a 1 s window, error mapping (413 → "Too large (limit N MB)", 507 → "Storage full", 401 → redirect `/login`, 0 → "Connection lost", other → "Blocked by reverse proxy (body size limit?)"), on 201 for `image/*`: client thumbnail via `createImageBitmap(file, { imageOrientation: 'from-image' })` (fallback `<img>` + `decode()`), long edge ≤ 320, `canvas.toBlob('image/jpeg', 0.7)`, `PUT /api/files/:id/thumb` if ≤ 200 KB. Done items are removed from `items` once the server's file list contains `serverId` (app.js calls `uploads.reconcile(serverFiles)`).

### `public/files-view.js` - `createFilesView({ container, uploads, serverNow, toast, api })`
```js
// api = { remove(id) → Promise, keep(id, keep) → Promise }  (app.js implements with fetch; 401 → /login)
view.setFiles(files, usedBytes); view.render()
```
SPEC §7 layout item 4: grid of upload cards (progress, MB/s, Cancel/Retry) and file cards (thumb `<img loading="lazy" src="/f/<id>/thumb">` or MIME icon, middle-ellipsised name, size, "deletes in 6d 3h"/"kept" countdown via `serverNow()`, red under 12 h, refreshed every 60 s), actions: Open (`/f/<id>/<name>` in new tab for inline-allowlist types), Download (`?dl=1`), Share (when `navigator.canShare?.({ files: [new File([], 'x')] })`, fetches the blob, ≤ 100 MB), Copy link, Keep/Unkeep, Delete (greys out, toast "Deleted - Undo" 5 s, DELETE sent when the toast expires). Empty state text when there are no files.

### `public/app.js`, `public/index.html`, `public/login.html`, `public/login.js`, `public/app.css`, `public/manifest.webmanifest`, `public/sw.js`
Built last, against the real code of the modules above. SPEC §7 in full (layout, status pill, toolbar, URL chips, menu sheets: History / Devices / Link a phone / Storage / Log out / Log out everywhere, toasts, PWA manifest, share-target SW, `--vh` from `visualViewport`, dark mode, reduced motion). `index.html` must reference `/app.css`, `<script type="module" src="/app.js">`, the manifest, icons (`/icons/icon.svg`, `/icons/apple-touch-icon.png`), `theme-color`. `login.html` shares `app.css` and loads `/login.js`. App name is `Shelf` (static in HTML; `hello` does not carry it - use `GET /api/me` `{ appName }` if needed, or just hardcode "Shelf").

### `test/` - `node --test test/`
`test/helpers.js` exports `startTestServer(overrides)` → `{ app, base, port, login(password='test') → Promise<cookie string 'sid=…'>, fetch(path, { cookie, ...init }), ws(cookie, { origin }) → Promise<WebSocket (from 'ws')>, stop() }` using a fresh `mkdtemp` DATA_DIR, `PORT: 0`, `PASSWORD: 'test'`, `HOST: '127.0.0.1'`, silent logger. Suites per SPEC §9 "npm test asserts". Use `node:test` + `node:assert/strict`. Each test file starts its own server and stops it in `after()`. Keep every test under 10 s; tune knobs (`FILE_TTL_HOURS`, `SWEEP_INTERVAL_SEC`, `snapshotQuietMs`) rather than sleeping long.
