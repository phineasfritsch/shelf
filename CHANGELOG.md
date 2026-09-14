# Changelog

All notable changes to Shelf are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/).

## [1.0.0] — 2026-09-14

First public release.

### Added
- **Live shared text box** backed by a Yjs CRDT over WebSocket: concurrent edits on multiple devices merge without
  clobbering, the caret is preserved when the far side edits, and offline edits merge on reconnect. Per-device undo,
  a short server-side history with restore, and a plain-text mirror on disk.
- **Live presence:** remote carets and selections in each device's colour, plus a "typing…" hint.
- **Files with a TTL:** drag / paste / pick / camera, client-generated thumbnails, per-file *Keep*, and a sweeper that
  actually unlinks expired blobs. Uploads above 8 MiB are chunked so proxy body-limits and flaky networks are not a wall.
- **Auth:** one `scrypt`-hashed password, year-long sliding sessions stored only as `sha256(token)`, per-device revoke,
  log-out-everywhere, and a single-use QR code to log a phone in without typing.
- **Hardening:** persisted per-IP login rate limiting plus a global bucket that cannot lock the owner out, three-layer
  CSRF (`SameSite` + Origin + `Content-Type`), WebSocket auth before the handshake completes, a strict CSP with no
  inline scripts, and uploaded files served sandboxed and inline only for a safe allowlist.
- **Ops:** single `node:26-alpine` container, one SQLite file, one volume, env-var config, health check, graceful
  shutdown, JSON or text logs. Reverse-proxy guides for Caddy / Traefik / nginx, a Cloudflare Tunnel compose override,
  and Tailscale notes.
- **Repo:** 99 `node:test` tests, a CI matrix (Node 24/26 × Ubuntu/Windows) that also builds and boot-tests the Docker
  image, MIT licence, security policy, contributing guide, and layered docs.

### Security
- The `MAX_TEXT_KB` limit is now enforced on the server (an over-cap document is trimmed authoritatively), not only in
  the browser.
- `MAX_STORAGE_MB` is honoured across both upload paths at once via a shared reservation, so concurrent uploads cannot
  jointly overshoot the cap.
- The public `/healthz` probe returns only `{ok, draining}` and no longer discloses file or client counts.

[1.0.0]: https://github.com/phineasfritsch/file_mover/releases/tag/v1.0.0
