// Pages (/, /login) and auth API: login, logout, logout-all, sessions, QR link.
import { networkInterfaces } from 'node:os';
import { json, empty, redirect, readJson, HttpError, securityHeaders, originOk } from './http.js';

// Non-loopback IPv4 addresses of this host (best effort; behind Docker these are container IPs and the client ignores
// them unless the page itself was opened on localhost/127.0.0.1).
function lanAddresses() {
  const out = [];
  try {
    for (const list of Object.values(networkInterfaces())) for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) out.push(i.address);
    }
  } catch {}
  return out;
}

function servePage(req, res, cfg, staticServer, name) {
  const { body, etag, type } = staticServer.page(name);
  securityHeaders(res, { html: true, req, cfg });
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length });
  if (req.method === 'HEAD') res.end(); else res.end(body);
}

export function registerAuthRoutes({ router, cfg, auth, staticServer, log }) {
  // GET / → app (auth gated, no login flash). GET /login → login page (302 → / when already logged in).
  router.add('GET', '/', (req, res) => servePage(req, res, cfg, staticServer, 'index.html'), { auth: 'page' });
  router.add('GET', '/login', async (req, res) => {
    if (await auth.authenticate(req)) return redirect(res, '/');
    servePage(req, res, cfg, staticServer, 'login.html');
  }, { auth: 'none' });

  // Shared by /api/login and /api/link/claim: rate limit → verify → session cookie.
  async function attemptLogin(req, res, verify) {
    if (!originOk(req, cfg)) throw new HttpError(403, 'bad_origin');
    const ip = auth.clientIp(req);
    const gate = auth.checkLoginAllowed(ip);
    if (!gate.ok) {
      log.warn('login: rate limited', { ip, scope: gate.scope, retryAfter: gate.retryAfter });
      throw new HttpError(429, 'rate_limited', `Too many attempts, try again in ${gate.retryAfter}s`, { 'Retry-After': String(gate.retryAfter) });
    }
    // Record the attempt BEFORE the ~80 ms scrypt so N parallel requests from one IP cannot all pass the check above;
    // a success wipes the IP's rows again.
    auth.recordLoginFailure(ip);
    const ok = await verify();
    if (!ok) {
      log.warn('login: failed', { ip, label: (req.headers['user-agent'] || '').slice(0, 60) });
      throw new HttpError(401, 'bad_password');
    }
    auth.recordLoginSuccess(ip);
    const token = auth.createSession(req.headers['user-agent'] || '');
    log.info('login: ok', { ip, label: (req.headers['user-agent'] || '').slice(0, 60) });
    empty(res, 204, { 'Set-Cookie': auth.buildCookie(token, req) });
  }

  router.add('POST', '/api/login', async (req, res) => {
    const body = await readJson(req, { maxBytes: 4096 });
    const password = typeof body.password === 'string' ? body.password : '';
    await attemptLogin(req, res, () => auth.checkPassword(password));
  }, { auth: 'none', origin: false /* checked inside attemptLogin so the limiter sees it too */ });

  router.add('POST', '/api/link/claim', async (req, res) => {
    const body = await readJson(req, { maxBytes: 4096 });
    await attemptLogin(req, res, async () => auth.claimLinkToken(body.token));
  }, { auth: 'none', origin: false });

  router.add('POST', '/api/logout', (req, res, ctx) => {
    auth.deleteSession(ctx.session.idHash);
    empty(res, 204, { 'Set-Cookie': auth.clearCookie(req) });
  });

  router.add('POST', '/api/logout-all', (req, res) => {
    auth.revokeAll('logout');
    log.info('auth: logged out everywhere');
    empty(res, 204, { 'Set-Cookie': auth.clearCookie(req) });
  });

  router.add('GET', '/api/sessions', (req, res, ctx) => {
    json(res, 200, auth.listSessions(ctx.session.idHash));
  });

  router.add('DELETE', '/api/sessions/:id', (req, res, ctx) => {
    const n = auth.revokeByPrefix(ctx.params.id, 'revoked');
    if (!n) throw new HttpError(404, 'not_found');
    log.info('auth: session revoked', { id: ctx.params.id.slice(0, 12) });
    empty(res, 204);
  });

  router.add('POST', '/api/link', (req, res) => {
    const { token, expiresAt } = auth.createLinkToken();
    json(res, 200, { token, expiresAt, lanAddresses: lanAddresses() });
  });

  router.add('GET', '/api/me', (req, res, ctx) => {
    json(res, 200, { id: ctx.session.idHash.slice(0, 12), createdAt: ctx.session.createdAt, appName: cfg.appName });
  });
}
