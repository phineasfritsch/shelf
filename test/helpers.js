// Shared test helpers: in-process server on a temp DATA_DIR, login/fetch/ws helpers, and a
// Yjs sync client that speaks the SPEC §5 wire format (hello → 0x00 sv → 0x01 diff + 0x00 sv → 0x01 + synced).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { start } from '../server.js';
import { silentLogger } from '../lib/log.js';
import { hashPasswordSync } from '../lib/password.js';

export const PASSWORD = 'test';
// A plaintext PASSWORD is re-salted at every boot, which changes the password fingerprint and makes the
// server revoke every session on restart. Tests that close() + start() on the same DATA_DIR need sessions
// to survive, so the server is booted with a fixed PASSWORD_HASH of 'test' (computed once per test file).
const PASSWORD_HASH = hashPasswordSync(PASSWORD);

// Polls fn() (sync or async) every `interval` ms until it returns truthy; resolves with that value.
// Rejects after `timeout` ms with `label`, or immediately if fn throws.
export async function waitUntil(fn, { timeout = 3000, interval = 10, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) throw new Error(`waitUntil: timed out after ${timeout} ms waiting for ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rejects a promise if it does not settle within `ms`.
export function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

// Frame helpers for the binary wire format: first byte is the tag (0x00 state vector, 0x01 update).
export function frame(tag, payload) {
  const out = new Uint8Array(1 + payload.length);
  out[0] = tag;
  out.set(payload, 1);
  return out;
}

// Extracts 'sid=<token>' from a Response's Set-Cookie header (null when absent).
export function cookieFromResponse(res) {
  const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of all) {
    const first = c.split(';')[0].trim();
    if (first.startsWith('sid=')) return first;
  }
  return null;
}

// Yjs sync client over an already-constructed ws.WebSocket. Attaches listeners synchronously (before 'open')
// so the hello / 0x00 frames - which can arrive in the same tick as 'open' - are never missed.
function createSyncClient(ws, ydoc, { origin } = {}) {
  const ytext = ydoc.getText('t');
  const client = {
    ws, ydoc, ytext,
    hello: null, peers: null, files: null, bye: null, error: null,
    synced: false, sentStep2: false, unacked: 0, acks: 0,
    messages: [],            // every JSON control message, in order
    binary: [],              // every binary frame { tag, payload }
    closed: null,            // Promise<{ code, reason }>
    send(obj) { ws.send(JSON.stringify(obj)); },
    sendUpdate(u) { ws.send(frame(0x01, u)); client.unacked++; },
    sendRaw(data) { ws.send(data); },
    // Resolves with the next JSON message whose t === type.
    waitMessage(type, timeout = 3000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { remove(); reject(new Error(`no '${type}' message within ${timeout} ms`)); }, timeout);
        const w = { type, resolve: (m) => { clearTimeout(timer); resolve(m); } };
        const remove = () => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); };
        waiters.push(w);
      });
    },
    nextAck(timeout = 3000) { return client.waitMessage('ack', timeout); },
    // Resolves once every update this client sent has been acked (unacked === 0).
    whenSaved(timeout = 3000) { return waitUntil(() => client.unacked === 0, { timeout, label: 'acks to balance' }); },
    text() { return ytext.toString(); },
    close(code, reason) { try { ws.close(code, reason); } catch {} },
    terminate() { try { ws.terminate(); } catch {} },
  };
  const waiters = [];
  let resolveSynced, rejectSynced;
  client.syncedPromise = new Promise((resolve, reject) => { resolveSynced = resolve; rejectSynced = reject; });
  client.closed = new Promise((resolve) => {
    ws.on('close', (code, reason) => {
      ydoc.off('update', onLocalUpdate);
      resolve({ code, reason: Buffer.isBuffer(reason) ? reason.toString() : String(reason || '') });
    });
  });

  // Local edits (any origin other than 'remote'/'load') are sent as 0x01 frames once step 2 has been sent.
  const onLocalUpdate = (u, origin) => {
    if (origin === 'remote' || origin === 'load') return;
    if (!client.sentStep2 || ws.readyState !== WebSocket.OPEN) return;
    client.sendUpdate(u);
  };
  ydoc.on('update', onLocalUpdate);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
      const tag = buf[0];
      const payload = new Uint8Array(buf.buffer, buf.byteOffset + 1, buf.length - 1);
      client.binary.push({ tag, payload });
      if (tag === 0x00) {
        // Server state vector → reply with what the server lacks, then our own state vector.
        const diff = Y.encodeStateAsUpdate(ydoc, payload);
        client.sendUpdate(diff);
        ws.send(frame(0x00, Y.encodeStateVector(ydoc)));
        client.sentStep2 = true;
      } else if (tag === 0x01) {
        Y.applyUpdate(ydoc, payload, 'remote');
      } else {
        client.error = new Error(`unknown binary tag ${tag}`);
      }
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (err) { client.error = err; return; }
    client.messages.push(msg);
    switch (msg.t) {
      case 'hello': client.hello = msg; client.peers = msg.peers; break;
      case 'peers': client.peers = msg.n; break;
      case 'files': client.files = msg; break;
      case 'ack': client.acks++; client.unacked = Math.max(0, client.unacked - 1); break;
      case 'synced': client.synced = true; resolveSynced(client); break;
      case 'bye': client.bye = msg; break;
      case 'error': client.error = new Error(`server error: ${JSON.stringify(msg)}`); break;
      default: break;
    }
    for (const w of [...waiters]) {
      if (w.type === msg.t) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    }
  });
  ws.on('error', (err) => { client.error = err; rejectSynced(err); });
  ws.on('unexpected-response', (req, res) => {
    const err = new Error(`unexpected response ${res.statusCode}`);
    err.status = res.statusCode;
    client.error = err;
    rejectSynced(err);
    res.resume();
    req.destroy();
  });
  return client;
}

// Starts the app on port 0 in a fresh temp DATA_DIR. Returns a handle with login/fetch/ws helpers.
export async function startTestServer(overrides = {}) {
  const dataDir = overrides.DATA_DIR || await mkdtemp(join(tmpdir(), 'shelf-test-'));
  const sockets = new Set();

  const t = {
    app: null, base: '', port: 0, dataDir,

    async login(password = PASSWORD, init = {}) {
      const res = await t.fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
        body: JSON.stringify({ password }),
        ...init,
      });
      if (res.status !== 204) throw new Error(`login failed: ${res.status} ${await res.text()}`);
      const cookie = cookieFromResponse(res);
      if (!cookie) throw new Error('login: no sid cookie in response');
      return cookie;
    },

    // fetch(path, { cookie, origin, ...init }) - never follows redirects; Origin defaults to the server's own
    // origin (pass origin: null to omit it); cookie is the 'sid=…' string from login().
    fetch(path, { cookie, origin = t.base, headers, ...init } = {}) {
      const h = new Headers(headers || {});
      if (cookie) h.set('Cookie', cookie);
      if (origin !== null && !h.has('Origin')) h.set('Origin', origin);
      return fetch(t.base + path, { redirect: 'manual', ...init, headers: h });
    },

    // Raw node:http request (for cases fetch cannot express: no Content-Length, custom framing).
    // Resolves { status, headers, body: Buffer }. `body` may be a Buffer/string or an array of chunks (sent chunked).
    raw(method, path, { headers = {}, body, cookie, origin = t.base } = {}) {
      return new Promise((resolve, reject) => {
        const h = { ...headers };
        if (cookie) h.Cookie = cookie;
        if (origin !== null && !('Origin' in h)) h.Origin = origin;
        const req = httpRequest({ host: '127.0.0.1', port: t.port, method, path, headers: h }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        });
        req.on('error', reject);
        if (Array.isArray(body)) { for (const c of body) req.write(c); req.end(); }
        else req.end(body);
      });
    },

    // Raw WebSocket (ws package). Resolves on open; rejects with err.status on a non-101 upgrade response.
    ws(cookie, { origin = t.base, path = '/ws', headers = {} } = {}) {
      return new Promise((resolve, reject) => {
        const h = { ...headers };
        if (cookie) h.Cookie = cookie;
        if (origin !== null && !('Origin' in h)) h.Origin = origin;
        const sock = new WebSocket(`ws://127.0.0.1:${t.port}${path}`, { headers: h });
        sockets.add(sock);
        sock.on('close', () => sockets.delete(sock));
        sock.once('open', () => resolve(sock));
        sock.on('error', (err) => reject(err));
        sock.on('unexpected-response', (req, res) => {
          const err = new Error(`unexpected response ${res.statusCode}`);
          err.status = res.statusCode;
          res.resume();
          req.destroy();
          reject(err);
        });
      });
    },

    // Upgrade status code for the given cookie/origin: 101 when the handshake succeeds (socket is closed
    // again), else the HTTP status the server answered with.
    async wsStatus(cookie, opts = {}) {
      try {
        const sock = await t.ws(cookie, opts);
        sock.close();
        return 101;
      } catch (err) {
        if (err.status) return err.status;
        throw err;
      }
    },

    // Full sync client: connects, runs the handshake, resolves once {t:'synced'} arrives.
    // Later 0x01 frames are applied to `ydoc` with origin 'remote'; local edits are sent automatically.
    connectSynced(cookie, ydoc = new Y.Doc(), { origin = t.base, timeout = 5000 } = {}) {
      const h = {};
      if (cookie) h.Cookie = cookie;
      if (origin !== null) h.Origin = origin;
      const sock = new WebSocket(`ws://127.0.0.1:${t.port}/ws`, { headers: h });
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      const client = createSyncClient(sock, ydoc, { origin });
      return withTimeout(client.syncedPromise, timeout, 'sync handshake');
    },

    // Close the running app and start a new one on the same DATA_DIR (port may change).
    async restart(overrides2 = {}) {
      await t.stop({ keepData: true });
      await boot({ ...overrides, ...overrides2, DATA_DIR: dataDir });
      return t;
    },

    async stop({ keepData = false } = {}) {
      for (const s of sockets) { try { s.terminate(); } catch {} }
      sockets.clear();
      if (t.app) {
        const app = t.app;
        t.app = null;
        await app.close({ reason: 'shutdown', timeoutMs: 2000 });
      }
      if (!keepData) {
        await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
      }
    },
  };

  async function boot(ov) {
    const pw = ('PASSWORD' in ov || 'PASSWORD_HASH' in ov || 'PASSWORD_FILE' in ov) ? {} : { PASSWORD_HASH };
    t.app = await start({
      DATA_DIR: dataDir, PORT: 0, HOST: '127.0.0.1', logger: silentLogger,
      ...pw,
      ...ov,
    });
    t.port = t.app.port;
    t.base = `http://127.0.0.1:${t.port}`;
  }
  await boot(overrides);
  return t;
}

export { Y };
