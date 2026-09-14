// Chunked uploads: session → parts (out of order, one re-sent) → complete → identical bytes; abort; validation.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { startTestServer } from './helpers.js';

const JSON_CT = { 'Content-Type': 'application/json' };
const OCTET = { 'Content-Type': 'application/octet-stream' };
const CHUNK = 1024;

describe('chunked uploads', () => {
  let t, cookie;
  before(async () => { t = await startTestServer({ uploadChunkBytes: CHUNK, MAX_FILE_MB: '0.01' }); cookie = await t.login(); });
  after(async () => { await t.stop(); });

  const create = (body) => t.fetch('/api/uploads', { method: 'POST', cookie, headers: JSON_CT, body: JSON.stringify(body) });
  const put = (id, i, bytes) => t.fetch(`/api/uploads/${id}/${i}`, { method: 'PUT', cookie, headers: OCTET, body: bytes });
  const complete = (id) => t.fetch(`/api/uploads/${id}/complete`, { method: 'POST', cookie });

  test('parts arrive out of order and one is re-sent; the blob is byte-identical', async () => {
    const data = randomBytes(CHUNK * 3 + 100);           // 4 parts, last one short
    const r = await create({ name: 'big.bin', type: 'application/octet-stream', size: data.length });
    assert.equal(r.status, 201);
    const sess = await r.json();
    assert.equal(sess.chunkSize, CHUNK);
    assert.equal(sess.chunks, 4);
    const part = (i) => data.subarray(i * CHUNK, Math.min(data.length, (i + 1) * CHUNK));
    assert.equal((await complete(sess.id)).status, 409);  // nothing received yet
    for (const i of [3, 1, 0]) assert.equal((await put(sess.id, i, part(i))).status, 204);
    const inc = await complete(sess.id);
    assert.equal(inc.status, 409);
    assert.deepEqual((await inc.json()).missing, [2]);
    assert.equal((await put(sess.id, 2, part(2))).status, 204);
    assert.equal((await put(sess.id, 1, part(1))).status, 204); // re-send of a part is fine
    const done = await complete(sess.id);
    assert.equal(done.status, 201);
    const meta = await done.json();
    assert.equal(meta.id, sess.id);
    assert.equal(meta.size, data.length);
    assert.equal(meta.name, 'big.bin');
    assert.ok(readFileSync(t.app.files.blobPath(meta.id)).equals(data));
    assert.ok(!existsSync(t.app.files.tmpPath(meta.id)));
    const dl = await t.fetch(`/f/${meta.id}/big.bin`, { cookie });
    assert.equal(dl.status, 200);
    assert.equal(Buffer.from(await dl.arrayBuffer()).length, data.length);
    assert.equal((await complete(sess.id)).status, 404);   // session is gone after completion
  });

  test('wrong part length is rejected, bad index is rejected, abort removes the tmp file', async () => {
    const r = await create({ name: 'x', type: 'text/plain', size: CHUNK + 5 });
    const sess = await r.json();
    assert.equal((await put(sess.id, 0, randomBytes(CHUNK - 1))).status, 400);
    assert.equal((await put(sess.id, 1, randomBytes(CHUNK))).status, 400);   // last part must be exactly 5 bytes
    assert.equal((await put(sess.id, 2, randomBytes(1))).status, 400);       // no such index
    assert.ok(existsSync(t.app.files.tmpPath(sess.id)));
    assert.equal((await t.fetch(`/api/uploads/${sess.id}`, { method: 'DELETE', cookie })).status, 204);
    assert.ok(!existsSync(t.app.files.tmpPath(sess.id)));
    assert.equal((await put(sess.id, 0, randomBytes(CHUNK))).status, 404);
  });

  test('size validation and auth', async () => {
    assert.equal((await create({ name: 'a', type: 'text/plain', size: -1 })).status, 400);
    assert.equal((await create({ name: 'a', type: 'text/plain', size: 20 * 1024 })).status, 413);  // MAX_FILE_MB 0.01
    assert.equal((await t.fetch('/api/uploads', { method: 'POST', headers: JSON_CT, body: '{"size":1}' })).status, 401);
    const zero = await create({ name: 'empty.txt', type: 'text/plain', size: 0 });
    const sess = await zero.json();
    assert.equal(sess.chunks, 1);
    assert.equal((await put(sess.id, 0, Buffer.alloc(0))).status, 204);
    assert.equal((await complete(sess.id)).status, 201);
  });
});

describe('storage cap is shared across upload paths', () => {
  let t, cookie;
  // cap ~2 chunks; MAX_FILE_MB big enough that a single file is not the limit
  before(async () => { t = await startTestServer({ uploadChunkBytes: CHUNK, MAX_STORAGE_MB: '0.002', MAX_FILE_MB: '1' }); cookie = await t.login(); });
  after(async () => { await t.stop(); });

  test('a chunked reservation makes a concurrent raw PUT hit the cap', async () => {
    const capBytes = Math.round(0.002 * 1024 * 1024); // ~2097
    // Open a chunked session reserving most of the cap...
    const r = await t.fetch('/api/uploads', { method: 'POST', cookie, headers: JSON_CT, body: JSON.stringify({ name: 'big', type: 'application/octet-stream', size: capBytes - 100 }) });
    assert.equal(r.status, 201);
    // ...now a raw PUT that fits under the cap on its own must be refused because the reservation is counted.
    const put = await t.fetch('/api/files?name=x&type=text/plain', { method: 'PUT', cookie, headers: { 'Content-Type': 'text/plain', 'Content-Length': String(200) }, body: 'y'.repeat(200) });
    assert.equal(put.status, 507);
    // abort the chunked session; the reservation is released and the raw PUT now succeeds.
    const sess = await r.json();
    assert.equal((await t.fetch(`/api/uploads/${sess.id}`, { method: 'DELETE', cookie })).status, 204);
    const put2 = await t.fetch('/api/files?name=x&type=text/plain', { method: 'PUT', cookie, headers: { 'Content-Type': 'text/plain', 'Content-Length': String(200) }, body: 'y'.repeat(200) });
    assert.equal(put2.status, 201);
  });
});
