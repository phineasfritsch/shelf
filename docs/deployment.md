# Deployment

Shelf speaks plain HTTP on one port. Everything else (TLS, a public name, access from outside your LAN) is done by
something in front of it. This page covers every supported way to put that something there, plus backups and upgrades.

- [Cloudflare Tunnel](#cloudflare-tunnel-recommended-for-remote-access)
- [Reverse proxy: Caddy, Traefik, nginx](#reverse-proxy)
- [Tailscale](#tailscale)
- [Bind mounts and the container uid](#bind-mounts-and-the-container-uid)
- [Backup and restore](#backup-and-restore)
- [Upgrade](#upgrade)
- [Troubleshooting](#troubleshooting)

## Cloudflare Tunnel (recommended for remote access)

No port forwarding, free HTTPS, works behind CGNAT. Needs a domain on Cloudflare (the free plan is fine).

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** (connector: cloudflared). Copy the token.
2. Under the tunnel's **Public hostnames** add e.g. `shelf.example.com` → service `http://shelf:8080`.
3. `echo 'TUNNEL_TOKEN=<token>' >> .env`
4. `docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d --build`

`docker-compose.tunnel.yml` adds the connector, sets `TRUST_PROXY=1` and `COOKIE_SECURE=true`, and stops publishing
port 8080 on the host, so the tunnel is the only way in. Cloudflare caps single requests at 100 MB; Shelf uploads
anything above 8 MiB in 8 MiB parts, so file size is limited only by `MAX_FILE_MB`.

Optional second layer: put **Cloudflare Access** on the hostname so anonymous traffic never even reaches Shelf.

If you already use the `cloudflared` CLI, the same thing without the dashboard:

```bash
cloudflared tunnel create shelf
cloudflared tunnel route dns shelf shelf.example.com
cloudflared tunnel token shelf        # → TUNNEL_TOKEN for .env
```

## Reverse proxy

Shelf needs three things from a proxy: WebSocket upgrades on `/ws`, `X-Forwarded-Proto` (so the session cookie gets
`Secure`), and request bodies of at least 8 MiB (uploads are chunked at that size). Set `TRUST_PROXY=1` so the
login rate limiter sees real client IPs, and remove the `ports:` mapping from compose once only the proxy network
reaches the container.

Do not strip or rewrite response headers: `Content-Security-Policy`, `Content-Disposition`,
`X-Content-Type-Options` and `Cross-Origin-Resource-Policy` on file downloads are what keep an uploaded HTML/SVG file inert.

### Caddy

```
shelf.example.com {
    reverse_proxy shelf:8080
}
```

WebSocket upgrade, `X-Forwarded-Proto`/`X-Forwarded-For` and unlimited bodies are Caddy's defaults. With
[caddy-docker-proxy](https://github.com/lucaslorentz/caddy-docker-proxy) use the commented labels in `docker-compose.yml`.
Forward ports 80 and 443 on your router to the box and point a DNS name at your public IP.

### Traefik

```yaml
    labels:
      traefik.enable: "true"
      traefik.http.routers.shelf.rule: "Host(`shelf.example.com`)"
      traefik.http.routers.shelf.entrypoints: "websecure"
      traefik.http.routers.shelf.tls.certresolver: "letsencrypt"
      traefik.http.services.shelf.loadbalancer.server.port: "8080"
```

Traefik forwards WebSockets and sets `X-Forwarded-*` by default and does not limit body size unless you add a
`buffering` middleware. Do not.

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
        client_max_body_size 16m;
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

`client_max_body_size` must be above 8 MiB (nginx's default is 1 MB); `proxy_request_buffering off` streams uploads
through instead of spooling them to disk first, which is what keeps the progress bar truthful; `proxy_read_timeout`
keeps idle WebSockets open (the app pings every 20–25 s, so even the 60 s default would survive).

## Tailscale

Private mesh, nothing exposed to the public internet. Install Tailscale on the server and on the phone, then on the server:

```bash
tailscale serve --bg 8080
```

That gives `https://<machine>.<tailnet>.ts.net` with a valid certificate. Leave `TRUST_PROXY=0` and `COOKIE_SECURE=auto`.

## Bind mounts and the container uid

The container runs as the unprivileged `node` user, uid/gid **1000**. A named volume (the default in
`docker-compose.yml`) inherits the right ownership from the image's `/data`. For a bind mount, either make the host
directory writable by that uid:

```bash
mkdir -p ./data && sudo chown -R 1000:1000 ./data
```

or run the container as the host directory's owner:

```yaml
    user: "1000:1000"        # or "$(id -u):$(id -g)"
    volumes:
      - ./data:/data
```

If neither is done the container exits immediately with `DATA_DIR /data is not writable by uid 1000`. On Docker
Desktop (Windows/macOS) bind mounts go through a file-sharing layer that SQLite does not like; use a named volume there.

## Backup and restore

Everything lives under `/data` (see [configuration.md](configuration.md#data-directory)). Back up the whole directory.

Consistent backup (stop the app so the SQLite WAL is checkpointed and no upload is half-written):

```bash
docker compose stop shelf
docker run --rm -v shelf_shelf-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/shelf-$(date +%F).tgz -C /data .
docker compose start shelf
```

Compose names the volume `<project>_shelf-data`, where `<project>` is the folder you ran `docker compose` in;
`docker volume ls` shows the real name. With a bind mount, `tar czf shelf.tgz -C ./data .` is enough. Live backups
with restic or `sqlite3 /data/shelf.db ".backup /tmp/shelf.db"` plus a copy of `files/` also work; a WAL-mode
database is safe to read while the app runs.

Restore: stop the app, untar into the (empty) volume, hand it back to uid 1000:

```bash
docker compose stop shelf
docker run --rm -v shelf_shelf-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/shelf-2026-01-31.tgz -C /data && chown -R 1000:1000 /data'
docker compose start shelf
```

Files that expired while the backup sat on the shelf are swept on the first boot. If you only have `text.txt`
(a hand restore), drop it into an otherwise empty `/data`: when the document log is empty the box is seeded from it.

## Upgrade

```bash
git pull
docker compose up -d --build        # add --pull always to refresh the node:26-alpine base too
```

Shelf refuses to start on a database written by a newer version (`schema_version` in the `meta` table), so
downgrading means restoring a backup. Restarts are graceful: `/healthz` returns `503` as soon as `SIGTERM` arrives so
a proxy stops routing, WebSocket clients get `{"t":"bye","reason":"shutdown"}` and reconnect on their own, in-flight
uploads get `SHUTDOWN_TIMEOUT_SEC` to finish, and the text is compacted and mirrored to `text.txt` before the
database closes. Nobody is logged out by an upgrade. Nothing on the client is cached by a service worker, so the new
front end is served on the next page load.

## Troubleshooting

**Login "works" but immediately returns to the login page.** The browser is dropping the cookie. Almost always the
cookie has `Secure` but the page is loaded over plain `http://`: you set `COOKIE_SECURE=true` (put it back to `auto`
or `false`), or something in front of Shelf adds `X-Forwarded-Proto: https` on an http hop. Check the `Set-Cookie`
header in DevTools → Network → `/api/login`.

**`403 {"error":"bad_origin"}` on login, or the WebSocket never connects (pill stuck on *Reconnecting…*).** The
`Origin` the browser sends does not match the `Host` the app sees. When a proxy rewrites `Host`, set `TRUST_PROXY=1`
(it will then use `X-Forwarded-Host`) or list the public origin in `ALLOWED_ORIGINS=https://shelf.example.com`. A
WebSocket that fails while plain requests work means the proxy is not forwarding the upgrade; see the nginx block.

**Uploads fail with "Blocked by reverse proxy (body size limit?)".** The proxy rejected a request body before Shelf
saw it: nginx `client_max_body_size` below 8 MiB, a Traefik `buffering` middleware, or a request timeout on a slow
link. Shelf's own limit is `MAX_FILE_MB` and shows as "Too large (limit N MB)" instead. "Storage full" means
`MAX_STORAGE_MB` is reached.

**`DATA_DIR /data is not writable by uid 1000` on start.** Bind-mounted directory owned by someone else.
`chown -R 1000:1000` it or set `user:` in compose. On a named volume this only happens if you previously ran the
container as root against the same volume; `docker run --rm -v <volume>:/data alpine chown -R 1000:1000 /data` fixes it.

**`PASSWORD_HASH is not a valid scrypt$... string`.** The `$` characters were eaten (compose needs `$$`; a shell needs
single quotes) or the value was cut. The hash has six `$`-separated parts and starts with `scrypt$`. Or use `PASSWORD_FILE`.

**"Too many attempts - try again in N s".** Five wrong passwords from one IP within 15 minutes. The counter is
persisted, so a restart does not reset it; wait it out, or change `LOGIN_MAX_FAILS`/`LOGIN_WINDOW_MIN`. Behind a
proxy without `TRUST_PROXY=1` every visitor counts against the same IP.

**Forgot the password.** If it came from `PASSWORD_HASH`/`PASSWORD`/`PASSWORD_FILE`, set a new one and restart. If
it was generated, delete `/data/password.hash` and restart: a new one is generated and printed. All devices are logged out.

**Container shows `unhealthy`.** The healthcheck fetches `http://127.0.0.1:$PORT/healthz` inside the container. It
fails if `HOST` is set to an address other than `0.0.0.0`/`127.0.0.1`, or for the last seconds of a graceful
shutdown (by design, so the proxy drains). `/healthz` returns `{"ok":true,"draining":false,"files":N,"clients":N,"uptime":S}`
and needs no login.

**Text looks stale on one device.** The pill in the header tells you the state: *Saving…* has unacknowledged edits,
*Reconnecting…* has no socket, *Offline* means the browser reports no network. Edits made in any of those states
are kept locally and merged when the socket is back; nothing is lost by waiting.

**The "Link a phone" QR code points at `localhost`.** You opened the app on the server itself. The QR encodes the
address in your browser's URL bar (falling back to a LAN address when that is `localhost`); open Shelf via the
address the phone will use and generate the code there.
