// File routes: streaming upload, thumbnail upload, keep/unkeep, delete, list, authenticated download (Range/HEAD),
// thumbnail download, and the /share fallback for when the service worker is not controlling the page.
//
// Upload is a single raw-body PUT streamed straight to DATA_DIR/tmp/<id>, fsync'd, then renamed into files/.
// The server never parses multipart. Broadcasting to sockets is not done here: files.insert/setThumb/setKeep/remove
// emit onChange, and ws.js listens to that.
import { rename, unlink, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream, open as openCb, fsync as fsyncCb, close as closeCb } from 'node:fs';
import { promisify } from 'node:util';
import { json, empty, redirect, readJson, HttpError } from './http.js';
import { ID_RE } from './files.js';

const pOpen = promisify(openCb);
const pFsync = promisify(fsyncCb);
const pClose = promisify(closeCb);

const THUMB_MAX_BYTES = 200 * 1024;
const CACHE_PRIVATE_DAY = 'private, max-age=86400';

// MIME types the browser may render in-page. Everything else (svg, html, heic, ...) is served as an attachment.
const INLINE_EXACT = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'application/pdf', 'text/plain',
]);
function isInline(mime) { return INLINE_EXACT.has(mime) || mime.startsWith('audio/'); }

function requireId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new HttpError(400, 'bad_id');
  return id;
}

// Content-Length as a non-negative integer, or a 411/400 HttpError. `Connection: close` on the error so Node does not
// drain a multi-gigabyte body just to keep the connection alive.
function declaredLength(req) {
  const raw = req.headers['content-length'];
  if (raw === undefined || raw === '') throw new HttpError(411, 'length_required', 'Content-Length is required', { Connection: 'close' });
  if (!/^\d{1,15}$/.test(String(raw))) throw new HttpError(400, 'bad_length', 'Content-Length is not a valid number', { Connection: 'close' });
  return Number(raw);
}

// MIME for an upload: the `type` query param first, then the request's Content-Type. A `+` in the query (image/svg+xml)
// arrives as a space when the client did not percent-encode it; a space is never legal in a MIME type, so undo that.
function pickMime(queryType, headerType, files) {
  const OCTET = 'application/octet-stream';
  if (typeof queryType === 'string' && queryType.trim()) {
    const m = files.sanitizeMime(queryType.replace(/ /g, '+'));
    if (m !== OCTET) return m;
  }
  return files.sanitizeMime(headerType || '');
}

// RFC 5987 ext-value: percent-encode everything outside attr-char (encodeURIComponent leaves !'()* unencoded).
function rfc5987(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
// ASCII fallback for legacy `filename=`: anything non-printable-ASCII, quotes and backslashes become '_'.
function asciiName(s) {
  // eslint-disable-next-line no-control-regex
  const out = s.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return out.trim() || 'file';
}
function contentDisposition(type, name) {
  return `${type}; filename="${asciiName(name)}"; filename*=UTF-8''${rfc5987(name)}`;
}

// Parses a single-range `Range` header against a known size.
//   null → no usable Range (serve 200 in full); { unsatisfiable: true } → 416; { start, end } → 206.
// Multi-range and syntactically odd values are ignored (RFC 7233 lets a server ignore Range), never 416.
function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start, end;
  if (a === '') {
    // suffix range: last N bytes
    const n = Number(b);
    if (n === 0 || size === 0) return { unsatisfiable: true };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
    if (start >= size || start > end) return { unsatisfiable: true };
  }
  return { start, end };
}

// Streams req (exactly `declared` bytes) into a freshly created file at tmp, fsyncs, then renames to dest.
// Resolves with the byte count. Rejects with an HttpError; tmp is always removed on failure.
async function receiveToFile(req, declared, tmp, dest, { maxBytes, tooLargeMessage }) {
  if (declared > maxBytes) {
    throw new HttpError(413, 'too_large', tooLargeMessage, { Connection: 'close' });
  }
  // A numeric fd rather than a FileHandle: fs.WriteStream keeps a ref on a FileHandle that makes handle.close() hang
  // until the stream is destroyed, and destroying it closes the handle — which forbids the fsync we need after 'finish'.
  let fd = null;
  let out = null;
  try {
    fd = await pOpen(tmp, 'wx', 0o600);
    // autoClose:false → the fd survives 'finish' so we can fsync it. destroy() (failure path) still closes it once any
    // in-flight write has completed, which is exactly what we want before unlinking.
    out = createWriteStream(tmp, { fd, autoClose: false });
    out.on('error', () => {}); // errors are routed through onOutError below; this keeps a late one from being unhandled
    await new Promise((resolve, reject) => {
      let received = 0;
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.removeListener('error', onReqError);
        req.removeListener('close', onClose);
        out.removeListener('drain', onDrain);
        out.removeListener('error', onOutError);
        out.removeListener('finish', onFinish);
        if (err) reject(err); else resolve();
      };
      const onData = (chunk) => {
        received += chunk.length;
        if (received > declared) {
          // A client lying about Content-Length: stop reading, answer 400, and let Connection: close tear the socket down.
          req.pause();
          const e = new HttpError(400, 'length_mismatch', 'body exceeds Content-Length', { Connection: 'close' });
          finish(e);
          req.destroy();
          return;
        }
        if (!out.write(chunk)) req.pause();
      };
      const onDrain = () => { req.resume(); };
      const onEnd = () => {
        if (received !== declared) return finish(new HttpError(400, 'length_mismatch', 'body shorter than Content-Length', { Connection: 'close' }));
        out.end();
      };
      const onFinish = () => finish(null);
      const onOutError = (err) => finish(Object.assign(new HttpError(500, 'write_failed'), { cause: err }));
      const onReqError = () => finish(new HttpError(400, 'aborted', 'upload aborted', { Connection: 'close' }));
      const onClose = () => { if (!req.complete) finish(new HttpError(400, 'aborted', 'upload aborted', { Connection: 'close' })); };
      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onReqError);
      req.on('close', onClose);
      out.on('drain', onDrain);
      out.on('error', onOutError);
      out.on('finish', onFinish);
      // declared === 0 needs no special case: Node emits 'end' with no 'data', onEnd calls out.end(), 'finish' resolves.
    });
    // Durability: bytes on disk before the row exists, so a crash can never leave a row pointing at a short blob.
    await pFsync(fd);
    await pClose(fd);
    fd = null;
    out = null; // the fd is closed; never let the stream's teardown close that number again (it may be reused by now)
    await rename(tmp, dest);
    return declared;
  } catch (err) {
    if (out) {
      // Tear the stream down and wait for 'close': it closes the fd only after any in-flight write has completed, so
      // the unlink below never races a write (and the fd number is never closed twice).
      if (!out.closed) await new Promise((resolve) => { out.once('close', resolve); if (!out.destroyed) out.destroy(); });
      fd = null;
    }
    if (fd !== null) { try { await pClose(fd); } catch {} }
    try { await unlink(tmp); } catch {}
    if (err instanceof HttpError) throw err;
    if (err && err.code === 'EEXIST') throw new HttpError(500, 'id_collision');
    throw err;
  }
}

// Sends a blob (or a byte range of it). Handles HEAD, Range/If-Range, If-None-Match.
function sendBlob(req, res, { path, size, mime, headers, etag }) {
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', CACHE_PRIVATE_DAY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

  const inm = req.headers['if-none-match'];
  if (inm && String(inm).split(',').some(t => t.trim() === etag || t.trim() === '*')) {
    res.writeHead(304);
    res.end();
    return;
  }

  // If-Range: only honour Range when the validator still matches (a changed file never gets a stale range).
  const ifRange = req.headers['if-range'];
  const rangeAllowed = ifRange === undefined || String(ifRange).trim() === etag;
  const range = rangeAllowed ? parseRange(req.headers.range, size) : null;
  if (range && range.unsatisfiable) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Type': mime });
    res.end();
    return;
  }

  let status = 200, start = 0, end = size - 1, length = size;
  if (range) {
    status = 206; start = range.start; end = range.end; length = end - start + 1;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', length);
  res.writeHead(status);
  if (req.method === 'HEAD' || length === 0) { res.end(); return; }

  const stream = createReadStream(path, { start, end });
  stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.destroy(); });
  // Client went away: stop reading from disk.
  res.on('close', () => { stream.destroy(); });
  stream.pipe(res);
}

export function registerFileRoutes({ router, cfg, files, log }) {
  // ---- PUT /api/files?name=&type= : streaming upload ----
  router.add('PUT', '/api/files', async (req, res, ctx) => {
    const declared = declaredLength(req);
    const name = files.sanitizeName(ctx.query.get('name') || '');
    const mime = pickMime(ctx.query.get('type'), req.headers['content-type'], files);
    if (declared > cfg.maxFileBytes) {
      throw new HttpError(413, 'too_large', `Too large (limit ${cfg.maxFileMb} MB)`, { Connection: 'close' });
    }
    // Reservation is shared with the chunked-upload path (lib/routes-uploads.js) via files.reserve, so the
    // MAX_STORAGE_MB cap holds even when a raw PUT and a chunked upload are in flight together.
    if (files.wouldExceedCap(declared)) {
      throw new HttpError(507, 'storage_full', 'Storage full', { Connection: 'close' });
    }
    const id = files.newId();
    const tmp = files.tmpPath(id);
    const dest = files.blobPath(id);
    files.beginUpload();
    files.reserve(declared);
    try {
      await receiveToFile(req, declared, tmp, dest, { maxBytes: cfg.maxFileBytes, tooLargeMessage: `Too large (limit ${cfg.maxFileMb} MB)` });
      let meta;
      try {
        meta = files.insert({ id, name, size: declared, mime });
      } catch (err) {
        // Row insert failed after the blob landed: remove the blob so reconcile does not have to.
        try { await unlink(dest); } catch {}
        throw err;
      }
      json(res, 201, meta);
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status !== 400) log.warn('upload: rejected', { id, status: err.status, code: err.code });
        else log.debug('upload: aborted', { id, code: err.code });
      } else {
        log.error('upload: failed', { id, err });
      }
      throw err;
    } finally {
      files.release(declared);
      files.endUpload();
    }
  });

  // ---- PUT /api/files/:id/thumb : client-generated JPEG thumbnail (≤ 200 KB) ----
  router.add('PUT', '/api/files/:id/thumb', async (req, res, ctx) => {
    const id = requireId(ctx.params.id);
    if (!files.get(id)) throw new HttpError(404, 'not_found');
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'image/jpeg') throw new HttpError(415, 'jpeg_required', 'thumbnail must be image/jpeg', { Connection: 'close' });
    const declared = declaredLength(req);
    const tmp = files.tmpPath(id) + '.thumb.jpg';
    const dest = files.thumbPath(id);
    await receiveToFile(req, declared, tmp, dest, { maxBytes: THUMB_MAX_BYTES, tooLargeMessage: 'thumbnail larger than 200 KB' });
    const meta = files.setThumb(id);
    if (!meta) {
      // The file was deleted while the thumbnail was in flight.
      try { await unlink(dest); } catch {}
      throw new HttpError(404, 'not_found');
    }
    empty(res, 204);
  });

  // ---- PATCH /api/files/:id {keep} ----
  router.add('PATCH', '/api/files/:id', async (req, res, ctx) => {
    const id = requireId(ctx.params.id);
    const body = await readJson(req, { maxBytes: 4096 });
    if (typeof body.keep !== 'boolean') throw new HttpError(400, 'bad_request', 'body must be {"keep": true|false}');
    const meta = files.setKeep(id, body.keep);
    if (!meta) throw new HttpError(404, 'not_found');
    json(res, 200, meta);
  });

  // ---- DELETE /api/files/:id ----
  router.add('DELETE', '/api/files/:id', (req, res, ctx) => {
    const id = requireId(ctx.params.id);
    if (!files.remove(id)) throw new HttpError(404, 'not_found');
    empty(res, 204);
  });

  // ---- GET /api/files ----
  router.add('GET', '/api/files', (req, res) => {
    json(res, 200, files.list());
  });

  // ---- GET|HEAD /f/:id/thumb ---- (registered before /f/:id/:name so "thumb" is not taken as a file name)
  router.add('GET', '/f/:id/thumb', async (req, res, ctx) => {
    const id = requireId(ctx.params.id);
    const meta = files.get(id);
    if (!meta || !meta.hasThumb) throw new HttpError(404, 'not_found');
    const path = files.thumbPath(id);
    let st;
    try { st = await stat(path); } catch { throw new HttpError(404, 'not_found'); }
    sendBlob(req, res, {
      path, size: st.size, mime: 'image/jpeg', etag: `"${id}-thumb"`,
      headers: {
        'Content-Disposition': contentDisposition('inline', 'thumb.jpg'),
        'Content-Security-Policy': 'sandbox',
      },
    });
  }, { auth: 'file' });

  // ---- GET|HEAD /f/:id/:name[?dl=1] : download ----
  router.add('GET', '/f/:id/:name', async (req, res, ctx) => {
    const id = requireId(ctx.params.id);
    const meta = files.get(id); // null when unknown or expired — expiry is exact regardless of the sweeper
    if (!meta) throw new HttpError(404, 'not_found');
    const path = files.blobPath(id);
    let st;
    try { st = await stat(path); } catch (err) {
      log.warn('download: blob missing for row', { id, err });
      throw new HttpError(404, 'not_found');
    }
    const forceDownload = ctx.query.get('dl') === '1';
    const disposition = !forceDownload && isInline(meta.mime) ? 'inline' : 'attachment';
    const headers = { 'Content-Disposition': contentDisposition(disposition, meta.name) };
    // `sandbox` makes an uploaded HTML/SVG inert on the app origin. Chrome's PDF viewer cannot render under it and a
    // PDF cannot script against the origin, so PDFs are the one exception.
    if (meta.mime !== 'application/pdf') headers['Content-Security-Policy'] = 'sandbox';
    sendBlob(req, res, { path, size: st.size, mime: meta.mime, etag: `"${id}"`, headers });
  }, { auth: 'file' });

  // ---- /share fallback: only reached when the service worker is not intercepting the share-target POST ----
  router.add('POST', '/share', (req, res) => {
    // Discard whatever multipart body the OS sent; the page will not get the files, but the app still opens.
    req.resume();
    redirect(res, '/', 303);
  }, { auth: 'none', origin: false });
  router.add('GET', '/share', (req, res) => {
    redirect(res, '/', 302);
  }, { auth: 'none', origin: false });
}
