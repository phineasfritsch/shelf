// Serves files from public/ with an allowlist built at boot, sha256 ETags, and sane cache headers.
// index.html and login.html are NOT served here (routes-auth.js serves them with auth gating + CSP).
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, extname, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const GATED = new Set(['/index.html', '/login.html']);

function walk(dir, base = dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, base, out);
    else if (ent.isFile()) out.push('/' + relative(base, p).split(sep).join('/'));
  }
  return out;
}

// { has(pathname), serve(req, res, pathname), page(name) → { body, etag, type } }
export function createStatic({ publicDir, log, cacheInMemory = true }) {
  const files = new Map(); // pathname → { file, type, etag, size, body? }
  for (const pathname of walk(publicDir)) {
    const ext = extname(pathname).toLowerCase();
    const type = TYPES[ext];
    if (!type) { log?.warn('static: skipping file with unknown type', { path: pathname }); continue; }
    const file = join(publicDir, ...pathname.slice(1).split('/'));
    const body = readFileSync(file);
    const etag = '"' + createHash('sha256').update(body).digest('base64url').slice(0, 27) + '"';
    files.set(pathname, { file, type, etag, size: body.length, body: cacheInMemory ? body : null });
  }

  function cacheControl(pathname) {
    // Icons are content-stable and safe for shared caches to hold.
    if (pathname.startsWith('/icons/')) return 'public, max-age=86400';
    // Everything else (JS, CSS, manifest, sw) is unversioned and changes on every deploy. `no-store` (not merely
    // `no-cache`) is what guarantees a fresh client after a redeploy even behind a CDN like Cloudflare, which was
    // observed to edge-cache `no-cache` assets and serve a stale bundle. Correctness beats a byte or two of caching
    // for a personal-scale app; the ETag still yields 304s to the browser within a page load.
    return 'no-store';
  }

  function has(pathname) { return files.has(pathname) && !GATED.has(pathname); }

  function serve(req, res, pathname) {
    const f = files.get(pathname);
    if (!f) { res.writeHead(404); res.end(); return; }
    const body = f.body || readFileSync(f.file);
    const headers = { 'Content-Type': f.type, ETag: f.etag, 'Cache-Control': cacheControl(pathname), 'X-Content-Type-Options': 'nosniff' };
    if (pathname === '/sw.js') headers['Service-Worker-Allowed'] = '/';
    if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, headers); res.end(); return; }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end(); else res.end(body);
  }

  // For gated pages: returns the raw bytes so a route can add CSP and serve with auth.
  function page(name) {
    const f = files.get('/' + name);
    if (!f) throw new Error(`public/${name} is missing`);
    return { body: f.body || readFileSync(f.file), etag: f.etag, type: f.type };
  }

  return { has, serve, page, list: () => [...files.keys()] };
}
