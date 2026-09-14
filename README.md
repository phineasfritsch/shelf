# Shelf

Shelf is one text box and a small pile of files that follow you between your phone and your computer. Open it on both, type on either, and the text is on the other device within a round trip — no refresh, no "sync" button, no lost keystrokes even when both sides type at once (the box is a Yjs CRDT; a device that was offline merges its edits on reconnect instead of overwriting anything). Drop, paste, pick or photograph a file and it appears on every device with a thumbnail; files delete themselves after a week unless you press *Keep*.

It is built to be the boring self-hosted thing you forget about: one Node process, one SQLite file, one volume, one container, one password. No framework, no build step, no accounts, no third-party requests at runtime. It is single-user by design — everyone who knows the password sees the same shelf.

## Quick start (Docker Compose)

```bash
git clone <this repo> shelf && cd shelf
docker compose up -d --build
docker compose logs -f shelf
```

With nothing configured the first boot generates a 20-character password, prints it once in the log (between `====` lines), and stores its scrypt hash at `/data/password.hash` on the volume so it survives restarts. Open `http://<host>:8080`, log in, done.

To pick your own password, hash it and put the hash in `docker-compose.yml`:

```bash
docker compose build                                   # builds the image tagged shelf:latest
docker run --rm -i shelf node scripts/hash-password.mjs
# Type the password, press Enter, then Ctrl-D. It prints:
# scrypt$32768$8$1$<salt>$<key>
```

or non-interactively (`printf` so no trailing newline is included — the script strips one anyway):

```bash
printf '%s' 'correct horse battery staple' | docker run --rm -i shelf node scripts/hash-password.mjs
```

Then in `docker-compose.yml`:

```yaml
    environment:
      PASSWORD_HASH: "scrypt$$32768$$8$$1$$<salt>$$<key>"
```

**Every `$` must be written as `$$`** — Compose interpolates `${VAR}` in the compose file (and, in Compose 2.24 and newer, in `env_file:` files too); `$$` is the escape for a literal dollar sign. If the hash arrives at the app with `$$` still in it, or with parts missing, the app refuses to start with `PASSWORD_HASH is not a valid scrypt$... string`. If you would rather not escape anything, use a secret file instead:

```yaml
    environment:
      PASSWORD_FILE: /run/secrets/shelf_password
    secrets: [shelf_password]
secrets:
  shelf_password:
    file: ./shelf_password.txt     # the scrypt$... hash, or just the plaintext password
```

The password only needs to be typed on a phone once; after that use **⋯ → Link a phone** (a QR code) to log other devices in, and sessions last a year of inactivity.

Changing the password (new hash, new file, new `PASSWORD`) logs every device out on the next start — that is intentional.

## Run locally without Docker

Requires Node 24 or newer (the image uses Node 26). The app uses `node:sqlite`, so there is nothing native to compile.

```bash
npm ci
PASSWORD=test DATA_DIR=./data node server.js        # bash / zsh
```

```powershell
npm ci
$env:PASSWORD='test'; $env:DATA_DIR='./data'; node server.js   # PowerShell
```

Then open `http://localhost:8080`. `PASSWORD` is hashed in memory at boot and removed from `process.env`; the log warns that `PASSWORD_HASH` is preferred. Generate a hash locally with `npm run -s hash-password` (reads stdin, never argv) or `node --env-file=.env server.js` with a copy of `.env.example`.

Other scripts: `npm test` (all suites, temp data dir, port 0), `npm run vendor` (rebuilds `public/vendor/*.js` after a yjs bump — commit the result), `npm run icons` (regenerates the PNG icons — commit them).

Only one process may use a `DATA_DIR` at a time. Never point two instances at the same directory or volume.

## Environment variables

All are read once at boot by `lib/config.js`; the effective configuration is logged with secrets redacted. An invalid value prints one line and exits 1. See `.env.example` for the same list in file form.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listen port. |
| `HOST` | `0.0.0.0` | Listen address. In Docker keep it on the loopback (`0.0.0.0` or `127.0.0.1`) or the `HEALTHCHECK` cannot reach `/healthz`. |
| `DATA_DIR` | `/data` | The single persistent directory: `shelf.db` (+ `-wal`, `-shm`), `files/`, `tmp/`, `text.txt`, `password.hash` (generated password) or `password.salt` (plaintext `PASSWORD`). Must be a local filesystem (SQLite; not NFS/SMB) and writable by the process, or boot fails with `DATA_DIR … is not writable by uid <n>`. |
| `PASSWORD_HASH` | — | Preferred. `scrypt$32768$8$1$<salt>$<key>` from `npm run -s hash-password`. |
| `PASSWORD_FILE` | — | Path to a file (Docker/Compose secrets). Trimmed contents are a hash if they start with `scrypt$`, otherwise the plaintext password. |
| `PASSWORD` | — | Plaintext convenience. Hashed in memory at boot, then deleted from the environment; logs a warning. |
| `SESSION_DAYS` | `365` | Sliding session lifetime. A device used at least once per period is never logged out. |
| `COOKIE_SECURE` | `auto` | `auto` = the cookie gets `Secure` when the request is HTTPS (TLS socket, or first `X-Forwarded-Proto` value is `https`); `true` / `false` force it. |
| `TRUST_PROXY` | `0` | `1` = trust `X-Forwarded-For` (rightmost entry = client IP) and `X-Forwarded-Host` from the proxy in front of Shelf. Does not affect `X-Forwarded-Proto`, which is always honoured (see *Security model*). Enable it **only** when the proxy is the sole way in: with the container port published directly, `1` lets any client spoof `X-Forwarded-For` and dodge the login limiter. |
| `ALLOWED_ORIGINS` | — | Comma-separated full origins (`https://shelf.example.com`) accepted by the CSRF/WebSocket Origin check in addition to the request's own host. Only needed when a proxy rewrites `Host` and you cannot set `TRUST_PROXY=1`. |
| `FILE_TTL_HOURS` | `168` | Default lifetime of an uploaded file (decimals allowed). `0` = never expire. *Keep* on a file exempts it. |
| `MAX_FILE_MB` | `2048` | Per-file upload cap (HTTP 413). Your proxy must allow request bodies this large. |
| `MAX_STORAGE_MB` | `0` | Total cap for stored files (HTTP 507 `storage_full`). `0` = unlimited. |
| `MAX_TEXT_KB` | `2048` | Text box cap, enforced by the client (sent in the WebSocket `hello`). |
| `SWEEP_INTERVAL_SEC` | `60` | Cadence of the sweeper that unlinks expired files and prunes stale sessions, login attempts and link tokens. |
| `LOGIN_MAX_FAILS` | `5` | Failed logins per client IP within the window before HTTP 429 with `Retry-After`. Persisted in SQLite, so it survives restarts. |
| `LOGIN_WINDOW_MIN` | `15` | Sliding window for the above. |
| `SHUTDOWN_TIMEOUT_SEC` | `20` | Max wait for in-flight uploads on `SIGTERM`/`SIGINT`. The process hard-exits 5 s after that. |
| `APP_NAME` | `Shelf` | Name in the page title and `GET /api/me` (max 40 chars). |
| `LOG_JSON` | `0` | `1` = JSON lines on stdout instead of text lines. |

Password resolution order: `PASSWORD_HASH` → `PASSWORD_FILE` → `PASSWORD` → `DATA_DIR/password.hash` → generate and print. Environment always wins over the file on the volume; there is never a built-in default password.

## Reverse proxy

Shelf speaks plain HTTP and expects TLS to be terminated in front of it. It needs three things from the proxy: WebSocket upgrades on `/ws`, `X-Forwarded-Proto` (so the session cookie gets `Secure`), and request bodies as large as `MAX_FILE_MB`. Set `TRUST_PROXY=1` so the login rate limiter sees real client IPs, and remove the `ports:` mapping from compose once only the proxy network reaches the container.

Do not strip or rewrite response headers: `Content-Security-Policy`, `Content-Disposition`, `X-Content-Type-Options` and `Cross-Origin-Resource-Policy` on file downloads are what keep an uploaded HTML/SVG file inert.

### Caddy

```
shelf.example.com {
    reverse_proxy shelf:8080
}
```

WebSocket upgrade, `X-Forwarded-Proto`/`X-Forwarded-For` and unlimited bodies are Caddy's defaults. With [caddy-docker-proxy](https://github.com/lucaslorentz/caddy-docker-proxy) use the commented labels in `docker-compose.yml`.

### Traefik

```yaml
    labels:
      traefik.enable: "true"
      traefik.http.routers.shelf.rule: "Host(`shelf.example.com`)"
      traefik.http.routers.shelf.entrypoints: "websecure"
      traefik.http.routers.shelf.tls.certresolver: "letsencrypt"
      traefik.http.services.shelf.loadbalancer.server.port: "8080"
```

Traefik forwards WebSockets and sets `X-Forwarded-*` by default and does not limit body size unless you add a `buffering` middleware — do not.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name shelf.example.com;
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        client_max_body_size 0;
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

`client_max_body_size 0` removes nginx's 1 MB default body cap (or set it to at least `MAX_FILE_MB`); `proxy_request_buffering off` streams uploads through instead of spooling them to nginx's disk first, which is what makes the progress bar truthful; `proxy_read_timeout 3600s` keeps idle WebSockets open (the app pings every 20–25 s, so even the 60 s default would survive, but long downloads benefit).

### Cloudflare

Cloudflare's proxy (orange cloud) caps request bodies at 100 MB on most plans; uploads above that fail with "Blocked by reverse proxy". Use a Tunnel with the record DNS-only, or accept the limit.

## Bind mounts and the container uid

The container runs as the unprivileged `node` user, uid/gid **1000**. A named volume (the default in `docker-compose.yml`) inherits the right ownership from the image's `/data`. For a bind mount, either make the host directory writable by that uid:

```bash
mkdir -p ./data && sudo chown -R 1000:1000 ./data
```

or run the container as the host directory's owner:

```yaml
    user: "1000:1000"        # or "$(id -u):$(id -g)"
    volumes:
      - ./data:/data
```

If neither is done the container exits immediately with `DATA_DIR /data is not writable by uid 1000`.

## Backup and restore

Everything lives under `/data`: the SQLite database (text log, snapshots, file metadata, sessions), the file blobs and thumbnails under `files/`, the plain-text mirror `text.txt`, and `password.hash` if it was generated. Back up the whole directory.

Consistent backup (stop the app so the SQLite WAL is checkpointed and no upload is half-written):

```bash
docker compose stop shelf
docker run --rm -v shelf_shelf-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/shelf-$(date +%F).tgz -C /data .
docker compose start shelf
```

(Compose names the volume `<project>_shelf-data`, where `<project>` is the folder you ran `docker compose` in — `shelf_shelf-data` if you cloned into `shelf/`; `docker volume ls` shows the real name. With a bind mount, `tar czf shelf.tgz -C ./data .` is enough.) Live backups with restic or `sqlite3 /data/shelf.db ".backup /tmp/shelf.db"` plus a copy of `files/` also work; the WAL mode database is safe to read while the app runs.

Restore: stop the app, then untar into the (empty) volume and hand it back to uid 1000:

```bash
docker compose stop shelf
docker run --rm -v shelf_shelf-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/shelf-2026-01-31.tgz -C /data && chown -R 1000:1000 /data'
docker compose start shelf
``` Files that expired while the backup sat on the shelf are swept on the first boot. If you only have `text.txt` (a hand restore), drop it into an otherwise empty `/data`: when the document log is empty the box is seeded from it.

## Upgrade

```bash
git pull
docker compose up -d --build        # add --pull always to refresh the node:26-alpine base too
```

The app keeps at most one schema version and refuses to start on a database written by a newer version (`schema_version` in the `meta` table), so downgrading means restoring a backup. Restarts are graceful: `/healthz` returns `503` as soon as `SIGTERM` arrives so a proxy stops routing, WebSocket clients get `{"t":"bye","reason":"shutdown"}` and reconnect on their own, in-flight uploads get `SHUTDOWN_TIMEOUT_SEC` to finish, and the text is compacted and mirrored to `text.txt` before the database closes. Nobody is logged out by an upgrade. Nothing on the client is cached by a service worker, so the new front end is served on the next page load.

## Phone setup

**Add to home screen.** Open Shelf in the phone browser, log in, then *Share → Add to Home Screen* (iOS Safari) or *⋮ → Install app / Add to Home screen* (Android Chrome). Both give a standalone full-screen app with its own icon.

**Log in with a QR code instead of typing.** On a device that is already logged in, open **⋯ → Link a phone**. It shows a QR code (and the same URL as text) that is valid for 5 minutes and works exactly once. Scan it with the phone camera; the phone opens `https://your-shelf/#link=…`, is redirected to the login page, and the page claims the token and logs the phone in without a password. A second scan of the same code says the link has expired. The token only ever travels in the URL fragment, so it never appears in proxy logs or `Referer` headers; a bad token counts as a failed login for rate-limiting.

**iOS note.** An installed home-screen app has its own cookie jar, separate from Safari. Log in once *inside* the installed app (password or the QR link), or open the QR URL in Safari first and add to the home screen from the logged-in tab — the session is carried across at install time.

**Sharing into Shelf.** Every platform: the *Add files* and *Camera* buttons, paste (a screenshot on the clipboard becomes `paste-<timestamp>.png`), and drag-and-drop on desktop. **Android/Chrome only:** once the app is installed over HTTPS it also appears in the system share sheet; shared files and text are handed to the page, which uploads them with real progress (if the session had expired you are asked to log in first and the shared items are uploaded afterwards). iOS does not offer Web Share Target, so on an iPhone the paths are the picker, the camera and paste. The *Share* button on a file card (send a file out to another app) works on both platforms where `navigator.share` supports files.

## Security model

- **Authentication.** One password, hashed with `scrypt` (N=32768, r=8, p=1, 16-byte salt). A successful login creates a random 32-byte session token; only `sha256(token)` is stored, so the database never contains anything that logs a device in. Sessions slide: a device used at least once per `SESSION_DAYS` stays logged in. **⋯ → Devices** lists sessions by device/browser and revokes them individually (their WebSockets close immediately); **Log out everywhere** deletes them all; a password change revokes them all at the next start.
- **Cookie.** `sid=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=<SESSION_DAYS>[; Secure]`. `Secure` is added automatically when the request arrived over TLS or with `X-Forwarded-Proto: https`. That header is honoured even without `TRUST_PROXY` because spoofing it can only make the spoofer's own cookie stricter; the upside is that `http://192.168.1.10:8080` on your LAN works with zero configuration and Caddy/Traefik/nginx over HTTPS produce a `Secure` cookie with zero configuration.
- **Brute force.** Per-IP limit (`LOGIN_MAX_FAILS` in `LOGIN_WINDOW_MIN`, persisted, `429` + `Retry-After`) plus a global in-memory token bucket (30 attempts, refilling one per 2 s) that slows distributed guessing without ever locking the owner out. Every attempt is logged with IP and device label. Behind a proxy set `TRUST_PROXY=1` or every visitor shares the proxy's IP.
- **CSRF.** No tokens; three layers instead: `SameSite=Lax` cookies, an `Origin` check on every non-GET request and on the WebSocket upgrade (`403 bad_origin` on mismatch; requests without `Origin` pass only with `Sec-Fetch-Site: same-origin`/`none`), and JSON endpoints that require `Content-Type: application/json`.
- **WebSocket.** The upgrade is authenticated with the cookie and the `Origin` header before the handshake completes; an unauthenticated socket never opens. Sessions are re-checked every 60 s as a backstop to immediate revocation.
- **Content security.** Every HTML page carries `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; … frame-ancestors 'none'; base-uri 'none'` — no inline scripts or styles anywhere — plus `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and `Cache-Control: no-store` on HTML and `/api/*`.
- **Uploaded files.** Downloads (`/f/<id>/<name>`) require the session cookie — an old link pasted into a logged-out browser lands on the login page. Files are served with `Content-Security-Policy: sandbox` (except PDFs, which cannot script against the origin anyway), `nosniff`, `Cross-Origin-Resource-Policy: same-origin`, and are rendered inline only for a short allowlist (common images, mp4/webm/mov, audio, PDF, plain text); everything else — including SVG, HTML and HEIC — is a forced download. Blobs are stored without their names or extensions; the original name lives only in the database. The server never parses multipart and has no image libraries; thumbnails are made by the uploading browser.
- **Not protected / out of scope.** Shelf does not do TLS itself: on plain `http://` the password and the cookie cross the network in clear, which is fine on a trusted LAN and not fine on the internet — put it behind an HTTPS proxy for anything beyond your own Wi-Fi. There is no encryption at rest, no second factor, no per-user separation (anyone with the password sees and can delete everything), no public or capability share links, and no audit trail beyond the log. The client keeps a copy of the text in `localStorage` (cleared on logout/revoke) so a browser on a shared computer holds the text until then. Nothing is ever sent to a third-party origin.

## Troubleshooting

**Login "works" but immediately returns to the login page.** The browser is dropping the cookie. Almost always the cookie has `Secure` but the page is loaded over plain `http://`: you set `COOKIE_SECURE=true` (put it back to `auto`, the default, or `false`), or something in front of Shelf adds `X-Forwarded-Proto: https` on an http hop. Check the `Set-Cookie` header in DevTools → Network → `/api/login`.

**`403 {"error":"bad_origin"}` on login, or the WebSocket never connects (pill stuck on *Reconnecting…*).** The `Origin` the browser sends does not match the `Host` the app sees. When a proxy rewrites `Host`, set `TRUST_PROXY=1` (it will then use `X-Forwarded-Host`) or list the public origin in `ALLOWED_ORIGINS=https://shelf.example.com`. A WebSocket that fails while plain requests work means the proxy is not forwarding the upgrade — see the nginx block above (`proxy_http_version 1.1`, `Upgrade`, `Connection "upgrade"`).

**Uploads fail with "Blocked by reverse proxy (body size limit?)".** The proxy rejected the body before Shelf saw it: nginx `client_max_body_size` (default 1 MB), Cloudflare's 100 MB cap, a Traefik `buffering` middleware, or a request timeout on a slow link. Shelf's own limit is `MAX_FILE_MB` and shows as "Too large (limit N MB)" instead. "Storage full" means `MAX_STORAGE_MB` is reached — delete something or raise it.

**`DATA_DIR /data is not writable by uid 1000` on start.** Bind-mounted directory owned by someone else. `chown -R 1000:1000` it or set `user:` in compose (see *Bind mounts*). On a named volume this only happens if you previously ran the container as root against the same volume; `docker run --rm -v <volume>:/data alpine chown -R 1000:1000 /data` fixes it.

**`PASSWORD_HASH is not a valid scrypt$... string`.** The `$` characters were eaten (compose needs `$$`; a shell needs single quotes) or the value was cut. Compare with the output of `hash-password` — it has six `$`-separated parts and starts with `scrypt$`. Or switch to `PASSWORD_FILE`.

**"Too many attempts — try again in N s".** Five wrong passwords from one IP within 15 minutes. The counter is persisted, so a restart does not reset it; wait it out, or lower/raise `LOGIN_MAX_FAILS`/`LOGIN_WINDOW_MIN`. Behind a proxy without `TRUST_PROXY=1` every visitor counts against the same IP.

**Forgot the password.** If it came from `PASSWORD_HASH`/`PASSWORD`/`PASSWORD_FILE`, set a new one and restart. If it was generated, delete `/data/password.hash` and restart: a new one is generated and printed. Either way all devices are logged out.

**Container shows `unhealthy`.** The healthcheck fetches `http://127.0.0.1:$PORT/healthz` inside the container. It fails if `HOST` is set to an address other than `0.0.0.0`/`127.0.0.1`, or for the last seconds of a graceful shutdown (by design, so the proxy drains). `docker compose logs shelf` shows why the app is not up; `/healthz` itself returns `{"ok":true,"draining":false,"files":N,"clients":N,"uptime":S}` and needs no login.

**Text looks stale on one device.** The pill in the header tells you the state: *Saving…* has unacknowledged edits, *Reconnecting…* has no socket, *Offline* means the browser reports no network. Edits made in any of those states are kept locally and merged when the socket is back; nothing is lost by waiting. If a tab has been open across an upgrade, reload it once.

## Layout of the repo

`server.js` is the entry point; `lib/` is the server (config, SQLite, auth, HTTP, static files, routes, the Yjs document, files, WebSocket); `public/` is the browser code served verbatim (with pre-built `vendor/yjs.js`, `vendor/qrcode.js` and the icons committed); `scripts/` holds the one-off generators and `hash-password.mjs`; `test/` runs with `node --test`. `docs/SPEC.md` is the design document.

## License

See the repository for license terms.
