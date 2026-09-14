// Shared text: two ws clients converge, concurrent inserts survive, offline edits merge on reconnect,
// text survives a restart, snapshots after the quiet period, log compaction. Protocol edge cases too.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startTestServer, waitUntil, withTimeout, frame, Y } from './helpers.js';

describe('doc sync', () => {
  let t, cookie;
  before(async () => {
    t = await startTestServer({ snapshotQuietMs: 200 });
    cookie = await t.login();
  });
  after(async () => { await t.stop(); });

  const rowCount = (table) => t.app.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const converged = (clients, expected) =>
    waitUntil(() => clients.every(c => c.text() === expected) && t.app.doc.getText() === expected,
      { timeout: 3000, label: `every replica to read ${JSON.stringify(expected)}` });

  test('handshake: hello, state vector, files, synced, peers', async () => {
    const c = await t.connectSynced(cookie);
    assert.equal(c.hello.proto, 1);
    assert.equal(c.binary[0].tag, 0x00, 'first binary frame is the server state vector');
    assert.equal(c.binary[1].tag, 0x01, 'reply to our state vector is an update');
    assert.ok(c.synced);
    assert.ok(c.files && Array.isArray(c.files.files) && typeof c.files.usedBytes === 'number', 'files list arrives on connect');
    await waitUntil(() => c.peers === 1, { label: 'peers=1' });
    assert.equal(c.text(), '');
    // the step-2 diff is always acked, even when empty
    await c.whenSaved();
    assert.equal(c.acks, 1);
    c.close();
    await c.closed;
  });

  test('ping → pong', async () => {
    const c = await t.connectSynced(cookie);
    const pong = c.waitMessage('pong');
    c.send({ t: 'ping' });
    assert.equal((await pong).t, 'pong');
    c.close();
    await c.closed;
  });

  test('two clients converge; ack arrives after persistence', async () => {
    const a = await t.connectSynced(cookie);
    const b = await t.connectSynced(cookie);
    await waitUntil(() => a.peers === 2 && b.peers === 2, { label: 'peers=2 on both' });

    const ack = a.nextAck();
    a.ytext.insert(0, 'hello from A');
    await ack;
    assert.ok(rowCount('doc_updates') >= 1, 'update persisted before the ack');
    await converged([a, b], 'hello from A');

    // and the other way, appending at the end
    b.ytext.insert(b.ytext.length, ' — and B');
    await converged([a, b], 'hello from A — and B');
    await Promise.all([a.whenSaved(), b.whenSaved()]);
    assert.equal(a.unacked, 0);
    assert.equal(b.unacked, 0);

    // originator does not get its own update echoed back
    const aRemoteFrames = a.binary.filter(f => f.tag === 0x01).length;
    assert.equal(aRemoteFrames, 2, 'A saw exactly the handshake update and B\'s edit');

    a.close(); b.close();
    await Promise.all([a.closed, b.closed]);
    // clean slate for the next tests
    const c = await t.connectSynced(cookie);
    c.ytext.delete(0, c.ytext.length);
    await c.whenSaved();
    await converged([c], '');
    c.close(); await c.closed;
  });

  test('concurrent inserts at the same position both survive', async () => {
    const a = await t.connectSynced(cookie);
    const b = await t.connectSynced(cookie);
    assert.equal(a.text(), '');
    // same tick: neither side has seen the other's op when it inserts
    a.ytext.insert(0, 'A');
    b.ytext.insert(0, 'B');
    await waitUntil(() => a.text().length === 2 && a.text() === b.text() && t.app.doc.getText() === a.text(),
      { label: 'both replicas to hold both characters' });
    const text = a.text();
    assert.ok(text === 'AB' || text === 'BA', `got ${JSON.stringify(text)}`);
    await Promise.all([a.whenSaved(), b.whenSaved()]);

    a.ytext.delete(0, a.ytext.length);
    await converged([a, b], '');
    a.close(); b.close();
    await Promise.all([a.closed, b.closed]);
  });

  test('offline edits merge on reconnect without losing either side', async () => {
    const docB = new Y.Doc();
    const a = await t.connectSynced(cookie);
    let b = await t.connectSynced(cookie, docB);
    a.ytext.insert(0, 'base');
    await converged([a, b], 'base');

    // B goes offline
    b.close();
    await b.closed;
    await waitUntil(() => a.peers === 1, { label: 'A alone' });

    a.ytext.insert(a.ytext.length, ' A-side');
    await a.whenSaved();
    await converged([a], 'base A-side');
    docB.getText('t').insert(0, 'B-side ');            // offline edit, nothing is sent
    assert.equal(docB.getText('t').toString(), 'B-side base');

    // reconnect with the same Y.Doc: the handshake sends only what the server lacks
    b = await t.connectSynced(cookie, docB);
    await converged([a, b], 'B-side base A-side');
    await b.whenSaved();

    a.close(); b.close();
    await Promise.all([a.closed, b.closed]);
  });

  test('a fresh client receives the full document', async () => {
    const c = await t.connectSynced(cookie, new Y.Doc());
    assert.equal(c.text(), 'B-side base A-side');
    c.close(); await c.closed;
  });

  test('snapshot appears after the quiet period; history endpoints', async () => {
    const marker = `snapshot-${Date.now()}`;
    const c = await t.connectSynced(cookie);
    c.ytext.insert(0, marker + '\n');
    await c.whenSaved();
    const expected = c.text();

    const list = await waitUntil(async () => {
      const res = await t.fetch('/api/history', { cookie });
      assert.equal(res.status, 200);
      const items = await res.json();
      return items.length && items[0].preview.startsWith(marker) ? items : null;
    }, { timeout: 3000, interval: 50, label: 'a snapshot with the new text' });
    const head = list[0];
    assert.equal(typeof head.id, 'number');
    assert.equal(typeof head.at, 'number');
    assert.equal(head.len, expected.length);
    assert.equal(head.preview, expected.replace(/\n/g, ' ').slice(0, 80), 'preview = first 80 chars, newlines → spaces');
    assert.ok(!head.preview.includes('\n'));
    for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].at >= list[i].at, 'newest first');

    const res = await t.fetch(`/api/history/${head.id}`, { cookie });
    assert.equal(res.status, 200);
    const snap = await res.json();
    assert.equal(snap.id, head.id);
    assert.equal(snap.at, head.at);
    assert.equal(snap.text, expected);

    assert.equal((await t.fetch('/api/history/999999', { cookie })).status, 404);
    assert.equal((await t.fetch('/api/history')).status, 401);

    // edits that leave the text identical to the last snapshot do not add another one
    const before = rowCount('snapshots');
    c.ytext.insert(0, 'z');
    c.ytext.delete(0, 1);
    await c.whenSaved();
    assert.equal(c.text(), expected);
    await new Promise(r => setTimeout(r, 600));
    assert.equal(rowCount('snapshots'), before, 'identical text is skipped');
    c.close(); await c.closed;
  });

  test('text survives close() + start() on the same DATA_DIR; text.txt mirror is written', async () => {
    const c = await t.connectSynced(cookie);
    c.ytext.insert(c.ytext.length, 'persist me');
    await c.whenSaved();
    const expected = c.text();
    assert.equal(t.app.doc.getText(), expected);
    c.close(); await c.closed;

    await t.restart();
    assert.equal(t.app.doc.getText(), expected, 'reloaded from doc_updates');
    const mirror = await readFile(join(t.dataDir, 'text.txt'), 'utf8');
    assert.equal(mirror, expected, 'text.txt mirror written on shutdown');

    const fresh = await t.connectSynced(cookie, new Y.Doc());
    assert.equal(fresh.text(), expected);
    fresh.close(); await fresh.closed;
  });

  test('malformed update → close 4000', async () => {
    const c = await t.connectSynced(cookie);
    c.sendRaw(frame(0x01, new Uint8Array([0xff, 0xfe, 0xfd, 0x01, 0x02, 0x03, 0x99, 0x98])));
    const { code } = await withTimeout(c.closed, 3000, 'close after malformed update');
    assert.equal(code, 4000);
  });

  test('unknown binary tag → close 4000', async () => {
    const c = await t.connectSynced(cookie);
    c.sendRaw(frame(0x07, new Uint8Array([1, 2, 3])));
    const { code } = await withTimeout(c.closed, 3000, 'close after unknown tag');
    assert.equal(code, 4000);
  });

  test('malformed JSON → close 4000', async () => {
    const c = await t.connectSynced(cookie);
    c.sendRaw('{not json');
    const { code } = await withTimeout(c.closed, 3000, 'close after bad json');
    assert.equal(code, 4000);
  });

  test('server stays healthy after protocol errors', async () => {
    const c = await t.connectSynced(cookie);
    assert.ok(c.synced);
    const res = await fetch(`${t.base}/healthz`);
    assert.equal(res.status, 200);
    c.close(); await c.closed;
  });

  test('compaction: 2100 tiny updates leave a compacted log and intact text', async () => {
    const textBefore = t.app.doc.getText();
    // A second replica produces one update per insert; feed them to the server doc like a client would.
    const local = new Y.Doc();
    Y.applyUpdate(local, t.app.doc.diff(null), 'load');
    const ltext = local.getText('t');
    const updates = [];
    local.on('update', (u) => updates.push(u));
    for (let i = 0; i < 2100; i++) local.transact(() => ltext.insert(ltext.length, 'x'), 'test');
    assert.equal(updates.length, 2100);
    const rowsBefore = rowCount('doc_updates');
    assert.ok(rowsBefore < 1000, `log should be small before the test, got ${rowsBefore}`);
    // Every update is persisted with its own durable commit (synchronous=FULL); 2100 fsyncs take tens of
    // seconds on some disks. The compaction logic is what is under test, so batch the feed in one outer
    // transaction (db.transaction is re-entrant: the compaction's inner transaction joins it).
    const started = Date.now();
    t.app.db.transaction(() => { for (const u of updates) t.app.doc.applyUpdate(u, 'test'); });
    const expected = textBefore + 'x'.repeat(2100);
    assert.equal(t.app.doc.getText(), expected);
    const rows = rowCount('doc_updates');
    // compaction fires once the log passes 2000 rows and leaves a single row; the updates applied after
    // that point add at most 100 rows on top of whatever was there before
    assert.ok(rows >= 1 && rows <= rowsBefore + 100, `expected a compacted log, got ${rows} rows (had ${rowsBefore} before)`);
    assert.ok(Date.now() - started < 8000, 'compaction path is fast');

    // shutdown compacts to one row; the compacted log reloads to the same text
    await t.restart();
    assert.equal(t.app.doc.getText(), expected);
    assert.equal(rowCount('doc_updates'), 1, 'shutdown leaves exactly one row');
    const c = await t.connectSynced(cookie, new Y.Doc());
    assert.equal(c.text(), expected);
    c.close(); await c.closed;
  });
});

describe('server-enforced text cap', () => {
  let t, cookie;
  before(async () => { t = await startTestServer({ MAX_TEXT_KB: '1' }); cookie = await t.login(); }); // 1024 chars
  after(async () => { await t.stop(); });

  test('an oversized update is trimmed to the cap by the server and the trim is broadcast', async () => {
    const cap = t.app.cfg.maxTextChars;
    const a = await t.connectSynced(cookie);
    const b = await t.connectSynced(cookie);
    await waitUntil(() => a.peers === 2 && b.peers === 2, { label: 'peers=2' });
    a.ytext.insert(0, 'x'.repeat(cap + 50));               // a scripted client ignoring the client-side limit
    await waitUntil(() => t.app.doc.getText().length === cap, { label: 'server trimmed to cap' });
    await waitUntil(() => a.text().length === cap && b.text().length === cap, { label: 'both replicas see the trim' });
    assert.equal(t.app.doc.getText().length, cap);
    a.close(); b.close();
    await Promise.all([a.closed, b.closed]);
  });
});
