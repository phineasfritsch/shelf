# Security policy

Shelfy is a single-user app that is meant to be exposed to the internet behind HTTPS, so security bugs matter here.
The full threat model and the controls in place are described in [docs/security.md](docs/security.md).

## Reporting a vulnerability

Please **do not open a public issue** for anything that could let someone read, change or delete another
person's shelf, log in without the password, bypass rate limiting, or run script on the Shelfy origin.

Instead, use GitHub's private reporting: **Security → Report a vulnerability** on this repository. Include the
version (commit hash or image tag), how you deployed it (plain, reverse proxy, tunnel), and steps to reproduce.

You will get an acknowledgement within a few days. Fixes ship as a normal commit plus a note in the release;
credit is given unless you prefer otherwise.

## In scope

- Authentication, sessions, the QR link flow, logout/revocation
- CSRF, Origin checks, WebSocket authentication
- Anything an uploaded file can do to the app origin (XSS via served files, header injection)
- Path traversal, symlink following, or reading files outside `DATA_DIR`
- Denial of service that a single unauthenticated client can cause cheaply

## Out of scope

- Attacks that require the password or a valid session cookie (that person *is* the user)
- Running Shelfy on plain `http://` across an untrusted network (documented as unsupported)
- Vulnerabilities in the reverse proxy, tunnel, or host you put in front of it
- Rate-limit bypass that needs many source IPs (a single-user app is not a bank; see docs/security.md)

## Supported versions

The `main` branch and the most recent tagged release.
