// Sessions, cookies, login rate limiting, QR link tokens, password-change detection.
// Only sha256(token) is ever stored; the raw token lives in the browser cookie.
import { createHash, randomBytes } from 'node:crypto';
import { verifyPassword } from './password.js';
import { parseCookies, isHttps, clientIp } from './http.js';

export const COOKIE_NAME = 'sid';
const TOUCH_INTERVAL_MS = 60 * 60 * 1000; // slide last_seen_at at most hourly
const LINK_TTL_MS = 5 * 60 * 1000;

export function sha256hex(s) { return createHash('sha256').update(s).digest('hex'); }

// "iPhone · Safari" style label from a User-Agent.
export function uaLabel(ua = '') {
  const s = String(ua);
  let device = 'Other';
  if (/iPhone/i.test(s)) device = 'iPhone';
  else if (/iPad|Macintosh.*Mobile/i.test(s)) device = 'iPad';
  else if (/Android/i.test(s)) device = 'Android';
  else if (/Windows/i.test(s)) device = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(s)) device = 'Mac';
  else if (/CrOS/i.test(s)) device = 'ChromeOS';
  else if (/Linux/i.test(s)) device = 'Linux';
  let browser = 'Other';
  if (/Edg\//i.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(s)) browser = 'Opera';
  else if (/Firefox\/|FxiOS/i.test(s)) browser = 'Firefox';
  else if (/CriOS/i.test(s)) browser = 'Chrome';
  else if (/Chrome\/|Chromium\//i.test(s)) browser = 'Chrome';
  else if (/Safari\//i.test(s)) browser = 'Safari';
  else if (/curl\//i.test(s)) browser = 'curl';
  return `${device} · ${browser}`;
}

export function createAuth({ cfg, db, log }) {
  const q = {
    insertSession: db.prepare('INSERT INTO sessions(id_hash, created_at, last_seen_at, ua) VALUES (?, ?, ?, ?)'),
    getSession: db.prepare('SELECT id_hash, created_at, last_seen_at, ua FROM sessions WHERE id_hash = ? AND last_seen_at > ?'),
    touchSession: db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE id_hash = ?'),
    findByPrefix: db.prepare('SELECT id_hash FROM sessions WHERE id_hash LIKE ?'),
    deleteAll: db.prepare('DELETE FROM sessions'),
    listSessions: db.prepare('SELECT id_hash, created_at, last_seen_at, ua FROM sessions WHERE last_seen_at > ? ORDER BY last_seen_at DESC'),
    pruneSessions: db.prepare('DELETE FROM sessions WHERE last_seen_at <= ?'),
    countFails: db.prepare('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM login_attempts WHERE ip = ? AND at > ?'),
    insertFail: db.prepare('INSERT INTO login_attempts(ip, at) VALUES (?, ?)'),
    clearFails: db.prepare('DELETE FROM login_attempts WHERE ip = ?'),
    pruneFails: db.prepare('DELETE FROM login_attempts WHERE at <= ?'),
    insertLink: db.prepare('INSERT INTO link_tokens(hash, expires_at) VALUES (?, ?)'),
    getLink: db.prepare('SELECT hash FROM link_tokens WHERE hash = ? AND expires_at > ?'),
    deleteLink: db.prepare('DELETE FROM link_tokens WHERE hash = ?'),
    pruneLinks: db.prepare('DELETE FROM link_tokens WHERE expires_at <= ?'),
    deleteAllLinks: db.prepare('DELETE FROM link_tokens'),
  };

  // Password change → every session is revoked.
  const pwfp = sha256hex(cfg.passwordHash).slice(0, 16);
  const prevFp = db.meta.get('pwfp');
  if (prevFp && prevFp !== pwfp) {
    q.deleteAll.run();
    q.deleteAllLinks.run();
    log.info('auth: password changed, all sessions revoked');
  }
  db.meta.set('pwfp', pwfp);

  // Global token bucket (in-memory): slows distributed guessing, never locks the owner out.
  const bucket = { capacity: 30, tokens: 30, refillMs: 2000, last: Date.now() };
  function takeGlobalToken(now) {
    const elapsed = now - bucket.last;
    if (elapsed > 0) { bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed / bucket.refillMs); bucket.last = now; }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  const api = {
    // ----- hooks (set by ws.js) -----
    // called with (array of id_hash | '*', reason) when sessions are revoked
    onSessionsRevoked: null,

    // ----- cookies -----
    cookieSecure(req) {
      if (cfg.cookieSecure === 'auto') return isHttps(req);
      return cfg.cookieSecure === true;
    },
    buildCookie(token, req) {
      const maxAge = Math.max(60, Math.round(cfg.sessionMs / 1000));
      return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${api.cookieSecure(req) ? '; Secure' : ''}`;
    },
    clearCookie(req) {
      return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${api.cookieSecure(req) ? '; Secure' : ''}`;
    },
    tokenFromRequest(req) {
      const t = parseCookies(req)[COOKIE_NAME];
      return t && /^[A-Za-z0-9_-]{20,128}$/.test(t) ? t : null;
    },

    // ----- sessions -----
    createSession(ua = '') {
      const token = randomBytes(32).toString('base64url');
      const now = Date.now();
      q.insertSession.run(sha256hex(token), now, now, String(ua).slice(0, 300));
      return token;
    },
    lookupSession(token) {
      if (!token) return null;
      const idHash = sha256hex(token);
      const row = q.getSession.get(idHash, Date.now() - cfg.sessionMs);
      if (!row) return null;
      return { idHash: row.id_hash, createdAt: row.created_at, lastSeenAt: row.last_seen_at, ua: row.ua, token };
    },
    // Session for an HTTP request (or WS upgrade request), or null. Never throws.
    async authenticate(req) {
      return api.lookupSession(api.tokenFromRequest(req));
    },
    // Sliding renewal: bump last_seen_at and re-send the cookie at most once an hour per session.
    touch(session, req, res) {
      const now = Date.now();
      if (now - session.lastSeenAt < TOUCH_INTERVAL_MS) return;
      q.touchSession.run(now, session.idHash);
      session.lastSeenAt = now;
      if (res && !res.headersSent) res.setHeader('Set-Cookie', api.buildCookie(session.token, req));
    },
    deleteSession(idHash) {
      q.deleteSession.run(idHash);
      api.onSessionsRevoked?.([idHash], 'logout');
    },
    // Revoke sessions whose id_hash starts with the given prefix (12+ hex chars). Returns the number revoked.
    revokeByPrefix(prefix, reason = 'revoked') {
      if (!/^[0-9a-f]{12,64}$/.test(prefix)) return 0;
      const rows = q.findByPrefix.all(prefix + '%');
      for (const r of rows) q.deleteSession.run(r.id_hash);
      if (rows.length) api.onSessionsRevoked?.(rows.map(r => r.id_hash), reason);
      return rows.length;
    },
    revokeAll(reason = 'logout') {
      q.deleteAll.run();
      q.deleteAllLinks.run();
      api.onSessionsRevoked?.('*', reason);
    },
    listSessions(currentIdHash) {
      return q.listSessions.all(Date.now() - cfg.sessionMs).map(r => ({
        id: r.id_hash.slice(0, 12),
        label: uaLabel(r.ua),
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
        current: r.id_hash === currentIdHash,
      }));
    },
    sessionExists(idHash) {
      return !!q.getSession.get(idHash, Date.now() - cfg.sessionMs);
    },

    // ----- password -----
    async checkPassword(password) {
      return verifyPassword(password, cfg.passwordHash);
    },

    // ----- login rate limiting -----
    // Returns { ok: true } or { ok: false, retryAfter: seconds }. Consumes a global token on success.
    checkLoginAllowed(ip) {
      const now = Date.now();
      const row = q.countFails.get(ip, now - cfg.loginWindowMs);
      if (row && row.n >= cfg.loginMaxFails) {
        const retryAfter = Math.max(1, Math.ceil((row.oldest + cfg.loginWindowMs - now) / 1000));
        return { ok: false, retryAfter, scope: 'ip' };
      }
      if (!takeGlobalToken(now)) return { ok: false, retryAfter: 2, scope: 'global' };
      return { ok: true };
    },
    recordLoginFailure(ip) { q.insertFail.run(ip, Date.now()); },
    recordLoginSuccess(ip) { q.clearFails.run(ip); },
    clientIp(req) { return clientIp(req, cfg); },

    // ----- QR link tokens -----
    createLinkToken() {
      const now = Date.now();
      q.pruneLinks.run(now);
      const token = randomBytes(24).toString('base64url');
      const expiresAt = now + LINK_TTL_MS;
      q.insertLink.run(sha256hex(token), expiresAt);
      return { token, expiresAt };
    },
    // Single use. Returns true if the token was valid (and is now consumed).
    claimLinkToken(token) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return false;
      const h = sha256hex(token);
      const row = q.getLink.get(h, Date.now());
      if (!row) return false;
      q.deleteLink.run(h);
      return true;
    },

    // ----- housekeeping (called from the sweeper) -----
    prune(now = Date.now()) {
      q.pruneSessions.run(now - cfg.sessionMs);
      q.pruneFails.run(now - 24 * 3600e3);
      q.pruneLinks.run(now);
    },
  };
  return api;
}
