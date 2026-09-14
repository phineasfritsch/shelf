# Configuration

Everything is an environment variable, read once at boot by `lib/config.js`. The effective configuration is
logged at startup with secrets redacted. An invalid value prints one line and exits 1. `.env.example` has the same
list in file form (`node --env-file=.env server.js`, or `env_file:` in compose).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listen port. |
| `HOST` | `0.0.0.0` | Listen address. In Docker keep it on `0.0.0.0` or `127.0.0.1`, or the `HEALTHCHECK` cannot reach `/healthz`. |
| `DATA_DIR` | `/data` | The single persistent directory: `shelf.db` (+ `-wal`, `-shm`), `files/`, `tmp/`, `text.txt`, and `password.hash` (generated password) or `password.salt` (plaintext `PASSWORD`). Must be a local filesystem (SQLite; not NFS/SMB) and writable by the process, or boot fails with `DATA_DIR … is not writable by uid <n>`. |
| `PASSWORD_HASH` | — | Preferred. `scrypt$32768$8$1$<salt>$<key>` from `npm run -s hash-password`. |
| `PASSWORD_FILE` | — | Path to a file (Docker/Compose secrets). Trimmed contents are a hash if they start with `scrypt$`, otherwise the plaintext password. |
| `PASSWORD` | — | Plaintext convenience. Hashed in memory at boot (with a salt persisted at `DATA_DIR/password.salt` so restarts do not log devices out), then deleted from the environment; logs a warning. |
| `SESSION_DAYS` | `365` | Sliding session lifetime. A device used at least once per period is never logged out. |
| `COOKIE_SECURE` | `auto` | `auto` = the cookie gets `Secure` when the request is HTTPS (TLS socket, or first `X-Forwarded-Proto` value is `https`); `true` / `false` force it. |
| `TRUST_PROXY` | `0` | `1` = trust `X-Forwarded-For` (rightmost entry = client IP) and `X-Forwarded-Host` from the proxy in front of Shelf. Does not affect `X-Forwarded-Proto`, which is always honoured (see [security.md](security.md)). Enable it **only** when the proxy is the sole way in: with the container port published directly, `1` lets any client spoof `X-Forwarded-For` and dodge the login limiter. |
| `ALLOWED_ORIGINS` | — | Comma-separated full origins (`https://shelf.example.com`) accepted by the CSRF/WebSocket Origin check in addition to the request's own host. Only needed when a proxy rewrites `Host` and you cannot set `TRUST_PROXY=1`. |
| `FILE_TTL_HOURS` | `168` | Default lifetime of an uploaded file (decimals allowed). `0` = never expire. *Keep* on a file exempts it. |
| `MAX_FILE_MB` | `2048` | Per-file upload cap (HTTP 413). |
| `MAX_STORAGE_MB` | `0` | Total cap for stored files (HTTP 507 `storage_full`). `0` = unlimited. |
| `MAX_TEXT_KB` | `2048` | Text box cap, enforced by the client (sent in the WebSocket `hello`). |
| `SWEEP_INTERVAL_SEC` | `60` | Cadence of the sweeper that unlinks expired files and prunes stale sessions, login attempts and link tokens. |
| `LOGIN_MAX_FAILS` | `5` | Failed logins per client IP within the window before HTTP 429 with `Retry-After`. Persisted in SQLite, so it survives restarts. |
| `LOGIN_WINDOW_MIN` | `15` | Sliding window for the above. |
| `SHUTDOWN_TIMEOUT_SEC` | `20` | Max wait for in-flight uploads on `SIGTERM`/`SIGINT`. The process hard-exits 5 s after that. |
| `APP_NAME` | `Shelf` | Name shown in the header and page title (max 40 chars). |
| `LOG_JSON` | `0` | `1` = JSON lines on stdout instead of text lines. |

## Password

Resolution order: `PASSWORD_HASH` → `PASSWORD_FILE` → `PASSWORD` → `DATA_DIR/password.hash` → **generate and print**.
Environment always wins over the file on the volume; there is never a built-in default password.

Generate a hash (reads stdin, never argv, so it stays out of shell history):

```bash
printf '%s' 'correct horse battery staple' | npm run -s hash-password
# or inside the image:
printf '%s' 'correct horse battery staple' | docker run --rm -i shelf node scripts/hash-password.mjs
```

In `docker-compose.yml` **every `$` must be written as `$$`** (Compose interpolates `${VAR}`; `$$` is a literal
dollar). If you would rather not escape anything, use `PASSWORD_FILE` with a Compose secret:

```yaml
    environment:
      PASSWORD_FILE: /run/secrets/shelf_password
    secrets: [shelf_password]
secrets:
  shelf_password:
    file: ./shelf_password.txt     # the scrypt$... hash, or just the plaintext password
```

Changing the password (new hash, new file, new `PASSWORD`) logs every device out on the next start. That is intentional.

## Data directory

```
/data/shelf.db (+ -wal, -shm)     metadata, sessions, the text document log, history snapshots
/data/files/<id>                  file blobs (no names or extensions on disk)
/data/files/<id>.thumb.jpg        client-generated thumbnails
/data/tmp/<id>                    in-flight uploads (emptied at boot)
/data/text.txt                    plain-text mirror of the box, rewritten 1 s after each change
/data/password.hash               only when the password was generated
/data/password.salt               only when a plaintext PASSWORD / PASSWORD_FILE is used
```

Only one process may use a `DATA_DIR` at a time. Never point two instances at the same directory or volume.

## A note on the storage engine

Shelf stores everything in one SQLite database through Node's built-in `node:sqlite` module. That module is still
marked **experimental** in Node and needs **Node 24 or newer** (the app suppresses its experimental warning). The
Docker image pins a known-good runtime (`node:26-alpine`), and CI runs the suite on Node 24 and 26 across Linux and
Windows, so a normal deployment is insulated from the churn. If you run from source, stay on a Node version the CI
matrix covers. Should a future Node change the `node:sqlite` API, the fix is a small adapter in `lib/db.js` — the rest
of the code talks to a thin wrapper there, not to the module directly.
