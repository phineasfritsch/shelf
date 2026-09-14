// WebSocket client: connect / backoff / heartbeat, the two-step Yjs handshake, frame codec,
// ack counter, status state machine, and localStorage persistence of the doc.
//
//   const net = createNet({ doc, isComposing: () => editor.composing });
//   net.restoreLocal();          // before the initial paint
//   net.connect();
//   net.on('status', s => ...);  // 'connecting' | 'live' | 'saving' | 'reconnecting' | 'offline'
//
// Wire format (SPEC section 5): binary frames are `tag ‖ payload` where tag 0x00 = state vector and
// 0x01 = Yjs update; text frames are JSON control messages `{ t: ... }`.
import * as Y from './vendor/yjs.js';

const PROTO = 1;
const TAG_SV = 0x00;
const TAG_UPDATE = 0x01;
const PING_MS = 20000;          // client heartbeat while visible
const DEAD_MS = 30000;          // no frame after a ping for this long -> drop and reconnect
const WAKE_DEAD_MS = 4000;      // after a wake-up probe: a half-open socket is torn down this fast
const WATCH_MS = 2000;          // how often the dead-socket check runs
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 10000;
const PERSIST_MS = 300;         // localStorage debounce
const DOC_KEY = 'shelf.doc';
let lastPersisted = null;
const LS_PREFIX = 'shelf.';
const PROTO_RELOAD_KEY = 'protoReload';
const CLOSE_LOGOUT = 4001;

// ---------- base64 helpers (chunked: String.fromCharCode.apply has an argument-count limit) ----------

export function toBase64(u8) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CHUNK, u8.length)));
  }
  return btoa(bin);
}

export function fromBase64(s) {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// Remove every localStorage key belonging to this app (used on logout/revoke so the next user of
// this browser profile does not inherit the text).
export function clearLocalState() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_PREFIX)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    // storage unavailable (private mode, blocked) — nothing to clear
  }
}

export function createNet({ doc, isComposing = () => false } = {}) {
  if (!doc) throw new Error('createNet: doc is required');

  // ---- state ----
  let ws = null;                  // the current WebSocket (null when closed)
  let synced = false;             // server said {t:'synced'} on this connection
  let sentStep2 = false;          // we replied to the server's state vector on this connection
  let unacked = 0;                // 0x01 frames sent without an {t:'ack'} yet
  const pendingRemote = [];       // remote updates held while an IME composition is open
  let status = 'connecting';
  let limits = null;
  let peers = 0;
  let skew = 0;                   // serverNow - Date.now()
  let attempts = 0;               // consecutive failed/closed connections (drives backoff)
  let everClosed = false;         // 'connecting' is only shown before the first close
  let stopped = true;             // net.close() called / not yet connected
  let loggedOut = false;          // 4001 handled — never reconnect, never persist again
  let byeReason = null;           // reason from the last {t:'bye'} on this connection
  let lastFrameAt = 0;            // Date.now() of the last frame of any kind
  let pingSentAt = 0;             // Date.now() of the last ping we sent
  let deadAfter = DEAD_MS;        // how long the current outstanding ping may go unanswered
  let reconnectTimer = null, pingTimer = null, watchTimer = null, persistTimer = null;

  // ---- events ----
  const listeners = new Map();
  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => { const set = listeners.get(event); if (set) set.delete(fn); };
  }
  function emit(event, ...args) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try { fn(...args); } catch (err) { console.error(`net: '${event}' listener failed`, err); }
    }
  }

  // ---- status: derived from the state machine, never from readyState alone ----
  function computeStatus() {
    if (ws && ws.readyState === WebSocket.OPEN) return (synced && unacked === 0) ? 'live' : 'saving';
    if (!everClosed) return 'connecting';
    return navigator.onLine === false ? 'offline' : 'reconnecting';
  }
  function renderStatus() {
    const next = computeStatus();
    if (next === status) return;
    status = next;
    emit('status', status);
  }

  // ---- localStorage persistence ----
  function persistNow() {
    // Two tabs share one localStorage key: fold whatever the other tab saved into this doc first (CRDT merge,
    // duplicates are no-ops) so a tab that dies before syncing does not lose its offline edits to our overwrite.
    try {
      const prev = localStorage.getItem(DOC_KEY);
      if (prev && prev !== lastPersisted) Y.applyUpdate(doc, fromBase64(prev), 'load');
    } catch { /* corrupt or blocked: ignore, we overwrite below */ }
    persistTimer = null;
    if (loggedOut) return;
    try { const enc = toBase64(Y.encodeStateAsUpdate(doc)); localStorage.setItem(DOC_KEY, enc); lastPersisted = enc; } catch (err) {
      // quota exceeded or storage blocked: the server copy is authoritative anyway
      console.warn('net: could not persist doc locally', err);
    }
  }
  function persistLocal() {
    if (loggedOut) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(persistNow, PERSIST_MS);
  }
  function restoreLocal() {
    let raw = null;
    try { raw = localStorage.getItem(DOC_KEY); } catch { return false; }
    if (!raw) return false;
    try {
      Y.applyUpdate(doc, fromBase64(raw), 'load');
      return true;
    } catch (err) {
      console.warn('net: discarding corrupt local doc', err);
      try { localStorage.removeItem(DOC_KEY); } catch { /* ignore */ }
      return false;
    }
  }

  // ---- sending ----
  function sendBinary(tag, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const frame = new Uint8Array(payload.length + 1);
    frame[0] = tag;
    frame.set(payload, 1);
    try { ws.send(frame); return true; } catch (err) { console.warn('net: send failed', err); return false; }
  }
  function sendJson(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch (err) { console.warn('net: send failed', err); return false; }
  }

  // Every local transaction goes out as one 0x01 frame, no debounce. Updates from the server
  // ('remote') and from localStorage ('load') are never echoed back; the handshake's
  // encodeStateAsUpdate(doc, serverSV) covers anything produced before sentStep2.
  doc.on('update', (update, origin) => {
    if (origin !== 'load') persistLocal();
    if (origin === 'remote' || origin === 'load') return;
    if (ws && ws.readyState === WebSocket.OPEN && sentStep2) {
      if (sendBinary(TAG_UPDATE, update)) { unacked++; renderStatus(); }
    }
  });

  // ---- remote updates ----
  function applyRemote(u) {
    try { Y.applyUpdate(doc, u, 'remote'); } catch (err) {
      // The server only relays what it applied itself; a bad frame here is a bug, not a user problem.
      console.error('net: remote update failed to apply', err);
    }
  }
  function flushPending() {
    while (pendingRemote.length) applyRemote(pendingRemote.shift());
  }
  function onRemoteUpdate(u) {
    if (isComposing()) pendingRemote.push(u); else applyRemote(u);
    emit('remote', u);
  }

  // ---- inbound frames ----
  function onBinary(buf) {
    const bytes = new Uint8Array(buf);
    if (bytes.length === 0) return;
    const tag = bytes[0];
    const payload = bytes.subarray(1);
    if (tag === TAG_SV) {
      // Step 1 from the server: reply with everything it lacks, then ask for everything we lack.
      let mine;
      try { mine = Y.encodeStateAsUpdate(doc, payload); } catch (err) {
        console.error('net: bad state vector from server', err);
        return;
      }
      if (sendBinary(TAG_UPDATE, mine)) unacked++;
      sendBinary(TAG_SV, Y.encodeStateVector(doc));
      sentStep2 = true;
      renderStatus();
    } else if (tag === TAG_UPDATE) {
      onRemoteUpdate(payload);
    } else {
      console.warn('net: unknown binary tag', tag);
    }
  }

  function onJson(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { console.warn('net: bad JSON frame'); return; }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hello': {
        if (msg.proto !== PROTO) {
          // A deploy changed the protocol under us: reload once so the new client code loads.
          let reload = false;
          try {
            if (!sessionStorage.getItem(PROTO_RELOAD_KEY)) { sessionStorage.setItem(PROTO_RELOAD_KEY, '1'); reload = true; }
          } catch { /* sessionStorage blocked: fall through, keep going with what we have */ }
          if (reload) { location.reload(); return; }
          console.warn('net: protocol mismatch, server proto', msg.proto);
        } else {
          try { sessionStorage.removeItem(PROTO_RELOAD_KEY); } catch { /* ignore */ }
        }
        if (typeof msg.now === 'number') skew = msg.now - Date.now();
        if (msg.limits && typeof msg.limits === 'object') limits = msg.limits;
        if (typeof msg.peers === 'number') peers = msg.peers;
        attempts = 0;             // the server is really talking to us: reset backoff
        emit('hello', { proto: msg.proto, now: msg.now, limits, peers });
        break;
      }
      case 'synced':
        synced = true;
        renderStatus();
        emit('synced');
        break;
      case 'ack':
        if (unacked > 0) unacked--;
        renderStatus();
        break;
      case 'files':
        emit('files', { files: Array.isArray(msg.files) ? msg.files : [], usedBytes: Number(msg.usedBytes) || 0 });
        break;
      case 'peers':
        peers = typeof msg.n === 'number' ? msg.n : peers;
        emit('peers', { n: peers });
        break;
      case 'pong':
        break;                     // lastFrameAt was already refreshed
      case 'ping':
        sendJson({ t: 'pong' });
        break;
      case 'bye':
        byeReason = typeof msg.reason === 'string' ? msg.reason : 'unknown';
        emit('bye', { reason: byeReason });
        break;
      case 'error':
        console.warn('net: server reported a protocol error');
        break;
      default:
        console.warn('net: unknown message', msg.t);
    }
  }

  function onMessage(data) {
    lastFrameAt = Date.now();
    if (data instanceof ArrayBuffer) onBinary(data);
    else if (typeof data === 'string') onJson(data);
    else if (data && typeof data.arrayBuffer === 'function') {
      // Blob (should not happen with binaryType 'arraybuffer', but never drop an update)
      data.arrayBuffer().then((buf) => { if (!loggedOut) onBinary(buf); }).catch(() => {});
    }
  }

  // ---- heartbeat ----
  function startHeartbeat() {
    stopHeartbeat();
    pingTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (document.visibilityState !== 'visible') return;
      pingSentAt = Date.now();
      deadAfter = DEAD_MS;
      sendJson({ t: 'ping' });
    }, PING_MS);
    // Dead-socket detection: we sent a ping and nothing at all came back for DEAD_MS. Pings only go
    // out while visible, so a hidden tab is never torn down for being quiet.
    watchTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (pingSentAt > lastFrameAt && Date.now() - pingSentAt > deadAfter) {
        console.warn(`net: no reply to ping for ${Math.round(deadAfter / 1000)} s, reconnecting`);
        dropSocket(ws, 1006);
      }
    }, WATCH_MS);
  }
  function stopHeartbeat() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  }

  // ---- connection lifecycle ----
  function onOpen() {
    synced = false;
    sentStep2 = false;
    unacked = 0;
    byeReason = null;
    lastFrameAt = Date.now();
    pingSentAt = 0;
    startHeartbeat();
    renderStatus();
  }

  function onClose(code) {
    stopHeartbeat();
    ws = null;
    everClosed = true;
    synced = false;
    sentStep2 = false;
    if (code === CLOSE_LOGOUT || byeReason === 'revoked' || byeReason === 'logout') { logout(); return; }
    renderStatus();
    if (!stopped) scheduleReconnect();
  }

  // Detach a socket and treat it as closed right now. A half-open TCP connection can keep a
  // browser WebSocket in CLOSING for a long time after close(); we do not wait for that.
  function dropSocket(sock, code) {
    if (!sock) return;
    sock.onopen = sock.onmessage = sock.onerror = sock.onclose = null;
    try { sock.close(); } catch { /* already closed */ }
    if (sock === ws) onClose(code);
  }

  function scheduleReconnect() {
    if (reconnectTimer || loggedOut || stopped) return;
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(attempts, 10));
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));   // ± 20 % jitter
    attempts++;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  function connect() {
    if (loggedOut) return;
    stopped = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    let sock;
    try { sock = new WebSocket(url); } catch (err) {
      console.warn('net: WebSocket constructor failed', err);
      everClosed = true;
      renderStatus();
      scheduleReconnect();
      return;
    }
    sock.binaryType = 'arraybuffer';
    ws = sock;
    sock.onopen = () => { if (sock === ws) onOpen(); };
    sock.onmessage = (ev) => { if (sock === ws) onMessage(ev.data); };
    sock.onerror = () => { /* a close event always follows */ };
    sock.onclose = (ev) => { if (sock === ws) onClose(ev.code); };
    renderStatus();
  }

  function close() {
    stopped = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const sock = ws;
    ws = null;
    stopHeartbeat();
    if (sock) {
      sock.onopen = sock.onmessage = sock.onerror = sock.onclose = null;
      try { sock.close(1000); } catch { /* ignore */ }
    }
    synced = false;
    sentStep2 = false;
    everClosed = true;
    renderStatus();
  }

  // Session revoked / logged out: forget everything local and go to the login page.
  function logout() {
    if (loggedOut) return;
    loggedOut = true;
    stopped = true;
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    stopHeartbeat();
    clearLocalState();
    renderStatus();
    location.replace('/login');
  }

  // Something suggests the network is back or the user is looking again: retry immediately
  // (backoff reset) if closed, or probe the socket right away if it looks open.
  function wake() {
    if (loggedOut || stopped) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (document.visibilityState === 'visible') {
        // Probe a possibly half-open socket (phone slept): measure from now, and give it only a few seconds.
        // pingSentAt must be strictly later than lastFrameAt or the watch above would never consider it outstanding.
        lastFrameAt = Date.now() - 1;
        pingSentAt = Date.now();
        deadAfter = WAKE_DEAD_MS;
        sendJson({ t: 'ping' });
      }
      return;
    }
    if (ws && ws.readyState === WebSocket.CONNECTING) return;
    attempts = 0;
    connect();
  }

  window.addEventListener('online', () => { renderStatus(); wake(); });
  window.addEventListener('offline', renderStatus);
  window.addEventListener('pageshow', wake);
  window.addEventListener('focus', wake);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
  // Flush the debounced localStorage write when the page is going away (best effort).
  window.addEventListener('pagehide', () => { if (persistTimer) { clearTimeout(persistTimer); persistNow(); } });

  return {
    connect,
    close,
    on,
    restoreLocal,
    flushPending,
    serverNow: () => Date.now() + skew,
    get status() { return status; },
    get limits() { return limits; },
    get peers() { return peers; },
    get connected() { return !!ws && ws.readyState === WebSocket.OPEN; },
    get synced() { return synced; },
    get unacked() { return unacked; },
    get pendingCount() { return pendingRemote.length; },
  };
}
