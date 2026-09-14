// Auth: password hashing, login, cookie flags, rate limiting, Origin/CSRF, WS upgrade auth,
// download auth, logout, per-device sessions + revoke, QR link tokens, page gating.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startTestServer, cookieFromResponse, withTimeout } from './helpers.js';
import { hashPasswordSync, verifyPassword, isHashString } from '../lib/password.js';

const JSON_CT = { 'Content-Type': 'application/json' };
const SESSION_MAX_AGE = 365 * 86400;

describe('auth', () => {
  let t;
  before(async () => { t = await startTestServer(); });
  after(async () => { await t.stop(); });

  const postLogin = (password, init = {}) =>
    t.fetch('/api/login', { method: 'POST', headers: JSON_CT, body: JSON.stringify({ password }), ...init });

  // Login attempts by 127.0.0.1 accumulate in the persisted limiter; reset between tests that count failures.
  const clearAttempts = () => t.app.db.exec('DELETE FROM login_attempts');

  test('scrypt hash/verify round trip', async () => {
    const h = hashPasswordSync('hunter2');
    assert.match(h, /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    assert.ok(isHashString(h));
    assert.equal(await verifyPassword('hunter2', h), true);
    assert.equal(await verifyPassword('hunter3', h), false);
    assert.equal(await verifyPassword('hunter2', 'garbage'), false);
    assert.notEqual(hashPasswordSync('hunter2'), h, 'fresh salt per hash');
  });

  test('wrong password → 401 bad_password, no cookie', async () => {
    const res = await postLogin('nope');
    assert.equal(res.status, 401);
    assert.deepEqual((await res.json()).error, 'bad_password');
    assert.equal(cookieFromResponse(res), null);
    clearAttempts();
  });

  test('right password → 204 with the exact cookie (no Secure on plain http)', async () => {
    const res = await postLogin('test');
    assert.equal(res.status, 204);
    const set = res.headers.getSetCookie();
    assert.equal(set.length, 1);
    assert.match(set[0], new RegExp(`^sid=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}$`));
    assert.ok(!/secure/i.test(set[0]));
  });

  test('cookie gets Secure behind X-Forwarded-Proto: https (even without TRUST_PROXY)', async () => {
    const res = await postLogin('test', { headers: { ...JSON_CT, 'X-Forwarded-Proto': 'https' } });
    assert.equal(res.status, 204);
    const c = res.headers.getSetCookie()[0];
    assert.match(c, /; Secure$/);
    assert.match(c, /^sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
  });

  test('login requires JSON content type', async () => {
    const res = await t.fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"password":"test"}' });
    assert.equal(res.status, 415);
  });

  test('POST without Origin and Sec-Fetch-Site: cross-site → 403', async () => {
    const res = await postLogin('test', { origin: null, headers: { ...JSON_CT, 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'bad_origin');
  });

  test('POST with a mismatched Origin → 403', async () => {
    const res = await postLogin('test', { origin: 'http://evil.example' });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'bad_origin');
  });

  test('POST without Origin but Sec-Fetch-Site: same-origin is allowed', async () => {
    const res = await postLogin('test', { origin: null, headers: { ...JSON_CT, 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(res.status, 204);
  });

  test('authenticated mutation with a bad Origin → 403', async () => {
    const cookie = await t.login();
    const res = await t.fetch('/api/logout', { method: 'POST', cookie, origin: 'http://evil.example' });
    assert.equal(res.status, 403);
    // session untouched
    assert.equal((await t.fetch('/api/me', { cookie })).status, 200);
  });

  test('unauthenticated /api/* → 401 unauthorized', async () => {
    const res = await t.fetch('/api/me');
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'unauthorized');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal((await t.fetch('/api/me', { cookie: 'sid=' + 'A'.repeat(43) })).status, 401);
  });

  test('GET / → 302 /login when logged out; GET /login → 302 / when logged in', async () => {
    let res = await t.fetch('/');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login');

    res = await t.fetch('/login');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);

    const cookie = await t.login();
    res = await t.fetch('/login', { cookie });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');

    res = await t.fetch('/', { cookie });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
  });

  test('/f/… without a cookie → 401, or 302 /login when the client accepts HTML', async () => {
    let res = await t.fetch('/f/abcdefghijklmnop/x.txt');
    assert.equal(res.status, 401);
    res = await t.fetch('/f/abcdefghijklmnop/x.txt', { headers: { Accept: 'text/html,*/*' } });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login');
    res = await t.fetch('/f/abcdefghijklmnop/thumb');
    assert.equal(res.status, 401);
  });

  test('WS upgrade: 401 without cookie, 403 with a bad or missing Origin, 101 when valid', async () => {
    const cookie = await t.login();
    assert.equal(await t.wsStatus(null), 401);
    assert.equal(await t.wsStatus('sid=' + 'B'.repeat(43)), 401);
    assert.equal(await t.wsStatus(cookie, { origin: 'http://evil.example' }), 403);
    assert.equal(await t.wsStatus(cookie, { origin: null }), 403, 'browsers always send Origin on upgrades; none → reject');
    assert.equal(await t.wsStatus(cookie), 101);
  });

  test('WS handshake starts with hello', async () => {
    const cookie = await t.login();
    const c = await t.connectSynced(cookie);
    assert.equal(c.hello.t, 'hello');
    assert.equal(c.hello.proto, 1);
    assert.equal(typeof c.hello.now, 'number');
    assert.deepEqual(Object.keys(c.hello.limits).sort(), ['maxFileMB', 'maxTextKB', 'storageMB', 'ttlHours']);
    assert.equal(c.messages[0].t, 'hello', 'hello is the first control message');
    c.close();
    await c.closed;
  });

  test('logout invalidates the session and clears the cookie', async () => {
    const cookie = await t.login();
    assert.equal((await t.fetch('/api/me', { cookie })).status, 200);
    const res = await t.fetch('/api/logout', { method: 'POST', cookie });
    assert.equal(res.status, 204);
    const cleared = res.headers.getSetCookie()[0];
    assert.match(cleared, /^sid=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0$/);
    assert.equal((await t.fetch('/api/me', { cookie })).status, 401);
    assert.equal(await t.wsStatus(cookie), 401);
  });

  test('logout closes that session\'s socket with 4001', async () => {
    const cookie = await t.login();
    const c = await t.connectSynced(cookie);
    await t.fetch('/api/logout', { method: 'POST', cookie });
    const { code } = await withTimeout(c.closed, 3000, 'socket close after logout');
    assert.equal(code, 4001);
    assert.equal(c.bye?.t, 'bye');
    assert.equal(c.bye?.reason, 'logout');
  });

  test('sessions list shows every device; revoke closes only that socket with 4001', async () => {
    const ua = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' };
    const cookieA = await t.login('test', { headers: { ...JSON_CT, ...ua } });
    const cookieB = await t.login();
    const cA = await t.connectSynced(cookieA);
    const cB = await t.connectSynced(cookieB);

    const listA = await (await t.fetch('/api/sessions', { cookie: cookieA })).json();
    assert.ok(Array.isArray(listA) && listA.length >= 2);
    for (const s of listA) {
      assert.match(s.id, /^[0-9a-f]{12}$/);
      assert.equal(typeof s.label, 'string');
      assert.equal(typeof s.createdAt, 'number');
      assert.equal(typeof s.lastSeenAt, 'number');
    }
    const currentA = listA.filter(s => s.current);
    assert.equal(currentA.length, 1, 'exactly one row is the caller');
    assert.equal(currentA[0].label, 'iPhone · Safari');

    // B revokes A
    const listB = await (await t.fetch('/api/sessions', { cookie: cookieB })).json();
    const idA = currentA[0].id;
    assert.ok(listB.some(s => s.id === idA && !s.current));
    const res = await t.fetch(`/api/sessions/${idA}`, { method: 'DELETE', cookie: cookieB });
    assert.equal(res.status, 204);

    const { code } = await withTimeout(cA.closed, 3000, 'revoked socket close');
    assert.equal(code, 4001);
    assert.equal(cA.bye?.reason, 'revoked');
    assert.equal((await t.fetch('/api/me', { cookie: cookieA })).status, 401);

    // B is unaffected
    assert.equal(cB.ws.readyState, cB.ws.OPEN);
    assert.equal((await t.fetch('/api/me', { cookie: cookieB })).status, 200);
    assert.equal((await t.fetch(`/api/sessions/${idA}`, { method: 'DELETE', cookie: cookieB })).status, 404, 'already gone');
    assert.equal((await t.fetch('/api/sessions/zz', { method: 'DELETE', cookie: cookieB })).status, 404);
    cB.close();
    await cB.closed;
  });

  test('logout-all revokes every session and closes every socket', async () => {
    const cookieA = await t.login();
    const cookieB = await t.login();
    const cA = await t.connectSynced(cookieA);
    const cB = await t.connectSynced(cookieB);
    const res = await t.fetch('/api/logout-all', { method: 'POST', cookie: cookieA });
    assert.equal(res.status, 204);
    const [a, b] = await withTimeout(Promise.all([cA.closed, cB.closed]), 3000, 'sockets close after logout-all');
    assert.equal(a.code, 4001);
    assert.equal(b.code, 4001);
    assert.equal((await t.fetch('/api/me', { cookie: cookieA })).status, 401);
    assert.equal((await t.fetch('/api/me', { cookie: cookieB })).status, 401);
  });

  test('link token: claim once → session; second claim → 401', async () => {
    const cookie = await t.login();
    const res = await t.fetch('/api/link', { method: 'POST', cookie });
    assert.equal(res.status, 200);
    const { token, expiresAt } = await res.json();
    assert.match(token, /^[A-Za-z0-9_-]{32}$/);
    assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 5 * 60e3 + 1000);

    const claim = () => t.fetch('/api/link/claim', { method: 'POST', headers: JSON_CT, body: JSON.stringify({ token }) });
    const first = await claim();
    assert.equal(first.status, 204);
    const phoneCookie = cookieFromResponse(first);
    assert.match(phoneCookie, /^sid=[A-Za-z0-9_-]{43}$/);
    assert.notEqual(phoneCookie, cookie);
    assert.equal((await t.fetch('/api/me', { cookie: phoneCookie })).status, 200);

    const second = await claim();
    assert.equal(second.status, 401);
    assert.equal(cookieFromResponse(second), null);

    // an unauthenticated caller cannot mint tokens; a bogus token is rejected
    assert.equal((await t.fetch('/api/link', { method: 'POST' })).status, 401);
    const bogus = await t.fetch('/api/link/claim', { method: 'POST', headers: JSON_CT, body: JSON.stringify({ token: 'x'.repeat(32) }) });
    assert.equal(bogus.status, 401);
    clearAttempts();
  });

  test('sliding session: /api/me works and lists the caller', async () => {
    const cookie = await t.login();
    const res = await t.fetch('/api/me', { cookie });
    assert.equal(res.status, 200);
    const me = await res.json();
    assert.match(me.id, /^[0-9a-f]{12}$/);
    assert.equal(me.appName, 'Shelf');
  });

  // Last: it leaves 127.0.0.1 locked out for the window, so it cleans up after itself.
  test('6th failed login within the window → 429 with Retry-After', async () => {
    clearAttempts();
    for (let i = 1; i <= 5; i++) {
      const res = await postLogin('wrong-' + i);
      assert.equal(res.status, 401, `attempt ${i} is still a plain 401`);
    }
    const res = await postLogin('wrong-6');
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error, 'rate_limited');
    const retry = Number(res.headers.get('retry-after'));
    assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 15 * 60, `Retry-After seconds, got ${res.headers.get('retry-after')}`);
    // even the right password is refused while locked out
    assert.equal((await postLogin('test')).status, 429);
    // failures are persisted, so a restart does not reset the lockout
    await t.restart();
    assert.equal((await postLogin('test')).status, 429);
    clearAttempts();
    assert.equal((await postLogin('test')).status, 204);
  });
});

// A plaintext PASSWORD is hashed at boot; the salt is persisted so the hash - and the pwfp session fingerprint -
// is stable across restarts (SPEC §3: only a password *change* logs every device out, SPEC §9 step 27).
describe('plaintext PASSWORD across restarts', () => {
  let t;
  before(async () => { t = await startTestServer({ PASSWORD: 'test' }); });
  after(async () => { await t.stop(); });

  test('sessions survive a restart with the same PASSWORD; a changed PASSWORD revokes them all', async () => {
    const cookie = await t.login('test');
    assert.equal((await t.fetch('/api/me', { cookie })).status, 200);
    assert.ok(existsSync(join(t.dataDir, 'password.salt')), 'salt persisted on the data volume');
    assert.ok(!existsSync(join(t.dataDir, 'password.hash')), 'no generated password when PASSWORD is set');

    await t.restart();
    assert.equal((await t.fetch('/api/me', { cookie })).status, 200, 'same password → still logged in');
    const c = await t.connectSynced(cookie);
    assert.equal(c.hello.t, 'hello');
    c.close(); await c.closed;

    await t.restart({ PASSWORD: 'changed' });
    assert.equal((await t.fetch('/api/me', { cookie })).status, 401, 'changed password → every session revoked');
    const old = await t.fetch('/api/login', { method: 'POST', headers: JSON_CT, body: JSON.stringify({ password: 'test' }) });
    assert.equal(old.status, 401, 'old password no longer works');
    t.app.db.exec('DELETE FROM login_attempts');
    const fresh = await t.login('changed');
    assert.equal((await t.fetch('/api/me', { cookie: fresh })).status, 200);
  });
});

describe('auth hardening', () => {
  let t;
  before(async () => { t = await startTestServer(); });
  after(async () => { await t.stop(); });

  test('logout-all invalidates outstanding QR link tokens', async () => {
    const cookie = await t.login();
    const { token } = await (await t.fetch('/api/link', { method: 'POST', cookie })).json();
    assert.equal((await t.fetch('/api/logout-all', { method: 'POST', cookie })).status, 204);
    const claim = await t.fetch('/api/link/claim', { method: 'POST', headers: JSON_CT, body: JSON.stringify({ token }) });
    assert.equal(claim.status, 401);
  });

  test('a parallel wrong-password burst is capped at LOGIN_MAX_FAILS', async () => {
    t.app.db.exec('DELETE FROM login_attempts');
    const rs = await Promise.all(Array.from({ length: 12 }, () =>
      t.fetch('/api/login', { method: 'POST', headers: JSON_CT, body: JSON.stringify({ password: 'nope' }) })));
    const codes = rs.map((r) => r.status);
    assert.equal(codes.filter((c) => c === 401).length, 5);   // LOGIN_MAX_FAILS default
    assert.equal(codes.filter((c) => c === 429).length, 7);
    t.app.db.exec('DELETE FROM login_attempts');
    assert.equal((await t.login()).startsWith('sid='), true);   // owner is never locked out for good
  });
});
