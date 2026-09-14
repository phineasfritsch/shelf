// App shell. Boot order (SPEC section 5 "Client"): Y.Doc → localStorage restore → editor initial paint → net.connect().
// Everything else here is glue: status pill + title, peers badge, file grid wiring, intake (picker / camera /
// paste / drop / share inbox), toolbar (Copy all / Paste / Clear / count / URL chips), the ⋯ menu and its sheets
// (History / Devices / Link a phone / Storage / Log out), toasts, --vh, and service-worker registration.
// CSP: no inline scripts/styles/handlers - all DOM is built with createElement/textContent.
import * as Y from './vendor/yjs.js';
import { createNet, clearLocalState } from './net.js';
import { createEditor } from './editor.js';
import { createPresence } from './presence.js';
import { createUploads } from './uploads.js';
import { createFilesView, formatSize } from './files-view.js';
import { findUrls } from './textdiff.js';

let APP_NAME = 'Shelf';
const DEFAULT_MAX_TEXT_KB = 2048;   // config default; the real value arrives in `hello` and is cached for the next boot
const LIMITS_KEY = 'shelf.limits';  // cleared with every other shelf.* key on logout
const CHIP_DEBOUNCE_MS = 300;
const FLIP_MS = 1500;
const UNDO_TOAST_MS = 5000;
const TOAST_MS = 3000;
const MAX_TOASTS = 3;
const COUNT_WARN_RATIO = 0.9;
const LINK_TICK_MS = 1000;

const STATUS_TEXT = {
  live: 'Live',
  saving: 'Saving…',
  reconnecting: 'Reconnecting…',
  offline: 'Offline · saved locally',
  connecting: 'Connecting…',
};

// ---------- tiny DOM helpers ----------

function $(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`app: #${id} is missing from index.html`);
  return node;
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function button(className, label, onClick) {
  const b = el('button', className, label);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
function clearChildren(node) { while (node.firstChild) node.removeChild(node.firstChild); }

// Button label flip ("Copied!" for 1.5 s) that restores the original label even when flipped twice quickly.
function flip(btn, label, ms = FLIP_MS) {
  if (btn.dataset.label == null) btn.dataset.label = btn.textContent;
  btn.textContent = label;
  clearTimeout(btn._flipTimer);
  btn._flipTimer = setTimeout(() => { btn.textContent = btn.dataset.label; }, ms);
}

function relTime(at, now = Date.now()) {
  const d = Math.max(0, now - at);
  if (d < 45e3) return 'just now';
  if (d < 3600e3) return `${Math.max(1, Math.round(d / 60e3))} min ago`;
  if (d < 86400e3) return `${Math.round(d / 3600e3)} h ago`;
  if (d < 7 * 86400e3) { const n = Math.round(d / 86400e3); return n <= 1 ? 'yesterday' : `${n} days ago`; }
  return new Date(at).toLocaleDateString();
}

// navigator.clipboard needs a secure context; the hidden-textarea + execCommand fallback covers http://LAN-IP.
async function copyText(text) {
  try {
    if (!navigator.clipboard || !window.isSecureContext) throw new Error('no clipboard api');
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const prev = document.activeElement;
    const ta = el('textarea', 'f-clip');
    ta.value = text;
    ta.setAttribute('aria-hidden', 'true');
    ta.tabIndex = -1;
    document.body.appendChild(ta);
    let ok = false;
    try {
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(0, text.length);
      ok = document.execCommand('copy');
    } catch { ok = false; }
    ta.remove();
    if (prev && typeof prev.focus === 'function') { try { prev.focus({ preventScroll: true }); } catch { /* noop */ } }
    return ok;
  }
}

function readCachedLimits() {
  try {
    const raw = localStorage.getItem(LIMITS_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}
function cacheLimits(limits) {
  try { localStorage.setItem(LIMITS_KEY, JSON.stringify(limits)); } catch { /* storage blocked: next boot uses the default */ }
}

// ---------- elements ----------

const ui = {
  textarea: $('t'),
  status: $('status'), statusText: $('status-text'), statusLive: $('status-live'), peers: $('peers'),
  menuBtn: $('menu-btn'), menu: $('menu'), menuStorage: $('menu-storage'),
  copyBtn: $('copy-btn'), pasteBtn: $('paste-btn'), clearBtn: $('clear-btn'), count: $('count'), chips: $('chips'),
  addBtn: $('add-btn'), cameraBtn: $('camera-btn'), fileInput: $('file-input'), cameraInput: $('camera-input'),
  filesGrid: $('files-grid'), drop: $('drop'), toasts: $('toasts'),
  sheets: { history: $('sheet-history'), devices: $('sheet-devices'), link: $('sheet-link'), storage: $('sheet-storage') },
  bodies: { history: $('history-body'), devices: $('devices-body'), link: $('link-body'), storage: $('storage-body') },
};

const state = {
  usedBytes: 0,
  fileCount: 0,
  loggingOut: false,
  linkTimer: null,
};

// ---------- toasts ----------
// toast(text, { action?: { label, onClick }, ms? }) → { close() }. Bottom of the screen, aria-live region in the HTML.

function toast(text, opts = {}) {
  const node = el('div', 'toast');
  node.appendChild(el('span', 'toast-text', String(text)));
  let timer = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    node.classList.add('toast--out');
    const done = () => node.remove();
    node.addEventListener('animationend', done, { once: true });
    setTimeout(done, 300); // reduced-motion disables the animation, so never rely on animationend alone
  };
  if (opts.action && typeof opts.action.onClick === 'function') {
    node.appendChild(button('toast-action', opts.action.label || 'Undo', () => {
      close();
      try { opts.action.onClick(); } catch (err) { console.error('toast action failed', err); }
    }));
  }
  ui.toasts.appendChild(node);
  while (ui.toasts.children.length > MAX_TOASTS) ui.toasts.firstChild.remove();
  const ms = Number.isFinite(opts.ms) ? opts.ms : (opts.action ? UNDO_TOAST_MS : TOAST_MS);
  timer = setTimeout(close, ms);
  return { close };
}

// ---------- API helper ----------
// Same-origin JSON fetch. 401 anywhere means the session is gone → forget local state, go to /login.

class ApiError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

function goToLogin() {
  if (state.loggingOut) return;
  state.loggingOut = true;
  try { net.close(); } catch { /* not created yet */ }
  clearLocalState();
  location.replace('/login');
}

async function request(path, { method = 'GET', body, keepalive = false } = {}) {
  const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' }, keepalive };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, init); } catch { throw new ApiError(0, 'network', 'Cannot reach the server'); }
  if (res.status === 401) { goToLogin(); throw new ApiError(401, 'unauthorized', 'Logged out'); }
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (res.status !== 204 && ct.includes('application/json')) {
    try { data = await res.json(); } catch { data = null; }
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `http_${res.status}`, data && data.message);
  return data;
}

// ---------- boot: doc → restore → editor paint → connect ----------

const doc = new Y.Doc();
const ytext = doc.getText('t');

let editor = null; // assigned below; net asks for editor.composing lazily
const net = createNet({ doc, isComposing: () => !!(editor && editor.composing) });
net.restoreLocal();

const cachedLimits = readCachedLimits();
const bootMaxTextChars = Math.round((Number(cachedLimits && cachedLimits.maxTextKB) || DEFAULT_MAX_TEXT_KB) * 1024);
editor = createEditor({ doc, ytext, textarea: ui.textarea, net, maxTextChars: bootMaxTextChars, toast });

let view = null;
const uploads = createUploads({
  getLimits: () => net.limits || cachedLimits || {},
  toast,
  onChange: () => { if (view) view.render(); },
});

const api = {
  remove: async (id) => {
    try { return await request(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive: true }); }
    catch (err) { if (err.status === 404) return null; throw err; } // already gone (expired/deleted elsewhere): not a failure
  },
  keep: (id, keep) => request(`/api/files/${encodeURIComponent(id)}`, { method: 'PATCH', body: { keep: !!keep } }),
};
view = createFilesView({ container: ui.filesGrid, uploads, serverNow: () => net.serverNow(), toast, api });

// Live text limit: the server's value once `hello` arrived, else what the editor was built with.
function maxTextChars() {
  const kb = Number(net.limits && net.limits.maxTextKB);
  return kb > 0 ? Math.round(kb * 1024) : bootMaxTextChars;
}

// ---------- live presence: remote carets + typing hint ----------
// The overlay renders OTHER devices' carets (net 'presence' / 'presence-gone'); here we publish THIS
// device's caret. It is throttled so caret moves and typing never turn into a per-keystroke firehose.
const presence = createPresence({ textarea: ui.textarea, net, typingHint: document.getElementById('typing-hint') });

const PRESENCE_THROTTLE_MS = 90;   // fastest cadence we send our caret at (server contract: ~80–120 ms)
const TYPING_IDLE_MS = 1000;       // typing:true self-clears this long after the last input
let presenceTimer = null;          // trailing-edge throttle timer
let presenceLastSent = 0;
let pendingTyping = false;         // OR of "was typing" seen during the current throttle window
let typingIdleTimer = null;

// head = the moving end of the selection (caret). Respect a backward selection so the caret bar lands
// on the correct end; a===h is a collapsed caret.
function currentSelection() {
  let s = ui.textarea.selectionStart, e = ui.textarea.selectionEnd;
  if (typeof s !== 'number') s = 0;
  if (typeof e !== 'number') e = s;
  return ui.textarea.selectionDirection === 'backward' ? { a: e, h: s } : { a: s, h: e };
}
function flushPresence(typing) {
  presenceLastSent = Date.now();
  presenceTimer = null;
  const { a, h } = currentSelection();
  net.sendPresence({ a, h, typing });
}
function sendPresence(typing) {
  if (typing) pendingTyping = true;
  if (presenceTimer) return;                       // a trailing send is already queued; it reads the latest selection
  const since = Date.now() - presenceLastSent;
  if (since >= PRESENCE_THROTTLE_MS) { const t = pendingTyping; pendingTyping = false; flushPresence(t); }
  else presenceTimer = setTimeout(() => { const t = pendingTyping; pendingTyping = false; flushPresence(t); }, PRESENCE_THROTTLE_MS - since);
}

ui.textarea.addEventListener('input', () => {
  sendPresence(true);
  if (typingIdleTimer) clearTimeout(typingIdleTimer);
  typingIdleTimer = setTimeout(() => { typingIdleTimer = null; sendPresence(false); }, TYPING_IDLE_MS);
});
const onCaretMove = () => sendPresence(false);
ui.textarea.addEventListener('keyup', onCaretMove);
ui.textarea.addEventListener('click', onCaretMove);
ui.textarea.addEventListener('select', onCaretMove);
ui.textarea.addEventListener('focus', onCaretMove);
document.addEventListener('selectionchange', () => { if (document.activeElement === ui.textarea) sendPresence(false); });
ui.textarea.addEventListener('blur', () => {
  if (typingIdleTimer) { clearTimeout(typingIdleTimer); typingIdleTimer = null; }
  if (presenceTimer) { clearTimeout(presenceTimer); presenceTimer = null; }
  flushPresence(false);                            // final caret + typing cleared, sent immediately
});
// Re-announce our caret whenever the peer set changes (a newcomer triggers everyone to resend, so it
// sees the existing carets) and once we're synced on a fresh connection.
net.on('peers', () => sendPresence(false));
net.on('synced', () => sendPresence(false));

let lastAnnounced = 'connecting';
// APP_NAME: the HTML is static, so ask the server once and rename the header/title if it was customised.
request('/api/me').then((me) => {
  if (!me || typeof me.appName !== 'string' || !me.appName || me.appName === 'Shelf') return;
  const h = document.querySelector('.hdr-name'); if (h) h.textContent = me.appName;
  APP_NAME = me.appName; document.title = document.title.replace('Shelf', me.appName);
}).catch(() => { /* not fatal */ });
// ---------- status pill, title, peers ----------

function renderStatus(status) {
  const s = STATUS_TEXT[status] ? status : 'connecting';
  ui.status.className = `pill pill--${s}`;
  ui.statusText.textContent = STATUS_TEXT[s];
  // Screen readers: announce only meaningful transitions, never the Saving…/Live flicker on every keystroke.
  if (s === 'reconnecting' || s === 'offline' || (s === 'live' && (lastAnnounced === 'reconnecting' || lastAnnounced === 'offline'))) {
    if (ui.statusLive) ui.statusLive.textContent = STATUS_TEXT[s];
    lastAnnounced = s;
  }
  ui.status.title = STATUS_TEXT[s];
  document.title = (s === 'live' ? '' : '• ') + APP_NAME;
}

function renderPeers(n) {
  if (!(n >= 1)) { ui.peers.hidden = true; return; }
  ui.peers.textContent = `${n} connected`;
  ui.peers.title = `${n} open ${n === 1 ? 'connection' : 'connections'} (tabs count too)`;
  ui.peers.hidden = false;
}

function renderStorageSummary() {
  const cap = storageCapBytes();
  ui.menuStorage.textContent = cap ? `${formatSize(state.usedBytes)} of ${formatSize(cap)}` : formatSize(state.usedBytes);
  if (ui.sheets.storage.open) fillStorage();
}

net.on('status', renderStatus);
net.on('hello', ({ limits, peers }) => {
  if (limits) cacheLimits(limits);
  renderPeers(peers);
  renderCount();
  renderStorageSummary();
});
net.on('peers', ({ n }) => renderPeers(n));
net.on('files', ({ files, usedBytes }) => {
  state.usedBytes = usedBytes;
  state.fileCount = files.length;
  uploads.reconcile(files);
  view.setFiles(files, usedBytes);
  renderStorageSummary();
});

renderStatus(net.status);
net.connect();

// ---------- toolbar: count, chips, Copy all, Paste, Clear ----------

function renderCount() {
  const n = ytext.length;
  const limit = maxTextChars();
  ui.count.textContent = n.toLocaleString();
  ui.count.title = `${n.toLocaleString()} of ${limit.toLocaleString()} characters`;
  ui.count.classList.toggle('count--warn', n > limit * COUNT_WARN_RATIO);
}

let chipTimer = null;
let chipKey = '';
function renderChips() {
  chipTimer = null;
  const urls = findUrls(editor.getText());
  const key = urls.join('\n');
  if (key === chipKey) return;
  chipKey = key;
  clearChildren(ui.chips);
  for (const url of urls) {
    const chip = el('div', 'chip');
    chip.appendChild(el('span', 'chip-url', url)).title = url;
    const open = el('a', 'chip-btn chip-open', 'Open ↗');
    open.href = url;                       // findUrls only yields http(s) URLs, so no javascript: risk
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.title = `Open ${url}`;
    chip.appendChild(open);
    const copy = button('chip-btn chip-copy', 'Copy', async () => { flip(copy, (await copyText(url)) ? 'Copied!' : 'Copy failed'); });
    copy.title = `Copy ${url}`;
    chip.appendChild(copy);
    ui.chips.appendChild(chip);
  }
  ui.chips.hidden = urls.length === 0;
}
function scheduleChips() {
  if (chipTimer) clearTimeout(chipTimer);
  chipTimer = setTimeout(renderChips, CHIP_DEBOUNCE_MS);
}

editor.onChange(() => { renderCount(); scheduleChips(); });
// The other device cleared the whole box: offer Undo here as well (a 5 s Undo on the other screen is no help to this one).
editor.onRemoteClear((prevText) => {
  toast('Cleared from another device - Undo', { ms: 10000, action: { label: 'Undo', onClick: () => editor.restoreText(prevText) } });
});
renderCount();
renderChips();

ui.copyBtn.addEventListener('click', async () => {
  flip(ui.copyBtn, (await editor.copyAll()) ? 'Copied!' : 'Copy failed');
});

// Paste button: readText() exists only in secure contexts; on plain http the OS paste gesture still works.
const canReadClipboard = !!(window.isSecureContext && navigator.clipboard && typeof navigator.clipboard.readText === 'function');
ui.pasteBtn.hidden = !canReadClipboard;
ui.pasteBtn.addEventListener('click', async () => {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { toast('Clipboard blocked - paste with Ctrl+V / long-press instead'); return; }
  if (!text) { toast('Clipboard is empty'); return; }
  editor.insertAtCaret(text);
  editor.focusDesktop();
});

// "Cleared - Undo": undo only while the clear is still the newest undo step; if the user typed since,
// undoing would revert their typing instead, so put the old text back as an appended block.
function undoableToast(label, previousText) {
  const stack = editor.undoManager.undoStack;
  const step = stack.length ? stack[stack.length - 1] : null;
  toast(label, {
    ms: UNDO_TOAST_MS,
    action: {
      label: 'Undo',
      onClick: () => {
        const s = editor.undoManager.undoStack;
        if (step && s.length && s[s.length - 1] === step) { editor.undo(); return; }
        if (previousText) editor.append(previousText); else toast('Nothing to undo');
      },
    },
  });
}

ui.clearBtn.addEventListener('click', () => {
  const cleared = editor.clear();
  if (!cleared) return;
  undoableToast('Cleared', cleared);
  editor.focusDesktop();
});

// Replace the whole text in ONE 'ui' transaction (one undo step, rendered through the editor's observer).
function replaceText(text) {
  if (text.length > maxTextChars()) { toast('That snapshot is larger than the text limit'); return false; }
  const um = editor.undoManager;
  um.stopCapturing();
  doc.transact(() => {
    if (ytext.length) ytext.delete(0, ytext.length);
    if (text) ytext.insert(0, text);
  }, 'ui');
  um.stopCapturing();
  return true;
}

// ---------- intake: picker, camera, paste, drag & drop ----------

function enqueueFiles(list) {
  const files = Array.from(list || []).filter((f) => f instanceof Blob);
  if (files.length) uploads.enqueue(files);
  return files.length;
}

ui.addBtn.addEventListener('click', () => ui.fileInput.click());
ui.cameraBtn.addEventListener('click', () => ui.cameraInput.click());
for (const input of [ui.fileInput, ui.cameraInput]) {
  input.addEventListener('change', () => {
    enqueueFiles(input.files);
    input.value = ''; // picking the same file again must fire `change` again
  });
}

function isEditable(node) {
  if (!node || node === document.body) return false;
  const tag = node.tagName;
  return tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || node.isContentEditable === true;
}

// Files on the clipboard (screenshot, copied file) → upload, never a base64 blob in the text.
// Text pasted while the box is not focused → appended on a new line; inside the box it is a normal splice.
document.addEventListener('paste', (e) => {
  const cd = e.clipboardData;
  if (!cd) return;
  if (cd.files && cd.files.length) {
    e.preventDefault();
    enqueueFiles(cd.files);
    return;
  }
  if (isEditable(document.activeElement)) return;
  const text = cd.getData('text/plain');
  if (!text) return;
  e.preventDefault();
  editor.append(text);
});

const hasFiles = (dt) => !!dt && Array.from(dt.types || []).includes('Files');
let dragDepth = 0;
function hideDrop() { dragDepth = 0; ui.drop.hidden = true; }
document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e.dataTransfer)) return;
  e.preventDefault();
  dragDepth++;
  ui.drop.hidden = false;
});
document.addEventListener('dragover', (e) => {
  if (!hasFiles(e.dataTransfer)) return;
  e.preventDefault();                       // required for `drop` to fire
  e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', (e) => {
  if (!hasFiles(e.dataTransfer)) return;
  dragDepth = Math.max(0, dragDepth - 1);   // enter/leave pairs fire for every child crossed; only 0 means "left the page"
  if (dragDepth === 0) ui.drop.hidden = true;
});
document.addEventListener('drop', (e) => {
  const dt = e.dataTransfer;
  hideDrop();
  if (!hasFiles(dt)) return;                // dragging selected text into the box stays native
  e.preventDefault();
  enqueueFiles(dt.files);
});
window.addEventListener('blur', hideDrop);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') hideDrop(); });

// ---------- share inbox (filled by sw.js from the Android share sheet) ----------

async function drainInbox() {
  if (!('caches' in window)) return { files: 0, texts: 0 };
  let cache;
  try { cache = await caches.open('share-inbox'); } catch { return { files: 0, texts: 0 }; }
  const files = [];
  const texts = [];
  let keys = [];
  try { keys = await cache.keys(); } catch { return { files: 0, texts: 0 }; }
  for (const req of keys) {
    try {
      const res = await cache.match(req);
      if (res) {
        const kind = res.headers.get('X-Kind');
        if (kind === 'file') {
          let name = 'shared';
          try { name = decodeURIComponent(res.headers.get('X-Name') || 'shared') || 'shared'; } catch { /* keep default */ }
          const type = res.headers.get('X-Type') || 'application/octet-stream';
          files.push(new File([await res.blob()], name, { type }));
        } else if (kind === 'text') {
          const t = await res.text();
          if (t) texts.push(t);
        }
      }
      await cache.delete(req);
    } catch (err) {
      console.warn('app: inbox entry skipped', err);
    }
  }
  // Any web page can POST to /share (the SW cannot tell the OS share sheet from a cross-site form), so never
  // apply stashed content silently: the user confirms with one tap.
  const n = files.length + texts.length;
  if (n) {
    toast(`${n} shared item${n === 1 ? '' : 's'} received`, {
      ms: 20000,
      action: { label: 'Add', onClick: () => { if (files.length) uploads.enqueue(files); for (const t of texts) editor.append(t); } },
    });
  }
  return { files: files.length, texts: texts.length };
}

// ---------- ⋯ menu ----------

function menuOpen() { return !ui.menu.hidden; }
function openMenu() {
  ui.menu.hidden = false;
  ui.menuBtn.setAttribute('aria-expanded', 'true');
  const first = ui.menu.querySelector('.menu-item');
  if (first) first.focus();
}
function closeMenu(refocus = false) {
  if (!menuOpen()) return;
  ui.menu.hidden = true;
  ui.menuBtn.setAttribute('aria-expanded', 'false');
  if (refocus) ui.menuBtn.focus();
}
ui.menuBtn.addEventListener('click', () => { if (menuOpen()) closeMenu(); else openMenu(); });
document.addEventListener('click', (e) => {
  if (!menuOpen()) return;
  if (ui.menu.contains(e.target) || ui.menuBtn.contains(e.target)) return;
  closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (!menuOpen()) return;
  const items = Array.from(ui.menu.querySelectorAll('.menu-item'));
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
});
ui.menu.addEventListener('click', (e) => {
  const item = e.target.closest('.menu-item');
  if (!item) return;
  closeMenu();
  const action = item.dataset.action;
  if (action === 'logout') logout(false);
  else if (action === 'logout-all') logout(true);
  else openSheet(action);
});

// ---------- sheets (native <dialog>: focus trap, Escape, inert background) ----------

const fillers = { history: fillHistory, devices: fillDevices, link: fillLink, storage: fillStorage };

function openSheet(name) {
  const d = ui.sheets[name];
  if (!d) return;
  if (!d.open) {
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  }
  fillers[name]();
}
function closeSheet(d) {
  if (typeof d.close === 'function' && d.open) d.close(); else d.removeAttribute('open');
  const opener = document.querySelector('button[aria-controls="menu"]') || document.querySelector('button[aria-haspopup]');
  if (opener && (document.activeElement === document.body || document.activeElement === null)) opener.focus();
}
for (const [name, d] of Object.entries(ui.sheets)) {
  d.querySelector('.sheet-close').addEventListener('click', () => closeSheet(d));
  d.addEventListener('click', (e) => { if (e.target === d) closeSheet(d); }); // a click on ::backdrop targets the dialog itself
  d.addEventListener('close', () => { if (name === 'link') stopLinkTimer(); });
}

function sheetMessage(body, text, cls = 'sheet-msg') {
  clearChildren(body);
  body.appendChild(el('p', cls, text));
}
function errorText(err, fallback) {
  if (err && err.status === 0) return 'Cannot reach the server';
  return err && err.message && err.message !== err.code ? err.message : fallback;
}

// ----- History -----

async function fillHistory() {
  const body = ui.bodies.history;
  sheetMessage(body, 'Loading…');
  let list;
  try { list = await request('/api/history'); } catch (err) { sheetMessage(body, errorText(err, 'Could not load history'), 'sheet-msg sheet-msg--error'); return; }
  if (!ui.sheets.history.open) return;
  clearChildren(body);
  if (!Array.isArray(list) || list.length === 0) {
    sheetMessage(body, 'No snapshots yet. A snapshot is taken 30 seconds after the text stops changing.');
    return;
  }
  body.appendChild(el('p', 'sheet-msg', 'Earlier versions of the text. Tap one to view and restore it.'));
  const ul = el('div', 'hist-list');
  for (const snap of list) {
    const item = button('hist-item', null, () => showSnapshot(snap.id));
    const meta = el('div', 'hist-meta');
    const when = el('time', 'hist-at', relTime(snap.at));
    when.dateTime = new Date(snap.at).toISOString();
    when.title = new Date(snap.at).toLocaleString();
    meta.append(when, el('span', 'hist-len', `${Number(snap.len || 0).toLocaleString()} chars`));
    item.appendChild(meta);
    item.appendChild(el('div', 'hist-preview', snap.preview || '(empty)'));
    ul.appendChild(item);
  }
  body.appendChild(ul);
}

async function showSnapshot(id) {
  const body = ui.bodies.history;
  sheetMessage(body, 'Loading…');
  let snap;
  try { snap = await request(`/api/history/${encodeURIComponent(id)}`); }
  catch (err) { sheetMessage(body, errorText(err, 'Could not load that snapshot'), 'sheet-msg sheet-msg--error'); return; }
  if (!ui.sheets.history.open) return;
  clearChildren(body);
  const meta = el('p', 'sheet-msg');
  meta.textContent = `${new Date(snap.at).toLocaleString()} · ${String(snap.text || '').length.toLocaleString()} chars`;
  body.appendChild(meta);
  body.appendChild(el('pre', 'hist-text', snap.text || ''));
  const actions = el('div', 'sheet-actions');
  actions.appendChild(button('btn btn--primary', 'Restore', () => {
    const before = editor.getText();
    if (!replaceText(String(snap.text || ''))) return;
    closeSheet(ui.sheets.history);
    undoableToast('Restored', before);
  }));
  actions.appendChild(button('btn', 'Copy', async (e) => {
    const b = e.currentTarget;               // null after the await, so grab it first
    flip(b, (await copyText(snap.text || '')) ? 'Copied!' : 'Copy failed');
  }));
  actions.appendChild(button('btn btn--ghost', 'Back', fillHistory));
  body.appendChild(actions);
}

// ----- Devices -----

async function fillDevices() {
  const body = ui.bodies.devices;
  sheetMessage(body, 'Loading…');
  let list;
  try { list = await request('/api/sessions'); } catch (err) { sheetMessage(body, errorText(err, 'Could not load devices'), 'sheet-msg sheet-msg--error'); return; }
  if (!ui.sheets.devices.open) return;
  clearChildren(body);
  body.appendChild(el('p', 'sheet-msg', 'Every browser that is logged in. Revoking one logs it out immediately.'));
  const wrap = el('div', 'dev-list');
  for (const s of Array.isArray(list) ? list : []) {
    const row = el('div', `dev-item${s.current ? ' dev-item--current' : ''}`);
    const info = el('div', 'dev-info');
    const label = el('div', 'dev-label', s.label || 'Unknown device');
    if (s.current) label.appendChild(el('span', 'dev-tag', 'this device'));
    info.appendChild(label);
    info.appendChild(el('div', 'dev-sub', `Last seen ${relTime(s.lastSeenAt)} · since ${new Date(s.createdAt).toLocaleDateString()}`));
    row.appendChild(info);
    if (!s.current) {
      row.appendChild(button('btn btn--danger', 'Revoke', async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        try {
          await request(`/api/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
          toast(`${s.label || 'Device'} logged out`);
        } catch (err) {
          toast(err && err.status === 404 ? 'That device was already logged out' : errorText(err, 'Could not revoke'));
        }
        fillDevices();
      }));
    }
    wrap.appendChild(row);
  }
  body.appendChild(wrap);
}

// ----- Link a phone -----

function stopLinkTimer() {
  if (state.linkTimer) { clearInterval(state.linkTimer); state.linkTimer = null; }
}

function svgFromString(svgText) {
  const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const root = parsed.documentElement;
  if (!root || root.nodeName !== 'svg' || parsed.querySelector('parsererror')) return null;
  return document.importNode(root, true);
}

async function fillLink() {
  const body = ui.bodies.link;
  stopLinkTimer();
  sheetMessage(body, 'Generating a code…');
  let link;
  try { link = await request('/api/link', { method: 'POST' }); } catch (err) { sheetMessage(body, errorText(err, 'Could not create a link'), 'sheet-msg sheet-msg--error'); return; }
  if (!ui.sheets.link.open) return;
  // On localhost/127.0.0.1 the page's own origin is unreachable from a phone: prefer a LAN address the server reports.
  let origin = location.origin;
  const loopback = /^(localhost|127.0.0.1|[::1])$/i.test(location.hostname);
  if (loopback && Array.isArray(link.lanAddresses) && link.lanAddresses.length) {
    origin = `${location.protocol}//${link.lanAddresses[0]}${location.port ? ':' + location.port : ''}`;
  }
  const url = `${origin}/#link=${link.token}`;
  const lanNote = loopback && origin === location.origin ? ' This page is open on localhost, so the phone must be able to reach this computer at the same address.' : '';
  clearChildren(body);
  body.appendChild(el('p', 'sheet-msg', 'Scan this with the phone’s camera, or open the address below on it. It logs the phone in without typing the password.' + lanNote));

  let svg = null;
  try {
    const { default: qrcode } = await import('./vendor/qrcode.js');
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    // The SVG string is generated locally from our own URL (no user data); it carries only presentation
    // attributes, no style="" - safe under the CSP. Parsed with DOMParser and adopted, never innerHTML.
    svg = svgFromString(qr.createSvgTag({ cellSize: 4, margin: 2 }));
  } catch (err) {
    console.warn('app: QR code unavailable', err);
  }
  if (!ui.sheets.link.open) return;
  if (svg) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'QR code that logs a phone in');
    const box = el('div', 'qr');
    box.appendChild(svg);
    body.appendChild(box);
  }
  const code = el('code', 'link-url', url);
  body.appendChild(code);
  const timer = el('p', 'link-timer');
  body.appendChild(timer);
  const actions = el('div', 'sheet-actions');
  actions.appendChild(button('btn', 'Copy address', async (e) => {
    const b = e.currentTarget;
    flip(b, (await copyText(url)) ? 'Copied!' : 'Copy failed');
  }));
  actions.appendChild(button('btn btn--ghost', 'New code', fillLink));
  body.appendChild(actions);

  const tick = () => {
    const left = Math.max(0, Math.round((link.expiresAt - net.serverNow()) / 1000));
    if (left <= 0) {
      timer.textContent = 'This code has expired - generate a new one.';
      timer.classList.add('link-timer--expired');
      stopLinkTimer();
      return;
    }
    const m = Math.floor(left / 60), s = left % 60;
    timer.textContent = `Single use · expires in ${m}:${String(s).padStart(2, '0')}`;
  };
  tick();
  state.linkTimer = setInterval(tick, LINK_TICK_MS);
}

// ----- Storage -----

function storageCapBytes() {
  const mb = Number(net.limits && net.limits.storageMB);
  return mb > 0 ? Math.round(mb * 1024 * 1024) : 0;
}
function ttlText(hours) {
  const h = Number(hours);
  if (!(h > 0)) return 'never (files stay until deleted)';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} minutes`;
  if (h < 48) return `${Math.round(h * 10) / 10} hours`;
  return `${Math.round(h / 24 * 10) / 10} days`;
}
function fillStorage() {
  const body = ui.bodies.storage;
  clearChildren(body);
  const lim = net.limits || cachedLimits || {};
  const cap = storageCapBytes();
  const rows = [
    ['Used by files', cap ? `${formatSize(state.usedBytes)} of ${formatSize(cap)}` : formatSize(state.usedBytes)],
    ['Files', String(state.fileCount)],
    ['Files expire after', ttlText(lim.ttlHours)],
    ['Largest upload', lim.maxFileMB ? `${lim.maxFileMB} MB` : '-'],
    ['Text box limit', lim.maxTextKB ? `${lim.maxTextKB} KB (${ytext.length.toLocaleString()} chars now)` : '-'],
  ];
  if (cap) {
    const meter = el('progress', 'storage-meter');
    meter.max = cap;
    meter.value = Math.min(cap, state.usedBytes);
    meter.setAttribute('aria-label', 'Storage used');
    body.appendChild(meter);
  }
  const list = el('dl', 'stats');
  for (const [k, v] of rows) {
    const row = el('div', 'stat');
    row.appendChild(el('dt', 'stat-k', k));
    row.appendChild(el('dd', 'stat-v', v));
    list.appendChild(row);
  }
  body.appendChild(list);
  body.appendChild(el('p', 'sheet-msg', 'Kept files never expire and still count towards storage.'));
}

// ----- Log out -----

async function logout(everywhere) {
  if (state.loggingOut) return;
  if (everywhere && !window.confirm('Log out on every device, including this one?')) return;
  state.loggingOut = true;
  net.close();                                // do not let the 4001 race the fetch
  try {
    await request(everywhere ? '/api/logout-all' : '/api/logout', { method: 'POST' });
  } catch (err) {
    if (err && err.status === 401) return;     // already logged out - goToLogin() is on its way
    state.loggingOut = false;
    toast(errorText(err, 'Log out failed'));
    net.connect();
    return;
  }
  clearLocalState();                          // the next user of this browser must not inherit the text
  location.replace('/login');
}

// ---------- viewport height (keyboard-aware), service worker, URL housekeeping ----------

function setVh() {
  const vv = window.visualViewport;
  const h = (vv && vv.height) || window.innerHeight;
  if (h > 0) document.documentElement.style.setProperty('--vh', `${Math.round(h)}px`);
  // Height hidden by the on-screen keyboard (0 on desktop): toasts are lifted by this much.
  document.documentElement.style.setProperty('--kb', `${Math.max(0, Math.round(window.innerHeight - h))}px`);
}
setVh();
if (window.visualViewport) window.visualViewport.addEventListener('resize', setVh);
window.addEventListener('resize', setVh);
window.addEventListener('orientationchange', () => setTimeout(setVh, 100));

if (window.isSecureContext && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => console.warn('app: service worker not registered', err));
}

// Already logged in but opened via a QR link: the token is not needed, keep it out of the URL.
if (/^#link=/.test(location.hash)) {
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
}

(async () => {
  let shared = false;
  try {
    const u = new URL(location.href);
    if (u.searchParams.get('shared') === '1') {
      shared = true;
      u.searchParams.delete('shared');
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    }
  } catch { /* ignore */ }
  const got = await drainInbox();
  if (got.files || got.texts) {
    const parts = [];
    if (got.files) parts.push(`${got.files} file${got.files === 1 ? '' : 's'}`);
    if (got.texts) parts.push('text');
    toast(`Received ${parts.join(' and ')} from the share sheet`);
  } else if (shared) {
    toast('Nothing arrived from the share sheet - try Add files');
  }
})();

editor.focusDesktop();
