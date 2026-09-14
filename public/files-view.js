// File grid: upload cards (progress / rate / Cancel / Retry) + file cards (thumb or MIME icon, name,
// size, countdown, Open / Download / Share / Copy link / Keep / Delete-with-undo). All DOM via createElement,
// no inline styles, no innerHTML. Cards are keyed by id and patched in place so progress ticks and list
// broadcasts never re-create <img> elements.
//
//   const view = createFilesView({ container, uploads, serverNow: () => net.serverNow(), toast, api });
//   view.setFiles(files, usedBytes);   // on every `files` message (after uploads.reconcile(files))
//   view.render();                     // on uploads.onChange
//
// api  = { remove(id) → Promise, keep(id, keep) → Promise<FileMeta|any> }   (app.js; 401 → /login)
// toast(text, { action?: { label, onClick }, ms? }) → optional handle with .close()
//
// DOM produced (all classes prefixed f- for files, u- for uploads):
//   container
//   └─ div.f-grid[role=list]
//      ├─ div.u-card[role=listitem][data-id].u-card--queued|--uploading|--done|--error
//      │    div.u-thumb > span.f-icon.f-icon--<kind> (emoji) + span.f-badge (ext)
//      │    div.f-name[title] > span.f-name-head + span.f-name-tail
//      │    div.u-meta > span.u-size · span.u-status ("42% · 1.2 MB/s" | "Waiting…" | "Uploaded" )
//      │    progress.u-progress (value/max; no value while queued = indeterminate)
//      │    div.u-error (only in error state)
//      │    div.f-actions > button.f-btn.u-cancel | button.f-btn.u-retry + button.f-btn.u-dismiss
//      └─ div.f-card[role=listitem][data-id].f-card--kept?.f-card--soon?.f-card--deleting?.f-card--<kind>
//           a.f-thumb[href,target?] > img.f-img[loading=lazy] | span.f-icon.f-icon--<kind> + span.f-badge
//           div.f-name[title] > span.f-name-head + span.f-name-tail
//           div.f-meta > span.f-size · span.f-expiry(.f-expiry--soon|.f-expiry--kept)
//           div.f-actions > a.f-btn.f-open? · a.f-btn.f-download · button.f-btn.f-share? · button.f-btn.f-copy
//                           · button.f-btn.f-keep · button.f-btn.f-delete
//   └─ p.f-empty (hidden when the grid has cards)
//   textarea.f-clip is appended to <body> for a few ms during the execCommand copy fallback - CSS should park it
//   off-screen (position:fixed; top:0; left:0; width:1px; height:1px; opacity:0).

const INLINE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime', 'application/pdf', 'text/plain',
]);
const SHARE_MAX_BYTES = 100 * 1024 * 1024;
const SOON_MS = 12 * 3600e3;
const UNDO_MS = 12_000;        // window to undo a delete before the DELETE actually fires
const UNDO_TICK_MS = 250;      // how often the on-card countdown + shrinking bar refresh
const COUNTDOWN_MS = 60_000;
const FLIP_MS = 1500;
const ARCHIVE_RE = /^application\/(zip|x-zip-compressed|x-7z-compressed|x-rar-compressed|vnd\.rar|gzip|x-gzip|x-tar|x-bzip2|x-xz|zstd)$/;

// ---------- pure formatting helpers (exported for reuse / tests) ----------

export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// "kept" | "deletes in 6d 3h" | "deletes in 5h 12m" | "deletes in 12m" | "deletes in <1m" | "expired"
export function formatCountdown(expiresAt, now) {
  if (expiresAt == null) return 'kept';
  const ms = expiresAt - now;
  if (ms <= 0) return 'expired';
  if (ms < 60e3) return 'deletes in <1m';
  const d = Math.floor(ms / 86400e3);
  const h = Math.floor((ms % 86400e3) / 3600e3);
  const m = Math.floor((ms % 3600e3) / 60e3);
  if (d > 0) return `deletes in ${d}d ${h}h`;
  if (h > 0) return `deletes in ${h}h ${m}m`;
  return `deletes in ${m}m`;
}

export function isInline(mime) {
  const m = String(mime || '').toLowerCase();
  return INLINE_TYPES.has(m) || m.startsWith('audio/');
}

// kind ∈ image|video|audio|pdf|zip|text|other → emoji + short badge text (extension or kind)
export function iconFor(mime, name) {
  const m = String(mime || '').toLowerCase();
  let kind = 'other', emoji = '📦';
  if (m.startsWith('image/')) { kind = 'image'; emoji = '🖼️'; }
  else if (m.startsWith('video/')) { kind = 'video'; emoji = '🎬'; }
  else if (m.startsWith('audio/')) { kind = 'audio'; emoji = '🎵'; }
  else if (m === 'application/pdf') { kind = 'pdf'; emoji = '📄'; }
  else if (ARCHIVE_RE.test(m)) { kind = 'zip'; emoji = '🗜️'; }
  else if (m.startsWith('text/') || m === 'application/json' || m === 'application/xml') { kind = 'text'; emoji = '📝'; }
  const ext = /\.([a-z0-9]{1,5})$/i.exec(String(name || ''));
  const badge = ext ? ext[1].toUpperCase() : (kind === 'other' ? 'FILE' : kind.toUpperCase());
  return { kind, emoji, badge };
}

// Split a name into head + tail so CSS can ellipsise the head while the tail (extension) stays visible.
function splitName(name) {
  const cps = Array.from(String(name || ''));           // code points, so emoji / surrogate pairs are never split
  if (cps.length <= 12) return [cps.join(''), ''];
  const tailLen = Math.min(9, Math.floor(cps.length / 2));
  return [cps.slice(0, cps.length - tailLen).join(''), cps.slice(cps.length - tailLen).join('')];
}

function fileUrl(f, dl) {
  return `/f/${encodeURIComponent(f.id)}/${encodeURIComponent(f.name || 'file')}${dl ? '?dl=1' : ''}`;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function button(className, label, title) {
  const b = el('button', `f-btn ${className}`, label);
  b.type = 'button';
  if (title) { b.title = title; b.setAttribute('aria-label', title); }
  return b;
}

function shareSupported() {
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File([], 'x')] });
  } catch { return false; }
}

// navigator.clipboard when available (secure context), else a hidden textarea + execCommand('copy')
// - the fallback is what works on plain http://LAN-IP and older iOS Safari.
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

function flip(btn, label, ms = FLIP_MS) {
  const orig = btn.dataset.label ?? btn.textContent;
  btn.dataset.label = orig;
  btn.textContent = label;
  clearTimeout(btn._flipTimer);
  btn._flipTimer = setTimeout(() => { btn.textContent = orig; }, ms);
}

export function createFilesView({ container, uploads, serverNow, toast, api } = {}) {
  const now = () => { try { const n = typeof serverNow === 'function' ? serverNow() : NaN; return Number.isFinite(n) ? n : Date.now(); } catch { return Date.now(); } };
  const say = (text, opts) => { try { return toast?.(text, opts); } catch { return null; } };
  const canShare = shareSupported();

  let files = [];
  let usedBytes = 0;
  const cards = new Map();      // key ('f:<id>' | 'u:<id>') → { el, kind, refs, meta }
  const pendingDeletes = new Map(); // fileId → { timer, handle }

  const grid = el('div', 'f-grid');
  grid.setAttribute('role', 'list');
  const empty = el('p', 'f-empty', 'No files yet - add, paste or drop something and it shows up on every device.');
  container.appendChild(grid);
  container.appendChild(empty);

  // ---------- upload cards ----------

  function buildUploadCard(item) {
    const card = el('div', 'u-card');
    card.setAttribute('role', 'listitem');
    card.dataset.id = item.id;

    const thumb = el('div', 'u-thumb');
    const ic = iconFor(item.file?.type, item.name);
    thumb.appendChild(el('span', `f-icon f-icon--${ic.kind}`, ic.emoji));
    thumb.appendChild(el('span', 'f-badge', ic.badge));

    const name = el('div', 'f-name');
    name.title = item.name;
    const [head, tail] = splitName(item.name);
    name.appendChild(el('span', 'f-name-head', head));
    name.appendChild(el('span', 'f-name-tail', tail));

    const meta = el('div', 'u-meta');
    const size = el('span', 'u-size', formatSize(item.size));
    const status = el('span', 'u-status');
    meta.append(size, ' · ', status);

    const progress = el('progress', 'u-progress');
    progress.setAttribute('aria-label', `Uploading ${item.name}`);

    const error = el('div', 'u-error');
    error.hidden = true;

    const actions = el('div', 'f-actions');
    const cancelBtn = button('u-cancel', 'Cancel', `Cancel upload of ${item.name}`);
    cancelBtn.addEventListener('click', () => uploads.cancel(item.id));
    const retryBtn = button('u-retry', 'Retry', `Retry upload of ${item.name}`);
    retryBtn.addEventListener('click', () => uploads.retry(item.id));
    const dismissBtn = button('u-dismiss', 'Dismiss', `Dismiss ${item.name}`);
    dismissBtn.addEventListener('click', () => uploads.dismiss(item.id));
    actions.append(cancelBtn, retryBtn, dismissBtn);

    card.append(thumb, name, meta, progress, error, actions);
    const refs = { status, progress, error, cancelBtn, retryBtn, dismissBtn };
    updateUploadCard(card, refs, item);
    return { el: card, refs };
  }

  function updateUploadCard(card, refs, item) {
    card.className = `u-card u-card--${item.state}`;
    const { status, progress, error, cancelBtn, retryBtn, dismissBtn } = refs;
    const total = item.total || item.size || 0;
    if (item.state === 'queued') {
      status.textContent = 'Waiting…';
      progress.removeAttribute('value');
      progress.max = 1;
    } else if (item.state === 'uploading') {
      const pct = total > 0 ? Math.min(100, Math.floor(item.loaded / total * 100)) : 0;
      const rate = item.rate > 0 ? ` · ${formatSize(item.rate)}/s` : '';
      status.textContent = `${pct}% · ${formatSize(item.loaded)} of ${formatSize(total)}${rate}`;
      progress.max = total > 0 ? total : 1;
      progress.value = total > 0 ? item.loaded : 0;
    } else if (item.state === 'done') {
      status.textContent = 'Uploaded';
      progress.max = 1;
      progress.value = 1;
    } else {
      status.textContent = 'Failed';
      progress.max = 1;
      progress.value = 0;
    }
    const failed = item.state === 'error';
    error.hidden = !failed;
    error.textContent = failed ? (item.error || 'Upload failed') : '';
    cancelBtn.hidden = !(item.state === 'queued' || item.state === 'uploading');
    retryBtn.hidden = !failed;
    dismissBtn.hidden = !failed;
  }

  // ---------- file cards ----------

  function buildThumbContent(box, f) {
    while (box.firstChild) box.removeChild(box.firstChild);
    const ic = iconFor(f.mime, f.name);
    const icon = () => {
      box.appendChild(el('span', `f-icon f-icon--${ic.kind}`, ic.emoji));
      box.appendChild(el('span', 'f-badge', ic.badge));
    };
    if (f.hasThumb) {
      const img = el('img', 'f-img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.src = `/f/${encodeURIComponent(f.id)}/thumb`;
      img.addEventListener('error', () => { if (img.parentNode === box) { box.removeChild(img); icon(); } }, { once: true });
      box.appendChild(img);
    } else {
      icon();
    }
  }

  function buildFileCard(f) {
    const card = el('div', 'f-card');
    card.setAttribute('role', 'listitem');
    card.dataset.id = f.id;

    const thumb = el('a', 'f-thumb');
    thumb.rel = 'noopener';

    const name = el('div', 'f-name');

    const meta = el('div', 'f-meta');
    const size = el('span', 'f-size');
    const expiry = el('span', 'f-expiry');
    meta.append(size, ' · ', expiry);

    const actions = el('div', 'f-actions');
    const openA = el('a', 'f-btn f-open', 'Open');
    openA.target = '_blank';
    openA.rel = 'noopener noreferrer';
    const dlA = el('a', 'f-btn f-download', 'Download');
    const shareBtn = button('f-share', 'Share');
    const copyBtn = button('f-copy', 'Copy link');
    const keepBtn = button('f-keep', 'Keep');
    const delBtn = button('f-delete', 'Delete');
    actions.append(openA, dlA, shareBtn, copyBtn, keepBtn, delBtn);

    // Undo row: shown in place of the action row while a delete is pending (so it never overlaps the
    // buttons that were just tapped). Live countdown + shrinking bar + a big Undo button.
    const delRow = el('div', 'f-undo');
    delRow.hidden = true;
    const delText = el('span', 'f-undo-text', 'Deleting…');
    const undoBtn = button('f-undo-btn', 'Undo', 'Undo delete');
    const delRowTop = el('div', 'f-undo-row');
    delRowTop.append(delText, undoBtn);
    const delFill = el('div', 'f-undo-fill');
    const delTrack = el('div', 'f-undo-track');
    delTrack.appendChild(delFill);
    delRow.append(delRowTop, delTrack);

    card.append(thumb, name, meta, actions, delRow);
    const refs = { thumb, name, size, expiry, openA, dlA, shareBtn, copyBtn, keepBtn, delBtn, actions, delRow, delText, delFill, thumbKey: null };
    const entry = { el: card, refs, meta: f };

    shareBtn.addEventListener('click', () => share(entry));
    copyBtn.addEventListener('click', () => copyLink(entry));
    keepBtn.addEventListener('click', () => toggleKeep(entry));
    delBtn.addEventListener('click', () => softDelete(entry));
    // While a delete is pending the whole greyed card is one big Undo target (thumb link, undo button,
    // dead space alike). Capture so the click can never reach the thumbnail anchor and navigate away.
    card.addEventListener('click', (e) => {
      if (!pendingDeletes.has(entry.meta.id)) return;
      e.preventDefault();
      e.stopPropagation();
      undoDelete(entry.meta.id);
    }, true);

    updateFileCard(entry, f);
    return entry;
  }

  function updateFileCard(entry, f) {
    entry.meta = f;
    const { thumb, name, size, expiry, openA, dlA, shareBtn, copyBtn, keepBtn, delBtn } = entry.refs;
    const inline = isInline(f.mime);
    const kept = f.expiresAt == null;
    const deleting = pendingDeletes.has(f.id);
    const ic = iconFor(f.mime, f.name);

    // Thumbnail (rebuilt only when the id/hasThumb pair changes, so <img> is never re-created on a tick).
    const thumbKey = `${f.id}:${f.hasThumb ? 1 : 0}`;
    if (entry.refs.thumbKey !== thumbKey) { buildThumbContent(thumb, f); entry.refs.thumbKey = thumbKey; }
    thumb.href = fileUrl(f, !inline);
    if (inline) thumb.target = '_blank'; else thumb.removeAttribute('target');
    thumb.title = inline ? `Open ${f.name}` : `Download ${f.name}`;
    thumb.setAttribute('aria-label', thumb.title);

    if (name.title !== f.name) {
      name.title = f.name;
      while (name.firstChild) name.removeChild(name.firstChild);
      const [head, tail] = splitName(f.name);
      name.appendChild(el('span', 'f-name-head', head));
      name.appendChild(el('span', 'f-name-tail', tail));
    }

    size.textContent = formatSize(f.size);
    tickExpiry(entry);

    openA.hidden = !inline;
    openA.href = fileUrl(f, false);
    openA.title = `Open ${f.name}`;
    dlA.href = fileUrl(f, true);
    dlA.setAttribute('download', f.name || 'file');
    dlA.title = `Download ${f.name}`;

    shareBtn.hidden = !(canShare && f.size <= SHARE_MAX_BYTES);
    shareBtn.title = `Share ${f.name}`;
    copyBtn.title = `Copy link to ${f.name}`;
    keepBtn.textContent = keepBtn.dataset.label = kept ? 'Let expire' : 'Keep';
    keepBtn.title = kept ? `Let ${f.name} expire again` : `Keep ${f.name} (never expires)`;
    keepBtn.setAttribute('aria-pressed', kept ? 'true' : 'false');
    delBtn.title = `Delete ${f.name}`;

    for (const b of [shareBtn, copyBtn, keepBtn, delBtn]) b.disabled = deleting;
    entry.el.className = `f-card f-card--${ic.kind}${kept ? ' f-card--kept' : ''}${deleting ? ' f-card--deleting' : ''}`;
    entry.el.setAttribute('aria-busy', deleting ? 'true' : 'false');
    // Swap the action row for the undo row (never both), and keep the countdown honest across re-renders.
    entry.refs.actions.hidden = deleting;
    entry.refs.delRow.hidden = !deleting;
    if (deleting) tickDelete(f.id);
  }

  function tickExpiry(entry) {
    const f = entry.meta;
    const { expiry } = entry.refs;
    const t = now();
    const text = formatCountdown(f.expiresAt, t);
    if (expiry.textContent !== text) expiry.textContent = text;
    const kept = f.expiresAt == null;
    const soon = !kept && f.expiresAt - t < SOON_MS;
    expiry.className = `f-expiry${kept ? ' f-expiry--kept' : ''}${soon ? ' f-expiry--soon' : ''}`;
    expiry.title = kept ? 'Kept: never expires' : `Expires ${new Date(f.expiresAt).toLocaleString()}`;
    entry.el.classList.toggle('f-card--soon', soon);
  }

  // ---------- actions ----------

  async function share(entry) {
    const f = entry.meta;
    const btn = entry.refs.shareBtn;
    if (btn.disabled) return;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Sharing…';
    try {
      const res = await fetch(fileUrl(f, true), { credentials: 'same-origin' });
      if (res.status === 401) { location.replace('/login'); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const file = new File([blob], f.name || 'file', { type: f.mime || blob.type || 'application/octet-stream' });
      if (!navigator.canShare({ files: [file] })) throw new Error('cannot share this type');
      await navigator.share({ files: [file], title: f.name });
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user closed the share sheet
      if (err && err.name === 'NotAllowedError') say('Share not allowed by the browser - use Download instead');
      else say('Share failed - use Download instead');
    } finally {
      btn.textContent = orig;
      btn.disabled = pendingDeletes.has(f.id);
    }
  }

  async function copyLink(entry) {
    const f = entry.meta;
    const url = `${location.origin}${fileUrl(f, false)}`;
    const ok = await copyText(url);
    flip(entry.refs.copyBtn, ok ? 'Copied!' : 'Copy failed');
  }

  async function toggleKeep(entry) {
    const f = entry.meta;
    const btn = entry.refs.keepBtn;
    if (btn.disabled) return;
    const keep = f.expiresAt != null;
    btn.disabled = true;
    try {
      const result = await api.keep(f.id, keep);
      // The `files` broadcast is the normal path; apply the response too so a lagging socket still shows the change.
      if (result && typeof result === 'object' && result.id === f.id && 'expiresAt' in result) {
        files = files.map(x => (x.id === f.id ? { ...x, ...result } : x));
      }
      render();
    } catch (err) {
      say(keep ? 'Could not keep file' : 'Could not change file');
    } finally {
      btn.disabled = pendingDeletes.has(f.id);
    }
  }

  // Delete: grey the card, show "Deleted - Undo" and an on-card countdown for UNDO_MS, send DELETE only
  // when that time is up. Undo works from the toast, the on-card button, or a click anywhere on the card.
  function softDelete(entry) {
    const id = entry.meta.id;
    if (pendingDeletes.has(id)) return;
    // Wall-clock deadline for the UI countdown, matching the commit setTimeout (both real elapsed time).
    const pending = { timer: null, handle: null, tick: null, deadline: Date.now() + UNDO_MS };
    pendingDeletes.set(id, pending);
    pending.timer = setTimeout(() => commitDelete(id), UNDO_MS);
    pending.handle = say('Deleted', { action: { label: 'Undo', onClick: () => undoDelete(id) }, ms: UNDO_MS });
    pending.tick = setInterval(() => tickDelete(id), UNDO_TICK_MS);
    render();
    tickDelete(id);
  }

  // Refresh one pending delete's countdown text + shrinking bar. Cheap; safe to call from a render too.
  function tickDelete(id) {
    const p = pendingDeletes.get(id);
    const entry = cards.get(`f:${id}`);
    if (!p || !entry) return;
    const leftMs = Math.max(0, p.deadline - Date.now());
    const secs = Math.ceil(leftMs / 1000);
    if (entry.refs.delText) entry.refs.delText.textContent = secs > 0 ? `Deleting in ${secs}s` : 'Deleting…';
    if (entry.refs.delFill) entry.refs.delFill.style.width = `${(leftMs / UNDO_MS) * 100}%`;
  }

  function undoDelete(id) {
    const p = pendingDeletes.get(id);
    if (!p) return;
    clearPending(p);
    pendingDeletes.delete(id);
    render();
  }

  async function commitDelete(id) {
    const p = pendingDeletes.get(id);
    if (!p) return;
    clearPending(p);
    try {
      await api.remove(id);
      // The `files` broadcast removes the card; drop the local row now so it does not linger on a slow socket.
      files = files.filter(x => x.id !== id);
    } catch (err) {
      say('Delete failed - file kept');
    } finally {
      pendingDeletes.delete(id);
      render();
    }
  }

  // Stop everything a pending delete owns: the commit timer, the countdown ticker, and its toast.
  function clearPending(p) {
    if (!p) return;
    clearTimeout(p.timer);
    if (p.tick) clearInterval(p.tick);
    closeToast(p.handle);
  }

  function closeToast(handle) {
    try { if (handle && typeof handle.close === 'function') handle.close(); } catch { /* noop */ }
  }

  // Leaving the page inside the undo window must not resurrect the file: fire the DELETEs now.
  function flushPendingDeletes() {
    for (const id of [...pendingDeletes.keys()]) commitDelete(id);
  }

  // ---------- render ----------

  function render() {
    const wanted = [];
    const fileIds = new Set(files.map(f => f.id));

    for (const item of (uploads?.items || [])) {
      if (item.state === 'done' && item.serverId && fileIds.has(item.serverId)) continue; // its file card exists already
      const key = `u:${item.id}`;
      let entry = cards.get(key);
      if (!entry) { const built = buildUploadCard(item); entry = { el: built.el, kind: 'u', refs: built.refs, meta: item }; cards.set(key, entry); }
      else updateUploadCard(entry.el, entry.refs, item);
      wanted.push(key);
    }
    for (const f of files) {
      const key = `f:${f.id}`;
      let entry = cards.get(key);
      if (!entry) { entry = buildFileCard(f); entry.kind = 'f'; cards.set(key, entry); }
      else updateFileCard(entry, f);
      wanted.push(key);
    }

    const wantedSet = new Set(wanted);
    for (const [key, entry] of cards) {
      if (!wantedSet.has(key)) { entry.el.remove(); cards.delete(key); }
    }
    // Put cards in order with minimal moves (a node that is already in place is left untouched).
    wanted.forEach((key, i) => {
      const node = cards.get(key).el;
      if (grid.children[i] !== node) grid.insertBefore(node, grid.children[i] || null);
    });
    empty.hidden = wanted.length > 0;
    grid.hidden = wanted.length === 0;
  }

  function tick() {
    for (const entry of cards.values()) if (entry.kind === 'f') tickExpiry(entry);
  }

  function setFiles(list, used) {
    files = Array.isArray(list) ? list.filter(f => f && typeof f.id === 'string') : [];
    usedBytes = Number(used) || 0;
    // A file the server no longer lists cannot be undone anymore; drop its pending delete quietly.
    for (const id of [...pendingDeletes.keys()]) {
      if (!files.some(f => f.id === id)) { clearPending(pendingDeletes.get(id)); pendingDeletes.delete(id); }
    }
    render();
  }

  const timer = setInterval(tick, COUNTDOWN_MS);
  const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pagehide', flushPendingDeletes);

  function destroy() {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pagehide', flushPendingDeletes);
    flushPendingDeletes();
  }

  render();

  return {
    setFiles,
    render,
    tick,
    destroy,
    get files() { return files; },
    get usedBytes() { return usedBytes; },
    get pendingDeletes() { return pendingDeletes.size; },
  };
}
