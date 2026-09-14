// Chunked uploads. The client splits anything bigger than one chunk (8 MiB by default) into fixed-size parts and
// PUTs them one at a time, so a proxy that caps request bodies (Cloudflare Tunnel: 100 MB on free plans, nginx's
// client_max_body_size) never sees a large request, and a flaky mobile link only re-sends the part that failed.
//
//   POST   /api/uploads                 {name, type, size} → 201 {id, chunkSize, chunks}   (413 / 507 as for /api/files)
//   PUT    /api/uploads/:id/:index      raw body of exactly the expected chunk length → 204
//   POST   /api/uploads/:id/complete    → 201 FileMeta (409 {missing:[…]} while chunks are outstanding)
//   DELETE /api/uploads/:id             → 204 (abort; tmp file removed)
//
// Sessions live in memory; a session idle for an hour is discarded and its tmp file unlinked. The tmp file is
// pre-sized, chunks are written at their offset, and complete() fsyncs then renames - same durability as /api/files.
import { open, rename, unlink } from 'node:fs/promises';
import { json, empty, readJson, HttpError } from './http.js';
import { ID_RE } from './files.js';

const STALE_MS = 60 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

function readBody(req, declared) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0, settled = false;
    const finish = (err, buf) => { if (settled) return; settled = true; if (err) reject(err); else resolve(buf); };
    req.on('data', (c) => {
      received += c.length;
      if (received > declared) { req.pause(); finish(new HttpError(400, 'length_mismatch', 'body exceeds Content-Length', { Connection: 'close' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (received !== declared) return finish(new HttpError(400, 'length_mismatch', 'body shorter than Content-Length', { Connection: 'close' }));
      finish(null, Buffer.concat(chunks, received));
    });
    req.on('error', () => finish(new HttpError(400, 'aborted', 'upload aborted', { Connection: 'close' })));
    req.on('close', () => { if (!req.complete) finish(new HttpError(400, 'aborted', 'upload aborted', { Connection: 'close' })); });
  });
}

export function registerUploadRoutes({ router, cfg, files, log }) {
  const sessions = new Map();   // id → { id, name, mime, size, chunks, received: Set<number>, tmp, createdAt, lastAt }
  const chunkSize = cfg.uploadChunkBytes;

  function requireId(id) {
    if (!ID_RE.test(String(id || ''))) throw new HttpError(400, 'bad_id');
    return id;
  }
  function getSession(id) {
    const s = sessions.get(requireId(id));
    if (!s) throw new HttpError(404, 'no_such_upload', 'Upload expired - retry');
    s.lastAt = Date.now();
    return s;
  }
  async function discard(s) {
    if (!sessions.delete(s.id)) return;
    files.release(s.size);
    try { await unlink(s.tmp); } catch { /* already gone */ }
  }

  router.add('POST', '/api/uploads', async (req, res) => {
    const body = await readJson(req, { maxBytes: 4096 });
    const size = body.size;
    if (!Number.isInteger(size) || size < 0) throw new HttpError(400, 'bad_size', 'size must be a non-negative integer');
    if (size > cfg.maxFileBytes) throw new HttpError(413, 'too_large', `Too large (limit ${cfg.maxFileMb} MB)`);
    if (files.wouldExceedCap(size)) throw new HttpError(507, 'storage_full', 'Storage full');
    const name = files.sanitizeName(typeof body.name === 'string' ? body.name : '');
    const mime = files.sanitizeMime(typeof body.type === 'string' ? body.type : '');
    const id = files.newId();
    const tmp = files.tmpPath(id);
    const fh = await open(tmp, 'wx', 0o600);
    try { if (size > 0) await fh.truncate(size); } finally { await fh.close(); }
    const now = Date.now();
    const chunks = Math.max(1, Math.ceil(size / chunkSize));
    sessions.set(id, { id, name, mime, size, chunks, received: new Set(), tmp, createdAt: now, lastAt: now });
    files.reserve(size);
    log.debug('upload: chunked session opened', { id, size, chunks });
    json(res, 201, { id, chunkSize, chunks });
  });

  router.add('PUT', '/api/uploads/:id/:index', async (req, res, ctx) => {
    const s = getSession(ctx.params.id);
    const index = Number(ctx.params.index);
    if (!Number.isInteger(index) || index < 0 || index >= s.chunks) throw new HttpError(400, 'bad_index');
    const offset = index * chunkSize;
    const expected = Math.min(chunkSize, s.size - offset);
    const raw = req.headers['content-length'];
    if (raw === undefined || raw === '') throw new HttpError(411, 'length_required', 'Content-Length is required', { Connection: 'close' });
    const declared = Number(raw);
    if (!Number.isInteger(declared) || declared !== expected) {
      throw new HttpError(400, 'chunk_length', `chunk ${index} must be exactly ${expected} bytes`, { Connection: 'close' });
    }
    const buf = await readBody(req, declared);
    files.beginUpload();
    try {
      const fh = await open(s.tmp, 'r+');
      try { if (buf.length) await fh.write(buf, 0, buf.length, offset); } finally { await fh.close(); }
    } catch (err) {
      log.error('upload: chunk write failed', { id: s.id, index, err });
      throw new HttpError(500, 'write_failed');
    } finally {
      files.endUpload();
    }
    s.received.add(index);
    empty(res, 204);
  });

  router.add('POST', '/api/uploads/:id/complete', async (req, res, ctx) => {
    const s = getSession(ctx.params.id);
    if (s.received.size !== s.chunks) {
      const missing = [];
      for (let i = 0; i < s.chunks; i++) if (!s.received.has(i)) missing.push(i);
      return json(res, 409, { error: 'incomplete', missing: missing.slice(0, 100) });
    }
    const dest = files.blobPath(s.id);
    files.beginUpload();
    try {
      const fh = await open(s.tmp, 'r+');
      try { await fh.sync(); } finally { await fh.close(); }
      await rename(s.tmp, dest);
    } catch (err) {
      log.error('upload: finalise failed', { id: s.id, err });
      await discard(s);
      throw new HttpError(500, 'write_failed');
    } finally {
      files.endUpload();
    }
    sessions.delete(s.id);
    files.release(s.size);
    let meta;
    try { meta = files.insert({ id: s.id, name: s.name, size: s.size, mime: s.mime }); }
    catch (err) { try { await unlink(dest); } catch { /* ignore */ } throw err; }
    log.info('upload: chunked complete', { id: s.id, name: s.name, size: s.size, chunks: s.chunks });
    json(res, 201, meta);
  });

  router.add('DELETE', '/api/uploads/:id', async (req, res, ctx) => {
    const s = sessions.get(requireId(ctx.params.id));
    if (s) await discard(s);
    empty(res, 204);
  });

  const sweep = setInterval(() => {
    const cutoff = Date.now() - STALE_MS;
    for (const s of [...sessions.values()]) {
      if (s.lastAt < cutoff) { log.info('upload: stale chunked session discarded', { id: s.id, received: s.received.size, chunks: s.chunks }); discard(s); }
    }
  }, SWEEP_MS);
  sweep.unref();

  return { pending: () => sessions.size, close: () => clearInterval(sweep) };
}
