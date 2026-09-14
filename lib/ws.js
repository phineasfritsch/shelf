// WebSocket endpoint (/ws): upgrade auth, Yjs handshake, update fan-out, file-list broadcast,
// peer count, heartbeat, 60 s session revalidation, revoke/logout/shutdown closes.
//
// Wire format (SPEC §5): binary frames are `tag ‖ payload` with tag 0x00 = state vector, 0x01 = update;
// text frames are JSON control messages `{t: ...}`.
// Close codes: 4000 protocol error, 4001 revoked/logout, 1001 shutdown.
import { WebSocketServer, WebSocket } from 'ws';
import { originOk } from './http.js';
import { uaLabel } from './auth.js';

const TAG_SV = 0x00;
const TAG_UPDATE = 0x01;
const PROTO = 1;
const PRESENCE_COLORS = ['#2563eb', '#059669', '#d97706', '#db2777', '#7c3aed', '#0891b2', '#ca8a04', '#dc2626'];
const MAX_PAYLOAD = 4 * 1024 * 1024;
const PING_MS = 25_000;
const REVALIDATE_MS = 60_000;
const CLOSE_GRACE_MS = 2_000; // after a server-initiated close, terminate peers that never answer the close frame

export function createWs({ cfg, log, server, auth, doc, files }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const clients = new Set();
  let nextCid = 1; // every accepted socket until its 'close' event
  let stopped = false;

  // ---------- send helpers (never throw; a dead socket is simply skipped) ----------

  function sendJson(ws, obj) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(obj)); } catch (err) { log.warn('ws: send failed', { err }); }
  }

  function sendBinary(ws, tag, payload) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(Buffer.concat([Buffer.from([tag]), payload]), { binary: true }); }
    catch (err) { log.warn('ws: send failed', { err }); }
  }

  function broadcastJson(obj, exceptWs) {
    const text = JSON.stringify(obj);
    for (const c of clients) {
      if (c === exceptWs || c.readyState !== WebSocket.OPEN) continue;
      try { c.send(text); } catch (err) { log.warn('ws: broadcast failed', { err }); }
    }
  }

  function broadcastPeers() { broadcastJson({ t: 'peers', n: clients.size }); }

  function filesMessage() { return { t: 'files', ...files.list() }; }

  function broadcastFiles() {
    if (clients.size === 0) return;
    let msg;
    try { msg = filesMessage(); } catch (err) { log.error('ws: files.list failed', { err }); return; }
    broadcastJson(msg);
  }

  // Say goodbye, start the closing handshake, and terminate if the peer never completes it.
  function sayBye(ws, reason, code) {
    sendJson(ws, { t: 'bye', reason });
    try { ws.close(code, reason); } catch { try { ws.terminate(); } catch {} }
    const t = setTimeout(() => { if (ws.readyState !== WebSocket.CLOSED) { try { ws.terminate(); } catch {} } }, CLOSE_GRACE_MS);
    t.unref();
  }

  function protocolError(ws, why) {
    log.warn('ws: protocol error, closing', { why });
    sendJson(ws, { t: 'error', error: why });
    try { ws.close(4000, why); } catch { try { ws.terminate(); } catch {} }
    const t = setTimeout(() => { if (ws.readyState !== WebSocket.CLOSED) { try { ws.terminate(); } catch {} } }, CLOSE_GRACE_MS);
    t.unref();
  }

  // ---------- upgrade: path → session → Origin → handshake ----------

  function rawReject(socket, status) {
    const text = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 503: 'Service Unavailable' }[status] || 'Error';
    try { if (socket.writable) socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`); } catch {}
    socket.destroy();
  }

  server.on('upgrade', (req, socket, head) => {
    // node's http server drops its own error listener on upgrade; without one, a reset would crash the process.
    socket.on('error', () => {});
    let pathname;
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { return rawReject(socket, 404); }
    if (pathname !== '/ws') return rawReject(socket, 404);
    if (stopped) return rawReject(socket, 503);

    Promise.resolve()
      .then(() => auth.authenticate(req))
      .then((session) => {
        if (socket.destroyed) return;
        if (!session) return rawReject(socket, 401);
        // Browsers always send Origin on WebSocket upgrades, so its absence is a non-browser or a stripping proxy: reject.
        if (req.headers.origin === undefined || !originOk(req, cfg)) {
          log.warn('ws: upgrade rejected, bad origin', { origin: String(req.headers.origin || '').slice(0, 100) });
          return rawReject(socket, 403);
        }
        if (stopped) return rawReject(socket, 503);
        wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req, session));
      })
      .catch((err) => {
        log.error('ws: upgrade failed', { err });
        rawReject(socket, 401);
      });
  });

  // ---------- per-socket ----------

  function onConnection(ws, req, session) {
    const cid = nextCid++;
    const color = PRESENCE_COLORS[cid % PRESENCE_COLORS.length];
    const label = uaLabel(req.headers['user-agent'] || '');
    const st = { session, alive: true, sidHash: session.idHash, cid, color, label };
    ws.shelf = st;
    clients.add(ws);
    log.info('ws: connected', { sid: st.sidHash.slice(0, 12), clients: clients.size });

    ws.on('pong', () => { st.alive = true; });
    ws.on('error', (err) => { log.warn('ws: socket error', { err }); });
    ws.on('message', (data, isBinary) => {
      try { onMessage(ws, data, isBinary); }
      catch (err) { log.error('ws: message handler threw', { err }); protocolError(ws, 'internal'); }
    });
    ws.on('close', (code) => {
      clients.delete(ws);
      log.info('ws: closed', { sid: st.sidHash.slice(0, 12), code, clients: clients.size });
      broadcastJson({ t: 'presence-gone', cid });   // tell the others this caret is gone
      broadcastPeers();
    });

    sendJson(ws, {
      t: 'hello',
      proto: PROTO,
      now: Date.now(),
      limits: { maxFileMB: cfg.maxFileMb, ttlHours: cfg.fileTtlHours, maxTextKB: cfg.maxTextKb, storageMB: cfg.maxStorageMb },
      peers: clients.size,
      cid, color, label,   // this connection's presence identity, for the awareness overlay
    });
    sendBinary(ws, TAG_SV, doc.stateVector());
    try { sendJson(ws, filesMessage()); } catch (err) { log.error('ws: files.list failed', { err }); }
    broadcastPeers();
  }

  function toBuffer(data) {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data)) return Buffer.concat(data);
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    return Buffer.from(data);
  }

  function onMessage(ws, data, isBinary) {
    if (isBinary) {
      const buf = toBuffer(data);
      if (buf.length === 0) return protocolError(ws, 'empty_frame');
      const tag = buf[0];
      const payload = buf.subarray(1);
      if (tag === TAG_UPDATE) {
        // applyUpdate synchronously persists and fans out (doc.js) before we get here, so the ack
        // always follows persistence. An update with nothing new fires no event but is still acked.
        const failuresBefore = doc.persistFailures;
        try { doc.applyUpdate(payload, ws); }
        catch (err) { log.warn('ws: malformed update', { err }); return protocolError(ws, 'bad_update'); }
        if (doc.persistFailures !== failuresBefore) {
          // Applied in memory but not on disk: do not ack. Closing makes the client reconnect and re-send it.
          sendJson(ws, { t: 'error', reason: 'persist_failed' });
          return ws.close(1011, 'persist failed');
        }
        // Server-authoritative text cap: the client also enforces maxTextChars, but the server is the only place a
        // limit is real. If an update grew the doc past the cap, trim the overflow (broadcasts to everyone like any edit).
        if (cfg.maxTextChars && doc.getText().length > cfg.maxTextChars) {
          try { doc.trimTo(cfg.maxTextChars); log.warn('ws: text exceeded MAX_TEXT_KB, trimmed', { sid: ws.shelf.sidHash.slice(0, 12) }); }
          catch (err) { log.error('ws: text trim failed', { err }); }
        }
        sendJson(ws, { t: 'ack' });
        return;
      }
      if (tag === TAG_SV) {
        let diff;
        try { diff = doc.diff(payload); }
        catch (err) { log.warn('ws: malformed state vector', { err }); return protocolError(ws, 'bad_state_vector'); }
        sendBinary(ws, TAG_UPDATE, diff);
        sendJson(ws, { t: 'synced' });
        return;
      }
      return protocolError(ws, 'unknown_tag');
    }

    let msg;
    try { msg = JSON.parse(toBuffer(data).toString('utf8')); } catch { return protocolError(ws, 'bad_json'); }
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return protocolError(ws, 'bad_json');
    if (msg.t === 'ping') { sendJson(ws, { t: 'pong' }); return; }
    if (msg.t === 'presence') {
      // Relay a caret/selection position to the other devices. Identity (cid/color/label) is stamped by the server,
      // never taken from the client. anchor/head are non-negative integer character offsets; anything else is dropped.
      const { session: _s, cid: c, color: col, label: lab } = ws.shelf;
      const a = Number.isInteger(msg.a) && msg.a >= 0 ? msg.a : 0;
      const h = Number.isInteger(msg.h) && msg.h >= 0 ? msg.h : a;
      const typing = msg.typing === true;
      broadcastJson({ t: 'presence', cid: c, color: col, label: lab, a, h, typing }, ws);
      return;
    }
    // Unknown control messages are ignored (forward compatibility), not fatal.
    log.debug('ws: ignoring unknown message', { t: msg.t.slice(0, 40) });
  }

  // ---------- fan-out from the document and the file store ----------

  const unsubscribeDoc = doc.subscribe((update, origin) => {
    if (clients.size === 0) return;
    const frame = Buffer.concat([Buffer.from([TAG_UPDATE]), update]);
    for (const c of clients) {
      if (c === origin || c.readyState !== WebSocket.OPEN) continue;
      try { c.send(frame, { binary: true }); } catch (err) { log.warn('ws: broadcast failed', { err }); }
    }
  });
  const unsubscribeFiles = files.onChange(broadcastFiles);

  // ---------- timers: liveness pings and session revalidation ----------

  const pingTimer = setInterval(() => {
    for (const c of clients) {
      const st = c.shelf;
      if (c.readyState !== WebSocket.OPEN) continue;
      if (!st.alive) {
        log.info('ws: no pong, terminating', { sid: st.sidHash.slice(0, 12) });
        try { c.terminate(); } catch {}
        continue;
      }
      st.alive = false;
      try { c.ping(); } catch {}
    }
  }, PING_MS);
  pingTimer.unref();

  const revalidateTimer = setInterval(() => {
    for (const c of clients) {
      if (c.readyState !== WebSocket.OPEN) continue;
      let ok = false;
      try { ok = auth.sessionExists(c.shelf.sidHash); } catch (err) { log.error('ws: session check failed', { err }); ok = true; }
      if (!ok) {
        log.info('ws: session gone, closing', { sid: c.shelf.sidHash.slice(0, 12) });
        sayBye(c, 'revoked', 4001);
      }
    }
  }, REVALIDATE_MS);
  revalidateTimer.unref();

  // ---------- public API ----------

  return {
    clientCount() { return clients.size; },
    broadcastJson,
    broadcastFiles,
    closeSessions(idHashes, reason) {
      const all = idHashes === '*';
      const set = all ? null : new Set(idHashes);
      const r = reason === 'logout' ? 'logout' : 'revoked';
      for (const c of [...clients]) {
        if (all || set.has(c.shelf.sidHash)) sayBye(c, r, 4001);
      }
    },
    shutdown(reason = 'shutdown') {
      if (stopped) return;
      stopped = true;
      clearInterval(pingTimer);
      clearInterval(revalidateTimer);
      unsubscribeDoc();
      unsubscribeFiles();
      for (const c of [...clients]) sayBye(c, 'shutdown', 1001);
      log.info('ws: shutdown', { reason, clients: clients.size });
    },
  };
}
