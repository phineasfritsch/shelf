// Upload queue: XHR PUT /api/files with byte progress, concurrency 2, FIFO, cancel/retry,
// client-side JPEG thumbnails for images. Pure model — no DOM. files-view.js renders `items`.
//
//   const uploads = createUploads({ getLimits: () => net.limits, toast, onChange: () => view.render() });
//   uploads.enqueue(fileList);            // from picker / camera / paste / drop / share inbox
//   uploads.items                         // live array of queue items (see ITEM SHAPE below)
//   uploads.cancel(id) / retry(id) / dismiss(id)
//   uploads.reconcile(serverFiles)        // app.js: after every `files` message — drops done items the server now lists
//
// ITEM SHAPE: { id, name, size, state: 'queued'|'uploading'|'done'|'error', loaded, total, rate, error, file, serverId }
//   rate     bytes/s measured over a sliding ≥1 s window (0 until the first progress event)
//   error    human-readable reason when state === 'error' (null otherwise)
//   serverId FileMeta.id once the server answered 201 (null otherwise)

const CONCURRENCY = 2;
const THUMB_EDGE = 320;            // long edge of the generated thumbnail, px
const THUMB_QUALITY = 0.7;
const THUMB_MAX_BYTES = 200 * 1024; // server refuses bigger thumbs
const RATE_WINDOW_MS = 1000;
const PROGRESS_NOTIFY_MS = 100;    // coalesce progress → onChange to ~10/s

const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/heic': 'heic', 'image/heif': 'heif', 'image/tiff': 'tiff',
  'text/plain': 'txt', 'text/html': 'html', 'application/pdf': 'pdf', 'application/json': 'json',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/wav': 'wav',
};

function pad2(n) { return String(n).padStart(2, '0'); }

function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
}

function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (MIME_EXT[m]) return MIME_EXT[m];
  const sub = m.split('/')[1] || '';
  const cleaned = sub.replace(/^x-/, '').replace(/[^a-z0-9]/g, '');
  return cleaned && cleaned.length <= 5 ? cleaned : 'bin';
}

function extFromName(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

// Browsers hand pasted images over as an unnamed blob or as "image.png" with lastModified ≈ now.
// A real "image.png" dragged in from disk keeps its (older) mtime and is left alone.
function isPastedBlob(file) {
  if (!file.name) return true;
  if (!/^image\.[a-z0-9]{2,5}$/i.test(file.name)) return false;
  const lm = Number(file.lastModified) || 0;
  return !lm || Date.now() - lm < 120e3;
}

export function createUploads({ getLimits, toast, onChange } = {}) {
  const items = [];                 // public queue, FIFO
  const priv = new Map();           // id → { xhr, samples, lastNotify }
  let seq = 0;
  let lastPasteName = '';

  const notify = () => { try { onChange?.(items); } catch (err) { console.error('uploads: onChange threw', err); } };
  const say = (msg) => { try { toast?.(msg); } catch { /* toast is best-effort */ } };

  function limits() {
    try { return (typeof getLimits === 'function' && getLimits()) || {}; } catch { return {}; }
  }

  function tooLargeMessage() {
    const mb = Number(limits().maxFileMB);
    return Number.isFinite(mb) && mb > 0 ? `Too large (limit ${mb} MB)` : 'Too large';
  }

  function find(id) { return items.find(it => it.id === id) || null; }

  function removeItem(id) {
    const i = items.findIndex(it => it.id === id);
    if (i < 0) return false;
    const p = priv.get(id);
    if (p?.xhr) { p.xhr.onabort = null; p.xhr.onerror = null; p.xhr.onload = null; try { p.xhr.abort(); } catch { /* already finished */ } }
    priv.delete(id);
    items.splice(i, 1);
    return true;
  }

  function uploadName(file) {
    if (!isPastedBlob(file)) return file.name;
    const ext = extFromName(file.name) || extFromMime(file.type) || 'bin';
    let name = `paste-${stamp()}.${ext}`;
    // Two blobs in the same second (multi-image paste) get distinct names.
    if (name === lastPasteName) name = `paste-${stamp()}-${++seq}.${ext}`;
    lastPasteName = name;
    return name;
  }

  function enqueue(files) {
    if (!files) return;
    let added = 0;
    for (const file of files) {
      if (!(file instanceof Blob)) continue;
      const item = {
        id: `u${++seq}-${Date.now().toString(36)}`,
        name: uploadName(file),
        size: file.size,
        state: 'queued',
        loaded: 0,
        total: file.size,
        rate: 0,
        error: null,
        file,
        serverId: null,
      };
      priv.set(item.id, { xhr: null, samples: [], lastNotify: 0 });
      items.push(item);
      added++;
      // Pre-check the per-file cap so a 2 GB file is not streamed only to be refused; still Retry-able.
      const mb = Number(limits().maxFileMB);
      if (Number.isFinite(mb) && mb > 0 && file.size > mb * 1024 * 1024) {
        item.state = 'error';
        item.error = tooLargeMessage();
      }
    }
    if (!added) return;
    notify();
    pump();
  }

  function pump() {
    let active = items.filter(it => it.state === 'uploading').length;
    for (const it of items) {
      if (active >= CONCURRENCY) break;
      if (it.state !== 'queued') continue;
      start(it);
      active++;
    }
  }

  function start(item) {
    const p = priv.get(item.id);
    if (!p) return;
    const mime = item.file.type || 'application/octet-stream';
    const xhr = new XMLHttpRequest();
    p.xhr = xhr;
    p.samples = [];
    item.state = 'uploading';
    item.loaded = 0;
    item.total = item.file.size;
    item.rate = 0;
    item.error = null;
    notify();

    xhr.open('PUT', `/api/files?name=${encodeURIComponent(item.name)}&type=${encodeURIComponent(mime)}`, true);
    xhr.setRequestHeader('Content-Type', mime);
    xhr.responseType = 'text';

    xhr.upload.onprogress = (e) => {
      if (item.state !== 'uploading') return;
      const now = Date.now();
      const loaded = e.lengthComputable ? e.loaded : item.loaded;
      if (e.lengthComputable && e.total > 0) item.total = e.total;
      item.loaded = loaded;
      // Sliding window: keep one sample at/before now-1s as the anchor so the window is always ≥1 s.
      const s = p.samples;
      s.push({ t: now, loaded });
      while (s.length > 2 && s[1].t <= now - RATE_WINDOW_MS) s.shift();
      const dt = now - s[0].t;
      item.rate = dt > 0 ? Math.max(0, (loaded - s[0].loaded) / dt * 1000) : 0;
      if (now - p.lastNotify >= PROGRESS_NOTIFY_MS) { p.lastNotify = now; notify(); }
    };

    xhr.onerror = () => fail(item, 'Connection lost');
    xhr.ontimeout = () => fail(item, 'Connection lost');
    xhr.onabort = () => { /* cancel() already removed the item */ };
    xhr.onload = () => {
      if (item.state !== 'uploading') return;
      const status = xhr.status;
      const body = typeof xhr.response === 'string' ? xhr.response : '';
      if (status === 201) {
        let meta = null;
        try { meta = JSON.parse(body); } catch { meta = null; }
        if (!meta || typeof meta.id !== 'string') return fail(item, 'Unexpected server response');
        p.xhr = null;
        item.serverId = meta.id;
        item.loaded = item.total;
        item.rate = 0;
        item.state = 'done';
        // The server broadcasts the new list BEFORE answering 201, so reconcile() usually ran already: drop the card now
        // rather than waiting for the next unrelated files message.
        if (seenServerList) setTimeout(() => { if (items.includes(item) && item.state === 'done') { removeItem(item.id); notify(); } }, 0);
        notify();
        pump();
        if (mime.startsWith('image/')) sendThumb(item.file, meta.id);
        return;
      }
      if (status === 401) {
        item.error = 'Logged out — reload';
        item.state = 'error';
        notify();
        location.replace('/login');
        return;
      }
      let json = null;
      try { json = JSON.parse(body); } catch { json = null; }
      if (status === 413) return fail(item, tooLargeMessage());
      if (status === 507) return fail(item, 'Storage full');
      if (status === 0) return fail(item, 'Connection lost');
      if (json && typeof json.error === 'string') return fail(item, `Upload failed (${json.error.replace(/_/g, ' ')})`);
      // A non-JSON 4xx/5xx did not come from Shelf: almost always a proxy body-size limit or timeout page.
      fail(item, 'Blocked by reverse proxy (body size limit?)');
    };

    try {
      xhr.send(item.file);
    } catch (err) {
      // e.g. the File handle went stale (picked file deleted on disk before the upload started)
      fail(item, 'Could not read file');
    }
  }

  function fail(item, reason) {
    if (item.state !== 'uploading') return;
    const p = priv.get(item.id);
    if (p) p.xhr = null;
    item.state = 'error';
    item.error = reason;
    item.rate = 0;
    notify();
    say(`${item.name}: ${reason}`);
    pump();
  }

  function cancel(id) {
    const it = find(id);
    if (!it) return;
    removeItem(id);          // aborts the XHR if one is running; the server unlinks its tmp file
    notify();
    pump();
  }

  function retry(id) {
    const it = find(id);
    if (!it || it.state !== 'error') return;
    it.loaded = 0;
    it.rate = 0;
    it.serverId = null;
    // Still over the cap? Re-show the reason instead of streaming a body the server will refuse unread
    // (browsers then report a network error, which would read as "Connection lost").
    const mb = Number(limits().maxFileMB);
    if (Number.isFinite(mb) && mb > 0 && it.size > mb * 1024 * 1024) {
      it.error = tooLargeMessage();
      notify();
      say(`${it.name}: ${it.error}`);
      return;
    }
    it.state = 'queued';
    it.error = null;
    notify();
    pump();
  }

  function dismiss(id) {
    const it = find(id);
    if (!it) return;
    if (it.state === 'uploading') return cancel(id);
    removeItem(id);
    notify();
  }

  // Drop 'done' items the server's list now contains (their file card replaces the upload card).
  let seenServerList = false;
  function reconcile(serverFiles) {
    seenServerList = true;
    const list = Array.isArray(serverFiles) ? serverFiles : (serverFiles && Array.isArray(serverFiles.files) ? serverFiles.files : []);
    const ids = new Set(list.map(f => f && f.id));
    let changed = false;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      // Listed → the real card replaces this one. Not listed → it was deleted/expired meanwhile; either way the
      // finished upload card has nothing left to show.
      if (it.state === 'done' && it.serverId) { removeItem(it.id); changed = true; }
    }
    if (changed) notify();
  }

  // ---------- thumbnails ----------

  // Decode → scale to ≤320 px long edge → JPEG q0.7. Returns a Blob or null (undecodable, e.g. HEIC on Windows).
  async function makeThumb(file) {
    let source = null, w = 0, h = 0, release = () => {};
    try {
      if (typeof createImageBitmap !== 'function') throw new Error('no createImageBitmap');
      // 'from-image' applies the EXIF orientation so phone photos are not sideways.
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      source = bmp; w = bmp.width; h = bmp.height;
      release = () => { try { bmp.close(); } catch { /* noop */ } };
    } catch {
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
        await img.decode();
        source = img; w = img.naturalWidth; h = img.naturalHeight;
      } catch {
        URL.revokeObjectURL(url);
        return null;
      }
      release = () => URL.revokeObjectURL(url);
    }
    try {
      if (!(w > 0 && h > 0)) return null;
      const scale = Math.min(1, THUMB_EDGE / Math.max(w, h));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#fff'; // transparent PNG → white matte instead of black
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      return await new Promise(resolve => canvas.toBlob(b => resolve(b || null), 'image/jpeg', THUMB_QUALITY));
    } catch {
      return null;
    } finally {
      release();
    }
  }

  async function sendThumb(file, serverId) {
    try {
      const blob = await makeThumb(file);
      if (!blob || blob.size > THUMB_MAX_BYTES) return;
      const res = await fetch(`/api/files/${encodeURIComponent(serverId)}/thumb`, {
        method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'image/jpeg' }, body: blob,
      });
      if (res.status === 401) location.replace('/login');
      // Any other failure just leaves the card with its MIME icon; the file itself is safely stored.
    } catch (err) {
      console.warn('uploads: thumbnail skipped', err);
    }
  }

  return {
    get items() { return items; },
    enqueue,
    cancel,
    retry,
    dismiss,
    reconcile,
    active: () => items.filter(it => it.state === 'uploading' || it.state === 'queued').length,
  };
}
