# Security model

Shelf is single-user: one password, and everyone who has it sees the same shelf. The job of the security design is
that nobody *without* the password can read, change or delete anything, cannot lock the owner out, and cannot use an
uploaded file to attack the owner's browser. Report problems privately; see [SECURITY.md](../SECURITY.md).

## Authentication

- One password, hashed with **scrypt** (N=32768, r=8, p=1, 16-byte salt, 32-byte key) using `node:crypto`.
  Verification is constant-time and always performs one scrypt, even for a malformed stored hash.
- A successful login mints a random 32-byte token. Only `sha256(token)` is stored, so the database never contains
  anything that logs a device in.
- Sessions **slide**: a device used at least once per `SESSION_DAYS` (default 365) is never logged out.
  Server-set `HttpOnly` cookies are exempt from Safari's 7-day client-side storage cap.
- **⋯ → Devices** lists sessions by device/browser and revokes them individually (their WebSockets close with
  code 4001 immediately). **Log out everywhere** deletes them all. A password change revokes them all at the next
  start (the server keeps a fingerprint of the hash in `meta`). Outstanding QR link tokens die with the sessions.

## The cookie

```
sid=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=<SESSION_DAYS>[; Secure]
```

`Secure` is added automatically when the request arrived over TLS or with `X-Forwarded-Proto: https`. That header is
honoured **even without `TRUST_PROXY`**, because spoofing it can only make the spoofer's own cookie stricter. The
payoff is zero-configuration correctness: `http://192.168.1.10:8080` on the LAN gets a non-Secure cookie (no login
loop), and any HTTPS proxy in front produces a Secure cookie without a setting. `SameSite=Lax` rather than `Strict`
so a link to the app opened from another app arrives logged in. No `__Host-` prefix: it mandates `Secure`, which
would break plain-HTTP LAN use.

## Brute force

- **Per-IP** limit: `LOGIN_MAX_FAILS` (5) failures within `LOGIN_WINDOW_MIN` (15) → `429` with `Retry-After`.
  Attempts are recorded *before* the password check, so a parallel burst cannot exceed the limit. The counter is in
  SQLite, so a restart does not reset it. A successful login clears that IP's counter.
- **Global** token bucket in memory: 30 attempts, refilling one per 2 s, consumed before the (expensive) scrypt.
  Slows distributed guessing; never locks the owner out permanently by design (no persisted global lockout, which
  would be a remote denial of service anyone could trigger).
- Client IP is `socket.remoteAddress`, or with `TRUST_PROXY=1` the **rightmost** `X-Forwarded-For` entry (the one
  your own proxy appended; never the leftmost, which the client controls). Every attempt is logged with IP and device label.
- Behind a proxy or tunnel you must set `TRUST_PROXY=1`, otherwise every visitor shares the proxy's IP and a
  stranger's five wrong guesses lock *you* out for 15 minutes. With `TRUST_PROXY=1` the container port must not be
  published directly, or LAN clients could spoof the header.

## CSRF

No tokens; three independent layers:

1. `SameSite=Lax` cookies: cross-site `POST`/`PUT`/`DELETE`/WebSocket carries no cookie.
2. An **Origin check** on every non-GET request and on the WebSocket upgrade: `Origin` must match the host the app
   sees (`X-Forwarded-Host` when `TRUST_PROXY=1`) or be listed in `ALLOWED_ORIGINS`; `403 bad_origin` otherwise.
   Requests without `Origin` pass only with `Sec-Fetch-Site: same-origin` or `none`.
3. JSON endpoints require `Content-Type: application/json`, which a cross-origin form cannot send without a
   preflight the server never answers.

## WebSocket

The upgrade is authenticated with the session cookie and the `Origin` header **before** the handshake completes; on
failure the raw socket gets `401`/`403` and is destroyed, so an unauthenticated socket never opens and there is no
"first message" auth. Every socket's session is re-checked every 60 s as a backstop to immediate revocation.
Malformed frames close with 4000. Server pings every 25 s and terminates sockets that miss a pong.

## Content security

Every HTML page carries

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:;
  media-src 'self' blob:; connect-src 'self' ws(s)://<host>; manifest-src 'self'; worker-src 'self';
  frame-ancestors 'none'; base-uri 'none'; form-action 'self'
```

There are no inline scripts, styles or event handlers anywhere in the app; all DOM is built with `createElement`
and `textContent`. Plus `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`,
and `Cache-Control: no-store` on HTML and `/api/*`.

## Uploaded files

- Downloads (`/f/<id>/<name>`) require the session cookie. An old link pasted into a logged-out browser lands on
  the login page; a non-browser client gets `401`.
- Files are served with `Content-Security-Policy: sandbox` (except PDFs, which cannot script against the origin
  anyway), `nosniff`, `Cross-Origin-Resource-Policy: same-origin`, and are rendered inline only for a short allowlist
  (png/jpeg/gif/webp/avif, mp4/webm/mov, audio, PDF, plain text). Everything else, including **SVG, HTML and HEIC**,
  is a forced download.
- Blobs are stored under random 16-character ids without names or extensions; the original name lives only in the
  database and is sanitised (no path separators or control characters). Ids are validated against `^[A-Za-z0-9_-]{16}$`
  before touching the filesystem.
- The server never parses multipart and has no image libraries; thumbnails are generated by the uploading browser
  and stored as separate JPEGs.
- The Android share target is handled entirely client-side. Because any web page can POST to `/share`, shared
  items are *staged* and the user confirms with one tap before anything is added to the shelf.

## Transport

Shelf does not do TLS itself. On plain `http://` the password and the cookie cross the network in clear: fine on a
trusted LAN, not fine on the internet. Put it behind an HTTPS proxy or a tunnel for anything beyond your own Wi-Fi;
see [deployment.md](deployment.md).

## Explicitly not provided

- Encryption at rest, a second factor, per-user separation, public or capability share links, an audit trail beyond the log.
- The client keeps a copy of the text in `localStorage` (cleared on logout and revocation) so a browser on a shared
  computer holds the text until then.
- Nothing is ever sent to a third-party origin; there is no telemetry.
