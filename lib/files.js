// File metadata + storage: id generation, name/MIME sanitising, on-disk paths, quota, delete, TTL sweeper, boot reconcile.
//
// Invariants:
//   - A row in `files` means "the blob DATA_DIR/files/<id> exists". Delete is always unlink-first, then DELETE row, so a
//     crash in between leaves a retryable row (swept/removed again later), never an orphan blob nobody can see.
//   - Expiry is exact: get()/list() hide rows whose expires_at <= now even before the sweeper runs.
//   - Every mutation (insert/thumb/keep/remove/sweep) fires onChange listeners; ws.js broadcasts the full list from there.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { unlinkSync, readdirSync, existsSync, rmSync } from 'node:fs';

export const ID_RE = /^[A-Za-z0-9_-]{16}$/;
const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;
const THUMB_SUFFIX = '.thumb.jpg';
const NAME_MAX = 200;
const MIME_MAX = 120;

// Unlink that tolerates a missing file. Returns true if a file was removed. Any other error propagates.
function unlinkQuiet(path) {
  try { unlinkSync(path); return true; }
  catch (e) { if (e && e.code === 'ENOENT') return false; throw e; }
}

export function createFiles({ cfg, db, log }) {
  const q = {
    listLive: db.prepare('SELECT id, name, size, mime, created_at, expires_at, has_thumb FROM files WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at DESC, rowid DESC'),
    listAll: db.prepare('SELECT id, name, size, mime, created_at, expires_at, has_thumb FROM files'),
    countLive: db.prepare('SELECT COUNT(*) AS n FROM files WHERE expires_at IS NULL OR expires_at > ?'),
    usedBytes: db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM files'),
    get: db.prepare('SELECT id, name, size, mime, created_at, expires_at, has_thumb FROM files WHERE id = ?'),
    insert: db.prepare('INSERT INTO files(id, name, size, mime, created_at, expires_at, has_thumb) VALUES (?, ?, ?, ?, ?, ?, 0)'),
    setThumb: db.prepare('UPDATE files SET has_thumb = ? WHERE id = ?'),
    setExpires: db.prepare('UPDATE files SET expires_at = ? WHERE id = ?'),
    del: db.prepare('DELETE FROM files WHERE id = ?'),
    expired: db.prepare('SELECT id, size, name FROM files WHERE expires_at IS NOT NULL AND expires_at <= ?'),
  };

  const listeners = new Set();
  let inFlight = 0;

  function emit() {
    for (const fn of listeners) {
      try { fn(); } catch (err) { log.error('files: onChange listener failed', { err }); }
    }
  }

  function toMeta(row) {
    return {
      id: row.id,
      name: row.name,
      size: row.size,
      mime: row.mime,
      createdAt: row.created_at,
      expiresAt: row.expires_at === null || row.expires_at === undefined ? null : row.expires_at,
      hasThumb: !!row.has_thumb,
    };
  }

  const blobPath = (id) => join(cfg.filesDir, id);
  const thumbPath = (id) => join(cfg.filesDir, id + THUMB_SUFFIX);
  const tmpPath = (id) => join(cfg.tmpDir, id);

  // Raw row regardless of expiry (internal: remove/sweep operate on rows, not on the visible list).
  function rowById(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    return q.get.get(id) || null;
  }

  // Unlink blob + thumb for an id. ENOENT tolerated; other errors propagate so the row stays (retryable).
  function unlinkBlobs(id) {
    unlinkQuiet(blobPath(id));
    unlinkQuiet(thumbPath(id));
  }

  const api = {
    list() {
      const rows = q.listLive.all(Date.now());
      return { files: rows.map(toMeta), usedBytes: api.usedBytes() };
    },

    count() {
      return q.countLive.get(Date.now()).n;
    },

    // null when unknown OR expired (expires_at <= now) — the download route relies on this for exact expiry.
    get(id) {
      const row = rowById(id);
      if (!row) return null;
      if (row.expires_at !== null && row.expires_at <= Date.now()) return null;
      return toMeta(row);
    },

    newId() {
      return randomBytes(12).toString('base64url');
    },

    // Strip path separators and control characters, trim, cap at 200 chars, default 'file'.
    sanitizeName(name) {
      let s = typeof name === 'string' ? name : '';
      // eslint-disable-next-line no-control-regex
      s = s.replace(/[/\\\x00-\x1f\x7f]/g, '').trim();
      if (s.length > NAME_MAX) s = s.slice(0, NAME_MAX).trim();
      // A name that is only dots would be a directory reference on some clients' "save as"; not a security issue here
      // (names never touch the disk) but a useless download name, so fall back.
      if (!s || /^\.+$/.test(s)) return 'file';
      return s;
    },

    sanitizeMime(type) {
      const s = typeof type === 'string' ? type.split(';')[0].trim().toLowerCase() : '';
      if (!s || s.length > MIME_MAX || !MIME_RE.test(s)) return 'application/octet-stream';
      return s;
    },

    blobPath,
    thumbPath,
    tmpPath,

    insert({ id, name, size, mime }) {
      if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('files.insert: bad id');
      const now = Date.now();
      const expiresAt = cfg.fileTtlMs === null ? null : now + cfg.fileTtlMs;
      q.insert.run(id, api.sanitizeName(name), Math.max(0, Math.floor(Number(size) || 0)), api.sanitizeMime(mime), now, expiresAt);
      const meta = toMeta(q.get.get(id));
      log.info('upload: stored', { id, name: meta.name, size: meta.size, mime: meta.mime });
      emit();
      return meta;
    },

    setThumb(id) {
      const row = rowById(id);
      if (!row) return null;
      q.setThumb.run(1, id);
      const meta = toMeta(q.get.get(id));
      emit();
      return meta;
    },

    // keep → never expires; unkeep → now + TTL (or never when TTL is disabled).
    setKeep(id, keep) {
      const row = rowById(id);
      if (!row) return null;
      // An already-expired row is invisible to the client; refuse to resurrect it (the sweeper will unlink it).
      if (row.expires_at !== null && row.expires_at <= Date.now()) return null;
      const expiresAt = keep ? null : (cfg.fileTtlMs === null ? null : Date.now() + cfg.fileTtlMs);
      q.setExpires.run(expiresAt, id);
      const meta = toMeta(q.get.get(id));
      emit();
      return meta;
    },

    // Unlink blob + thumb, THEN delete the row. Returns false when there is no such row.
    remove(id) {
      const row = rowById(id);
      if (!row) return false;
      unlinkBlobs(id);
      q.del.run(id);
      log.info('file: deleted', { id, name: row.name, size: row.size });
      emit();
      return true;
    },

    // Expired rows: unlink then delete. Per-file errors are logged and the row is left for the next tick.
    sweep(now = Date.now()) {
      const rows = q.expired.all(now);
      let removed = 0, bytes = 0;
      for (const row of rows) {
        try {
          unlinkBlobs(row.id);
          q.del.run(row.id);
          removed++;
          bytes += row.size;
        } catch (err) {
          log.warn('sweep: could not remove expired file, will retry', { id: row.id, err });
        }
      }
      if (removed > 0) {
        log.info(`sweep: removed ${removed} files (${bytes} bytes)`, { removed, bytes });
        emit();
      }
      return { removed, bytes };
    },

    // Boot: make disk and DB agree. Blobs without rows → unlinked; rows without blobs → deleted; tmp/ emptied.
    reconcile() {
      const rows = q.listAll.all();
      const byId = new Map(rows.map(r => [r.id, r]));
      let orphanBlobs = 0, orphanRows = 0, tmpCleared = 0, thumbsFixed = 0;

      let entries = [];
      try { entries = readdirSync(cfg.filesDir); }
      catch (err) { log.error('reconcile: cannot read files dir, skipping reconcile', { dir: cfg.filesDir, err }); return; }
      const onDisk = new Set();
      for (const name of entries) {
        const isThumb = name.endsWith(THUMB_SUFFIX);
        const base = isThumb ? name.slice(0, -THUMB_SUFFIX.length) : name;
        if (byId.has(base)) { onDisk.add(name); continue; }
        try { unlinkQuiet(join(cfg.filesDir, name)); orphanBlobs++; }
        catch (err) { log.warn('reconcile: cannot unlink orphan', { file: name, err }); }
      }

      for (const row of rows) {
        if (!onDisk.has(row.id)) {
          // Row without a blob: nothing to serve, drop it (and any thumb that survived).
          try { unlinkQuiet(thumbPath(row.id)); } catch {}
          q.del.run(row.id);
          orphanRows++;
          continue;
        }
        const hasThumbFile = onDisk.has(row.id + THUMB_SUFFIX);
        if (!!row.has_thumb !== hasThumbFile) { q.setThumb.run(hasThumbFile ? 1 : 0, row.id); thumbsFixed++; }
      }

      let tmpEntries = [];
      try { tmpEntries = readdirSync(cfg.tmpDir); } catch (err) { log.error('reconcile: cannot read tmp dir', { dir: cfg.tmpDir, err }); }
      for (const name of tmpEntries) {
        try { rmSync(join(cfg.tmpDir, name), { recursive: true, force: true }); tmpCleared++; }
        catch (err) { log.warn('reconcile: cannot remove tmp entry', { file: name, err }); }
      }

      if (orphanBlobs || orphanRows || tmpCleared || thumbsFixed) {
        log.info('reconcile: done', { orphanBlobs, orphanRows, tmpCleared, thumbsFixed });
        if (orphanRows || thumbsFixed) emit();
      }
    },

    // Sum of all stored sizes, including expired-but-not-yet-swept rows (their bytes are still on disk).
    usedBytes() {
      return q.usedBytes.get().n;
    },

    inFlight() { return inFlight; },
    beginUpload() { inFlight++; },
    endUpload() { inFlight = Math.max(0, inFlight - 1); },

    onChange(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },

    toMeta,
  };

  // Sanity: the directories are created by config.js; complain loudly if they vanished.
  if (!existsSync(cfg.filesDir) || !existsSync(cfg.tmpDir)) log.error('files: storage directories missing', { filesDir: cfg.filesDir, tmpDir: cfg.tmpDir });

  return api;
}
