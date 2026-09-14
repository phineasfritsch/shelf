// Files: upload → list → download headers → Range → HEAD, thumb round trip, keep, delete unlinks,
// 413 / 411 / bad ids, share fallback, storage cap, and TTL expiry (404 at expiry, sweeper unlinks + drops row).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { startTestServer, waitUntil } from './helpers.js';

const ID_RE = /^[A-Za-z0-9_-]{16}$/;
const UNKNOWN_ID = 'AAAAAAAAAAAAAAAA';
// Smallest thing that looks like a JPEG (SOI … EOI); the server stores bytes, it does not decode.
const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x11), Buffer.from([0xff, 0xd9])]);

function assertMeta(meta, { name, size, mime }) {
  assert.match(meta.id, ID_RE);
  assert.equal(meta.name, name);
  assert.equal(meta.size, size);
  assert.equal(meta.mime, mime);
  assert.equal(typeof meta.createdAt, 'number');
  assert.ok(meta.expiresAt === null || typeof meta.expiresAt === 'number');
  assert.equal(typeof meta.hasThumb, 'boolean');
  assert.deepEqual(Object.keys(meta).sort(), ['createdAt', 'expiresAt', 'hasThumb', 'id', 'mime', 'name', 'size']);
}

describe('files', () => {
  let t, cookie;
  before(async () => {
    t = await startTestServer({ MAX_FILE_MB: '0.01' });   // 10,485 bytes per file
    cookie = await t.login();
  });
  after(async () => { await t.stop(); });

  const upload = (body, { name, type, headers = {}, init = {} } = {}) => {
    const q = new URLSearchParams();
    if (name !== undefined) q.set('name', name);
    if (type !== undefined) q.set('type', type);
    return t.fetch('/api/files' + (q.size ? '?' + q : ''), {
      method: 'PUT', cookie, body,
      headers: { 'Content-Type': type || 'application/octet-stream', ...headers },
      ...init,
    });
  };
  const listFiles = async () => {
    const res = await t.fetch('/api/files', { cookie });
    assert.equal(res.status, 200);
    return res.json();
  };
  const rowCount = () => t.app.db.prepare('SELECT COUNT(*) AS n FROM files').get().n;

  const BODY = Buffer.from('Hello, Shelf! 0123456789 abcdefghijklmnopqrstuvwxyz');
  let meta;

  test('PUT /api/files → 201 FileMeta; a connected socket receives the files broadcast', async () => {
    const c = await t.connectSynced(cookie);
    assert.deepEqual(c.files.files, []);
    const broadcast = c.waitMessage('files');

    const res = await upload(BODY, { name: 'hello world.txt', type: 'text/plain' });
    assert.equal(res.status, 201);
    assert.match(res.headers.get('content-type'), /application\/json/);
    meta = await res.json();
    assertMeta(meta, { name: 'hello world.txt', size: BODY.length, mime: 'text/plain' });
    assert.equal(meta.hasThumb, false);
    assert.ok(Math.abs(meta.expiresAt - (meta.createdAt + 168 * 3600e3)) < 1000, 'default TTL is 168 h');
    assert.ok(existsSync(t.app.files.blobPath(meta.id)), 'blob on disk');
    assert.ok(!existsSync(t.app.files.tmpPath(meta.id)), 'tmp file renamed away');

    const msg = await broadcast;
    assert.equal(msg.files.length, 1);
    assert.equal(msg.files[0].id, meta.id);
    assert.equal(msg.usedBytes, BODY.length);
    c.close(); await c.closed;
  });

  test('GET /api/files lists newest first with usedBytes', async () => {
    const { files, usedBytes } = await listFiles();
    assert.equal(files.length, 1);
    assert.deepEqual(files[0], meta);
    assert.equal(usedBytes, BODY.length);
    assert.equal(t.app.files.count(), 1);
  });

  test('download: headers, body, inline disposition for text/plain', async () => {
    const res = await t.fetch(`/f/${meta.id}/hello%20world.txt`, { cookie });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/plain');
    assert.equal(res.headers.get('content-length'), String(BODY.length));
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    assert.equal(res.headers.get('etag'), `"${meta.id}"`);
    assert.equal(res.headers.get('cache-control'), 'private, max-age=86400');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(res.headers.get('content-security-policy'), 'sandbox');
    const cd = res.headers.get('content-disposition');
    assert.match(cd, /^inline; /);
    assert.match(cd, /filename="hello world\.txt"/);
    assert.match(cd, /filename\*=UTF-8''hello%20world\.txt/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), BODY);
  });

  test('?dl=1 forces attachment; the :name segment is cosmetic', async () => {
    const res = await t.fetch(`/f/${meta.id}/whatever?dl=1`, { cookie });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /^attachment; /);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), BODY);
  });

  test('Range: single range → 206 with Content-Range; unsatisfiable → 416', async () => {
    let res = await t.fetch(`/f/${meta.id}/x`, { cookie, headers: { Range: 'bytes=2-5' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), `bytes 2-5/${BODY.length}`);
    assert.equal(res.headers.get('content-length'), '4');
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), BODY.subarray(2, 6));

    // open-ended and suffix ranges
    res = await t.fetch(`/f/${meta.id}/x`, { cookie, headers: { Range: `bytes=${BODY.length - 3}-` } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), `bytes ${BODY.length - 3}-${BODY.length - 1}/${BODY.length}`);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), BODY.subarray(BODY.length - 3));
    res = await t.fetch(`/f/${meta.id}/x`, { cookie, headers: { Range: 'bytes=-4' } });
    assert.equal(res.status, 206);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), BODY.subarray(BODY.length - 4));

    res = await t.fetch(`/f/${meta.id}/x`, { cookie, headers: { Range: `bytes=${BODY.length + 10}-${BODY.length + 20}` } });
    assert.equal(res.status, 416);
    assert.equal(res.headers.get('content-range'), `bytes */${BODY.length}`);
  });

  test('HEAD: same headers, no body', async () => {
    const res = await t.fetch(`/f/${meta.id}/hello.txt`, { method: 'HEAD', cookie });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-length'), String(BODY.length));
    assert.equal(res.headers.get('content-type'), 'text/plain');
    assert.equal(res.headers.get('etag'), `"${meta.id}"`);
    assert.equal((await res.arrayBuffer()).byteLength, 0);
  });

  test('download requires auth; unknown or malformed ids', async () => {
    assert.equal((await t.fetch(`/f/${meta.id}/x`)).status, 401);
    assert.equal((await t.fetch(`/f/${UNKNOWN_ID}/x`, { cookie })).status, 404);
    assert.equal((await t.fetch('/f/short/x', { cookie })).status, 400);
    assert.equal((await t.fetch('/f/has%2Fslash%2Fin%2Fit1/x', { cookie })).status, 400);
    assert.equal((await t.fetch(`/api/files/${UNKNOWN_ID}`, { method: 'DELETE', cookie })).status, 404);
    assert.equal((await t.fetch('/api/files/short', { method: 'DELETE', cookie })).status, 400);
    assert.equal((await t.fetch('/api/files/short', { method: 'PATCH', cookie, headers: { 'Content-Type': 'application/json' }, body: '{"keep":true}' })).status, 400);
  });

  test('thumb: 404 before, round trip after, size cap, unknown id', async () => {
    assert.equal((await t.fetch(`/f/${meta.id}/thumb`, { cookie })).status, 404);

    let res = await t.fetch(`/api/files/${meta.id}/thumb`, { method: 'PUT', cookie, body: FAKE_JPEG, headers: { 'Content-Type': 'image/jpeg' } });
    assert.equal(res.status, 204);
    assert.ok(existsSync(t.app.files.thumbPath(meta.id)));
    const { files } = await listFiles();
    assert.equal(files[0].hasThumb, true);

    res = await t.fetch(`/f/${meta.id}/thumb`, { cookie });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), FAKE_JPEG);
    assert.equal((await t.fetch(`/f/${meta.id}/thumb`)).status, 401);

    const big = Buffer.alloc(200 * 1024 + 1, 0x22);
    res = await t.fetch(`/api/files/${meta.id}/thumb`, { method: 'PUT', cookie, body: big, headers: { 'Content-Type': 'image/jpeg' } });
    assert.equal(res.status, 413);
    res = await t.fetch(`/api/files/${UNKNOWN_ID}/thumb`, { method: 'PUT', cookie, body: FAKE_JPEG, headers: { 'Content-Type': 'image/jpeg' } });
    assert.equal(res.status, 404);
    meta = (await listFiles()).files[0];
  });

  test('keep: true → expiresAt null; false → fresh TTL', async () => {
    let res = await t.fetch(`/api/files/${meta.id}`, { method: 'PATCH', cookie, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keep: true }) });
    assert.equal(res.status, 200);
    let m = await res.json();
    assertMeta(m, { name: meta.name, size: meta.size, mime: meta.mime });
    assert.equal(m.expiresAt, null);
    assert.equal((await listFiles()).files[0].expiresAt, null);

    const before = Date.now();
    res = await t.fetch(`/api/files/${meta.id}`, { method: 'PATCH', cookie, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keep: false }) });
    assert.equal(res.status, 200);
    m = await res.json();
    assert.equal(typeof m.expiresAt, 'number');
    assert.ok(m.expiresAt >= before + 168 * 3600e3 - 1000 && m.expiresAt <= Date.now() + 168 * 3600e3 + 1000, 'unkeep = now + TTL');

    res = await t.fetch(`/api/files/${meta.id}`, { method: 'PATCH', cookie, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keep: 'yes' }) });
    assert.equal(res.status, 400);
    res = await t.fetch(`/api/files/${UNKNOWN_ID}`, { method: 'PATCH', cookie, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keep: true }) });
    assert.equal(res.status, 404);
    // mutations need a good Origin
    res = await t.fetch(`/api/files/${meta.id}`, { method: 'PATCH', cookie, origin: 'http://evil.example', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keep: true }) });
    assert.equal(res.status, 403);
  });

  test('name and type sanitising; disposition per MIME allowlist; unicode names', async () => {
    // no name → 'file'; bad type → octet-stream (attachment)
    let res = await upload(Buffer.from('a'), { type: 'not a mime' });
    assert.equal(res.status, 201);
    let m = await res.json();
    assert.equal(m.name, 'file');
    assert.equal(m.mime, 'application/octet-stream');
    res = await t.fetch(`/f/${m.id}/x`, { cookie });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /^attachment; /);
    assert.equal(res.headers.get('content-security-policy'), 'sandbox');

    // path separators and control chars are stripped, never reach the disk
    res = await upload(Buffer.from('b'), { name: '../evil\\name\u0001\u0007.txt  ', type: 'TEXT/Plain' });
    assert.equal(res.status, 201);
    m = await res.json();
    assert.ok(!/[\\/\x00-\x1f\x7f]/.test(m.name), `no separators or control chars, got ${JSON.stringify(m.name)}`);
    assert.equal(m.name, m.name.trim(), 'trimmed');
    assert.ok(m.name.endsWith('.txt'));
    assert.equal(m.mime, 'text/plain', 'mime lowercased');
    assert.ok(existsSync(t.app.files.blobPath(m.id)));

    // long names are capped at 200
    res = await upload(Buffer.from('c'), { name: 'n'.repeat(500) + '.bin' });
    assert.equal(res.status, 201);
    m = await res.json();
    assert.ok(m.name.length <= 200);

    // svg and html are never inline; pdf is inline and not sandboxed
    for (const [type, disp, csp] of [
      ['image/svg+xml', 'attachment', 'sandbox'],
      ['text/html', 'attachment', 'sandbox'],
      ['image/heic', 'attachment', 'sandbox'],
      ['application/pdf', 'inline', null],
      ['image/png', 'inline', 'sandbox'],
      ['video/mp4', 'inline', 'sandbox'],
      ['audio/mpeg', 'inline', 'sandbox'],
    ]) {
      res = await upload(Buffer.from('<x/>'), { name: 'f', type });
      assert.equal(res.status, 201, type);
      m = await res.json();
      assert.equal(m.mime, type);
      res = await t.fetch(`/f/${m.id}/f`, { cookie });
      assert.equal(res.status, 200, type);
      assert.equal(res.headers.get('content-type'), type);
      assert.match(res.headers.get('content-disposition'), new RegExp(`^${disp}; `), `${type} → ${disp}`);
      assert.equal(res.headers.get('content-security-policy'), csp, `${type} CSP`);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    }

    // unicode names: ascii fallback + RFC 5987 form
    res = await upload(Buffer.from('d'), { name: 'résumé ✓.txt', type: 'text/plain' });
    assert.equal(res.status, 201);
    m = await res.json();
    assert.equal(m.name, 'résumé ✓.txt');
    res = await t.fetch(`/f/${m.id}/${encodeURIComponent(m.name)}`, { cookie });
    assert.equal(res.status, 200);
    const cd = res.headers.get('content-disposition');
    const ascii = /filename="([^"]*)"/.exec(cd);
    assert.ok(ascii, `has an ascii filename: ${cd}`);
    assert.match(ascii[1], /^[\x20-\x7e]*$/, 'ascii fallback is pure ascii');
    assert.ok(cd.includes(`filename*=UTF-8''${encodeURIComponent(m.name)}`), cd);
  });

  test('delete unlinks blob + thumb and removes the row', async () => {
    const id = meta.id;
    assert.ok(existsSync(t.app.files.blobPath(id)));
    assert.ok(existsSync(t.app.files.thumbPath(id)));
    const c = await t.connectSynced(cookie);
    const broadcast = c.waitMessage('files');
    const res = await t.fetch(`/api/files/${id}`, { method: 'DELETE', cookie });
    assert.equal(res.status, 204);
    assert.ok(!existsSync(t.app.files.blobPath(id)), 'blob unlinked');
    assert.ok(!existsSync(t.app.files.thumbPath(id)), 'thumb unlinked');
    assert.equal(t.app.files.get(id), null);
    assert.equal((await t.fetch(`/f/${id}/x`, { cookie })).status, 404);
    assert.equal((await t.fetch(`/f/${id}/thumb`, { cookie })).status, 404);
    assert.ok(!(await listFiles()).files.some(f => f.id === id));
    assert.equal((await t.fetch(`/api/files/${id}`, { method: 'DELETE', cookie })).status, 404);
    const msg = await broadcast;
    assert.ok(!msg.files.some(f => f.id === id));
    c.close(); await c.closed;
  });

  test('413 when Content-Length exceeds MAX_FILE_MB (before reading); usedBytes unchanged', async () => {
    const { usedBytes } = await listFiles();
    const res = await upload(Buffer.alloc(20000, 0x33), { name: 'big.bin' });
    assert.equal(res.status, 413);
    assert.equal((await listFiles()).usedBytes, usedBytes);
    assert.deepEqual(readdirSync(t.app.cfg.tmpDir), [], 'nothing left in tmp/');
  });

  test('411 without Content-Length', async () => {
    const res = await t.raw('PUT', '/api/files?name=chunked.bin', { cookie, headers: { 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' }, body: [Buffer.from('abc'), Buffer.from('def')] });
    assert.equal(res.status, 411);
  });

  test('upload needs auth and a good Origin', async () => {
    assert.equal((await t.fetch('/api/files?name=a', { method: 'PUT', body: Buffer.from('a') })).status, 401);
    assert.equal((await t.fetch('/api/files?name=a', { method: 'PUT', cookie, body: Buffer.from('a'), origin: 'http://evil.example' })).status, 403);
    assert.equal((await t.fetch('/api/files?name=a', { method: 'PUT', cookie, body: Buffer.from('a'), origin: null, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  });

  test('share fallback: POST /share → 303 /, GET /share → 302 /', async () => {
    let res = await t.fetch('/share', { method: 'POST', origin: null, headers: { 'Content-Type': 'multipart/form-data; boundary=x' }, body: '--x--\r\n' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/');
    res = await t.fetch('/share', { origin: null });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
  });

  test('tmp/ is empty and rows match the list after the suite\'s uploads', async () => {
    assert.equal(t.app.files.inFlight(), 0);
    assert.deepEqual(readdirSync(t.app.cfg.tmpDir), []);
    assert.equal(rowCount(), (await listFiles()).files.length);
    // every row has its blob and vice versa
    const onDisk = readdirSync(t.app.cfg.filesDir).filter(n => !n.endsWith('.thumb.jpg')).sort();
    const ids = (await listFiles()).files.map(f => f.id).sort();
    assert.deepEqual(onDisk, ids);
  });
});

describe('storage cap', () => {
  let t, cookie;
  before(async () => {
    t = await startTestServer({ MAX_STORAGE_MB: '0.001' });   // 1,049 bytes total
    cookie = await t.login();
  });
  after(async () => { await t.stop(); });

  test('507 storage_full when the upload would exceed MAX_STORAGE_MB', async () => {
    const put = (n) => t.fetch('/api/files?name=blob', { method: 'PUT', cookie, body: Buffer.alloc(n, 1), headers: { 'Content-Type': 'application/octet-stream' } });
    let res = await put(600);
    assert.equal(res.status, 201);
    const first = await res.json();
    res = await put(600);
    assert.equal(res.status, 507);
    assert.equal((await res.json()).error, 'storage_full');
    assert.equal((await (await t.fetch('/api/files', { cookie })).json()).usedBytes, 600);
    // freeing space makes room again
    assert.equal((await t.fetch(`/api/files/${first.id}`, { method: 'DELETE', cookie })).status, 204);
    res = await put(600);
    assert.equal(res.status, 201);
  });
});

describe('TTL expiry', () => {
  let t, cookie;
  before(async () => {
    t = await startTestServer({ FILE_TTL_HOURS: '0.0003', SWEEP_INTERVAL_SEC: '1' });   // TTL ≈ 1.08 s
    cookie = await t.login();
  });
  after(async () => { await t.stop(); });

  test('download 404s at expiry; within 3 s the blob and the row are gone', async () => {
    const body = Buffer.from('short-lived');
    const res = await t.fetch('/api/files?name=ttl.txt&type=text/plain', { method: 'PUT', cookie, body, headers: { 'Content-Type': 'text/plain' } });
    assert.equal(res.status, 201);
    const m = await res.json();
    assert.ok(Math.abs(m.expiresAt - (m.createdAt + 0.0003 * 3600e3)) < 50, `expiresAt = createdAt + TTL, got ${m.expiresAt - m.createdAt} ms`);
    const blob = t.app.files.blobPath(m.id);
    assert.ok(existsSync(blob));

    // alive before expiry (only if we still have a comfortable margin)
    if (Date.now() < m.expiresAt - 300) {
      assert.equal((await t.fetch(`/f/${m.id}/ttl.txt`, { cookie })).status, 200);
      assert.equal((await (await t.fetch('/api/files', { cookie })).json()).files.length, 1);
    }

    // exact-to-the-moment expiry, independent of the sweeper
    await waitUntil(() => Date.now() > m.expiresAt + 5, { timeout: 3000, label: 'expiry time' });
    assert.equal((await t.fetch(`/f/${m.id}/ttl.txt`, { cookie })).status, 404);
    assert.equal(t.app.files.get(m.id), null, 'get() hides expired rows');
    assert.equal((await (await t.fetch('/api/files', { cookie })).json()).files.length, 0, 'list hides expired rows');

    // the sweeper unlinks and deletes within one interval (+ slack)
    await waitUntil(() => !existsSync(blob), { timeout: 3000, label: 'blob unlinked by the sweeper' });
    await waitUntil(() => t.app.db.prepare('SELECT COUNT(*) AS n FROM files').get().n === 0, { timeout: 3000, label: 'row deleted by the sweeper' });
    assert.equal(t.app.files.count(), 0);
    assert.equal(t.app.files.usedBytes(), 0);
  });

  test('kept files never expire', async () => {
    const res = await t.fetch('/api/files?name=keep.txt&type=text/plain', { method: 'PUT', cookie, body: Buffer.from('keep'), headers: { 'Content-Type': 'text/plain' } });
    assert.equal(res.status, 201);
    const m = await res.json();
    const keep = await t.fetch(`/api/files/${m.id}`, { method: 'PATCH', cookie, headers: { 'Content-Type': 'application/json' }, body: '{"keep":true}' });
    assert.equal(keep.status, 200);
    assert.equal((await keep.json()).expiresAt, null);
    await waitUntil(() => Date.now() > m.expiresAt + 1200, { timeout: 4000, label: 'past the original expiry + a sweep' });
    assert.equal((await t.fetch(`/f/${m.id}/keep.txt`, { cookie })).status, 200);
    assert.ok(existsSync(t.app.files.blobPath(m.id)));
  });
});
