// node:http server, tiny router, request helpers, security headers, origin/IP/HTTPS logic.
//
// Router usage (routes are registered by lib/routes-*.js):
//   router.add('GET', '/api/files/:id', handler, { auth: 'api' })
//   handler(req, res, ctx) — ctx = { params, query (URLSearchParams), url (URL), session|null, cfg, log }
//   Route options:
//     auth:   'none' | 'api' (401 JSON) | 'page' (302 /login) | 'file' (302 if the client wants HTML, else 401)   default 'api'
//     origin: true|false — run the Origin/Sec-Fetch-Site check on non-GET/HEAD requests             default true
//   A handler may return nothing (it wrote the response) or throw an HttpError.
import { createServer as createHttpServerRaw } from 'node:http';

export class HttpError extends Error {
  constructor(status, code, message, headers) { super(message || code); this.status = status; this.code = code; this.headers = headers; }
}

export const NO_STORE = 'no-store';

// ---------- helpers ----------

export function json(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': NO_STORE, ...headers });
  res.end(data);
}

export function empty(res, status = 204, headers = {}) {
  res.writeHead(status, { 'Cache-Control': NO_STORE, ...headers });
  res.end();
}

export function redirect(res, location, status = 302) {
  res.writeHead(status, { Location: location, 'Cache-Control': NO_STORE, 'Content-Length': 0 });
  res.end();
}

export function sendError(res, err) {
  if (res.headersSent) { try { res.destroy(); } catch {} return; }
  if (err instanceof HttpError) return json(res, err.status, { error: err.code, message: err.message !== err.code ? err.message : undefined }, err.headers);
  json(res, 500, { error: 'internal' });
}

// Reads a JSON body. Requires Content-Type: application/json (cross-origin forms cannot send that without a preflight).
export function readJson(req, { maxBytes = 4096 } = {}) {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') return reject(new HttpError(415, 'json_required', 'Content-Type must be application/json'));
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) return reject(new HttpError(413, 'too_large'));
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); reject(new HttpError(413, 'too_large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const v = text.trim() === '' ? {} : JSON.parse(text);
        if (v === null || typeof v !== 'object' || Array.isArray(v)) return reject(new HttpError(400, 'bad_json', 'body must be a JSON object'));
        resolve(v);
      } catch { reject(new HttpError(400, 'bad_json')); }
    });
    req.on('error', () => reject(new HttpError(400, 'bad_body')));
  });
}

export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    let v = part.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

function firstHeaderValue(v) { return String(v || '').split(',')[0].trim().toLowerCase(); }

// HTTPS if the socket is TLS, or the proxy says so. X-Forwarded-Proto is honoured regardless of TRUST_PROXY:
// spoofing it only makes the spoofer's own cookie Secure (fail-safe).
export function isHttps(req) {
  if (req.socket && req.socket.encrypted) return true;
  return firstHeaderValue(req.headers['x-forwarded-proto']) === 'https';
}

export function expectedHost(req, cfg) {
  if (cfg.trustProxy) {
    const xfh = firstHeaderValue(req.headers['x-forwarded-host']);
    if (xfh) return xfh;
  }
  return String(req.headers.host || '').trim().toLowerCase();
}

// CSRF/WS origin policy: Origin must match the expected host (or be allowlisted). Without Origin, only same-origin/none fetches pass.
export function originOk(req, cfg) {
  const origin = req.headers.origin;
  if (origin === undefined) {
    const sfs = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    return sfs === 'same-origin' || sfs === 'none';
  }
  if (origin === 'null') return false;
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (cfg.allowedOrigins.has(u.origin)) return true;
  const host = expectedHost(req, cfg);
  return !!host && u.host.toLowerCase() === host;
}

export function clientIp(req, cfg) {
  if (cfg.trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1]; // rightmost = added by our own proxy; never the first (client-spoofable)
  }
  return req.socket?.remoteAddress || '0.0.0.0';
}

export function wantsHtml(req) {
  return String(req.headers.accept || '').includes('text/html');
}

export function cspFor(req, cfg) {
  const host = expectedHost(req, cfg) || 'localhost';
  const scheme = isHttps(req) ? 'wss' : 'ws';
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    `connect-src 'self' ${scheme}://${host}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

export function securityHeaders(res, { html = false, req, cfg } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  if (html) {
    res.setHeader('Content-Security-Policy', cspFor(req, cfg));
    res.setHeader('Cache-Control', NO_STORE);
  }
}

// ---------- router ----------

function compile(pattern) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  return { re, keys };
}

export function createRouter() {
  const routes = [];
  return {
    add(method, pattern, handler, opts = {}) {
      routes.push({ method: method.toUpperCase(), ...compile(pattern), pattern, handler, opts: { auth: 'api', origin: true, ...opts } });
      return this;
    },
    match(method, pathname) {
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method && !(r.method === 'GET' && method === 'HEAD')) continue;
        const params = {};
        r.keys.forEach((k, i) => { try { params[k] = decodeURIComponent(m[i + 1]); } catch { params[k] = m[i + 1]; } });
        return { route: r, params };
      }
      return pathMatched ? { route: null, params: null, methodMismatch: true } : null;
    },
  };
}

// ---------- server ----------

// deps: { cfg, log, router, staticServer, auth, healthz() }
export function createHttpServer({ cfg, log, router, staticServer, auth, healthz }) {
  const state = { draining: false };

  async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return json(res, 400, { error: 'bad_url' }); }
    const pathname = url.pathname;
    res.setHeader('Server', 'shelf');

    if (pathname === '/healthz') {
      const body = { ok: !state.draining, draining: state.draining, ...(typeof healthz === 'function' ? healthz() : {}) };
      return json(res, state.draining ? 503 : 200, body);
    }

    securityHeaders(res, { req, cfg });
    const m = router.match(req.method, pathname);
    if (m && m.methodMismatch) return json(res, 405, { error: 'method_not_allowed' });
    if (!m) {
      if ((req.method === 'GET' || req.method === 'HEAD') && staticServer.has(pathname)) return staticServer.serve(req, res, pathname);
      return json(res, 404, { error: 'not_found' });
    }
    const { route, params } = m;
    const ctx = { params, query: url.searchParams, url, session: null, cfg, log };
    try {
      if (route.opts.auth !== 'none') {
        const session = await auth.authenticate(req);
        if (!session) {
          if (route.opts.auth === 'page' || (route.opts.auth === 'file' && wantsHtml(req))) return redirect(res, '/login');
          return json(res, 401, { error: 'unauthorized' });
        }
        ctx.session = session;
      }
      if (route.opts.origin && req.method !== 'GET' && req.method !== 'HEAD' && !originOk(req, cfg)) {
        throw new HttpError(403, 'bad_origin');
      }
      if (ctx.session) auth.touch(ctx.session, req, res);
      await route.handler(req, res, ctx);
      if (!res.headersSent && !res.writableEnded) json(res, 500, { error: 'no_response' });
    } catch (err) {
      if (!(err instanceof HttpError)) log.error('request failed', { method: req.method, path: pathname, err });
      sendError(res, err);
    }
  }

  const server = createHttpServerRaw({ requestTimeout: 0, headersTimeout: 60_000, keepAliveTimeout: 65_000, maxHeaderSize: 32 * 1024 }, (req, res) => {
    handle(req, res).catch((err) => { log.error('unhandled', { err }); sendError(res, err); });
  });
  // Idle timeout per socket (no bytes in either direction for 2 min). Long uploads keep sending bytes so they are
  // unaffected; a client that vanishes mid-upload gets torn down, which runs the upload's cleanup path.
  // `ws` clears the timeout on upgraded sockets, so WebSockets are governed by their own ping/pong instead.
  server.setTimeout(120_000);
  server.on('clientError', (err, socket) => {
    if (err.code === 'ECONNRESET' || !socket.writable) return;
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  return { server, state, setDraining: (v) => { state.draining = v; } };
}
