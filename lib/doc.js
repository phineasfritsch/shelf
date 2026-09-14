// Server-side Y.Doc: the authoritative persisted replica of the shared text box.
//
// Persistence model (SPEC §5 "Server state and handling"):
//   - `doc_updates` is an append-only log of Yjs updates. Boot replays it in seq order (origin 'load').
//   - Every 'update' event is INSERTed synchronously (PRAGMA synchronous=FULL, so it is on disk before the
//     handler returns) and only THEN handed to subscribers (ws.js broadcasts) - persisted → broadcast → ack.
//   - The log is compacted to a single row when it grows past COMPACT_ROWS rows or COMPACT_BYTES bytes.
//   - `text.txt` is a plain-text mirror (tmp + rename), debounced 1 s; a hand-restored text.txt seeds an empty log.
//   - `snapshots` holds text-history entries taken after a quiet period (cfg.snapshotQuietMs).
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import * as Y from 'yjs';

const COMPACT_ROWS = 2000;
const COMPACT_BYTES = 4 * 1024 * 1024;
const MIRROR_DEBOUNCE_MS = 1000;
const SNAPSHOT_KEEP = 50;
const SNAPSHOT_MAX_CHARS = 20 * 1024 * 1024; // SUM(length(text)) budget across all snapshots
const PREVIEW_CHARS = 80;

export function createDoc({ cfg, db, log }) {
  const q = {
    selectUpdates: db.prepare('SELECT data FROM doc_updates ORDER BY seq'),
    insertUpdate: db.prepare('INSERT INTO doc_updates(data) VALUES (?)'),
    deleteUpdates: db.prepare('DELETE FROM doc_updates'),
    lastSnapshot: db.prepare('SELECT id, text FROM snapshots ORDER BY id DESC LIMIT 1'),
    insertSnapshot: db.prepare('INSERT INTO snapshots(at, len, text) VALUES (?, ?, ?)'),
    trimSnapshotCount: db.prepare('DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT ?)'),
    snapshotChars: db.prepare('SELECT COALESCE(SUM(length(text)), 0) AS n, COUNT(*) AS rows FROM snapshots'),
    deleteOldestSnapshot: db.prepare('DELETE FROM snapshots WHERE id = (SELECT id FROM snapshots ORDER BY id ASC LIMIT 1)'),
    // substr() counts Unicode code points in SQLite, so the preview never splits a surrogate pair.
    listSnapshots: db.prepare(`SELECT id, at, len, substr(text, 1, ${PREVIEW_CHARS}) AS preview FROM snapshots ORDER BY id DESC`),
    getSnapshot: db.prepare('SELECT id, at, text FROM snapshots WHERE id = ?'),
  };

  const ydoc = new Y.Doc({ gc: true });
  const ytext = ydoc.getText('t');
  const subscribers = new Set();

  // Running size of the doc_updates log, so compaction never needs a COUNT/SUM query per keystroke.
  let rowCount = 0;
  let rowBytes = 0;

  let mirrorTimer = null;
  let mirrorDirty = false;
  let snapshotTimer = null;
  let closed = false;

  // ---------- boot: replay the log, or seed from a hand-restored text.txt ----------

  const rows = q.selectUpdates.all();
  for (const row of rows) {
    rowCount++;
    rowBytes += row.data.byteLength;
    try { Y.applyUpdate(ydoc, row.data, 'load'); }
    catch (err) { log.error('skipping corrupt update row', { err }); }
  }

  if (rows.length === 0 && existsSync(cfg.textMirrorFile)) {
    let seed = '';
    try { seed = readFileSync(cfg.textMirrorFile, 'utf8'); }
    catch (err) { log.warn('text.txt exists but could not be read', { err }); }
    if (seed.length > 0) {
      ydoc.transact(() => { ytext.insert(0, seed); }, 'seed');
      // The update listener is not attached yet, so persist the seeded state explicitly.
      const state = Y.encodeStateAsUpdate(ydoc);
      q.insertUpdate.run(state);
      rowCount = 1;
      rowBytes = state.byteLength;
      log.info('seeded from text.txt', { chars: seed.length });
    }
  }

  function compact() {
    const state = Y.encodeStateAsUpdate(ydoc);
    db.transaction(() => {
      q.deleteUpdates.run();
      q.insertUpdate.run(state);
    });
    const before = rowCount;
    rowCount = 1;
    rowBytes = state.byteLength;
    log.info('compacted update log', { rows: before, bytes: state.byteLength });
  }

  if (rowCount > COMPACT_ROWS || rowBytes > COMPACT_BYTES) compact();
  log.info('loaded', { rows: rowCount, chars: ytext.length });

  // ---------- text.txt mirror ----------

  function writeMirror() {
    if (mirrorTimer) { clearTimeout(mirrorTimer); mirrorTimer = null; }
    if (!mirrorDirty) return;
    const tmp = cfg.textMirrorFile + '.tmp';
    try {
      writeFileSync(tmp, ytext.toString(), 'utf8');
      renameSync(tmp, cfg.textMirrorFile);
      mirrorDirty = false;
    } catch (err) {
      log.error('text.txt mirror failed', { err });
      try { unlinkSync(tmp); } catch {}
    }
  }

  function scheduleMirror() {
    mirrorDirty = true;
    if (mirrorTimer) clearTimeout(mirrorTimer);
    mirrorTimer = setTimeout(writeMirror, MIRROR_DEBOUNCE_MS);
    mirrorTimer.unref();
  }

  // ---------- history snapshots ----------

  function snapshot() {
    if (snapshotTimer) { clearTimeout(snapshotTimer); snapshotTimer = null; }
    const text = ytext.toString();
    try {
      const last = q.lastSnapshot.get();
      if (last && last.text === text) return;
      db.transaction(() => {
        q.insertSnapshot.run(Date.now(), text.length, text);
        q.trimSnapshotCount.run(SNAPSHOT_KEEP);
        // Trim oldest-first while the total text budget is exceeded; never delete the row just written.
        for (;;) {
          const { n, rows: count } = q.snapshotChars.get();
          if (n <= SNAPSHOT_MAX_CHARS || count <= 1) break;
          q.deleteOldestSnapshot.run();
        }
      });
      log.debug('snapshot taken', { chars: text.length });
    } catch (err) {
      log.error('snapshot failed', { err });
    }
  }

  function scheduleSnapshot() {
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(snapshot, cfg.snapshotQuietMs);
    snapshotTimer.unref();
  }

  // ---------- live updates ----------

  let persistFailures = 0, lastPersistError = null, failPersistOnce = false;
  function onUpdate(update, origin) {
    if (closed) return;
    // 1. persist (synchronous, durable before this returns). Never throw from inside a Yjs observer: that would leave
    //    the transaction half-cleaned and stop every later update. Record the failure instead; ws.js refuses to ack it.
    try {
      if (failPersistOnce) { failPersistOnce = false; throw new Error('injected persist failure (test)'); }
      q.insertUpdate.run(update);
      rowCount++;
      rowBytes += update.byteLength;
    } catch (err) {
      persistFailures++;
      lastPersistError = err;
      log.error('persist failed - update is in memory only', { err, failures: persistFailures });
    }
    if (rowCount > COMPACT_ROWS || rowBytes > COMPACT_BYTES) {
      try { compact(); } catch (err) { log.error('compaction failed', { err }); }
    }
    // 2. notify (ws.js broadcasts to every socket except origin)
    for (const fn of subscribers) {
      try { fn(update, origin); } catch (err) { log.error('subscriber threw', { err }); }
    }
    // 3. housekeeping
    scheduleMirror();
    scheduleSnapshot();
  }
  ydoc.on('update', onUpdate);

  return {
    ydoc,
    ytext,
    get persistFailures() { return persistFailures; },
    get lastPersistError() { return lastPersistError; },
    // Test-only seam: make the next update's disk write throw, to exercise the persist-fail -> no-ack -> 1011 path.
    __failPersistOnce() { failPersistOnce = true; },
    applyUpdate(update, origin) {
      // Throws on malformed input; the caller closes the socket with 4000.
      Y.applyUpdate(ydoc, update, origin);
    },
    stateVector() { return Y.encodeStateVector(ydoc); },
    diff(sv) { return sv ? Y.encodeStateAsUpdate(ydoc, sv) : Y.encodeStateAsUpdate(ydoc); },
    subscribe(fn) {
      subscribers.add(fn);
      return () => { subscribers.delete(fn); };
    },
    getText() { return ytext.toString(); },
    // Server-authoritative cap: delete any text past `maxLen` from the end. The delete flows through onUpdate,
    // so it is persisted and broadcast to every client like any other edit.
    trimTo(maxLen) {
      const len = ytext.length;
      if (len > maxLen) ydoc.transact(() => ytext.delete(maxLen, len - maxLen), 'trim');
    },
    history: {
      list() {
        return q.listSnapshots.all().map(r => ({
          id: r.id,
          at: r.at,
          len: r.len,
          preview: String(r.preview ?? '').replace(/\r\n|\r|\n/g, ' '),
        }));
      },
      get(id) {
        const n = Number(id);
        if (!Number.isInteger(n) || n <= 0) return null;
        const r = q.getSnapshot.get(n);
        return r ? { id: r.id, at: r.at, text: r.text } : null;
      },
    },
    // Synchronous shutdown hook: mirror now, take a pending snapshot, compact the log to one row.
    flush() {
      writeMirror();
      if (snapshotTimer) snapshot();
      if (rowCount > 1) {
        try { compact(); } catch (err) { log.error('compaction failed', { err }); }
      }
    },
    close() {
      closed = true;
      if (mirrorTimer) { clearTimeout(mirrorTimer); mirrorTimer = null; }
      if (snapshotTimer) { clearTimeout(snapshotTimer); snapshotTimer = null; }
      ydoc.off('update', onUpdate);
      subscribers.clear();
    },
  };
}
