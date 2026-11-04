'use strict';
// Tests for the HTTP service: POST /convert, its limits, and the zip it returns.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createServer } = require('../lib/server');
const { migrate } = require('../lib/index');
const { zip } = require('../lib/zip');

const FIXTURE = path.join(__dirname, '..', '..', 'fixtures', 'sample01');
const BASE = fs.readFileSync(path.join(FIXTURE, 'bigip_base.conf'), 'utf8');
const MAIN = fs.readFileSync(path.join(FIXTURE, 'bigip.conf'), 'utf8');

// reads a zip back through its central directory, as an unzip tool would
function unzip(buf) {
  const end = buf.length - 22;
  assert.strictEqual(buf.readUInt32LE(end), 0x06054b50);
  const files = {};
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    assert.strictEqual(buf.readUInt32LE(p), 0x02014b50);
    const packedLen = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const data = local + 30 + buf.readUInt16LE(local + 26);
    files[name] = zlib.inflateRawSync(buf.slice(data, data + packedLen)).toString('utf8');
    p += 46 + nameLen;
  }
  return files;
}

let server, base;
function listen(opts) {
  return new Promise((resolve) => {
    const s = createServer(opts);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

before(async () => {
  server = await listen({ maxUploadBytes: 1024 * 1024 });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => { server.closeAllConnections(); server.close(); });

const post = (body, query) => fetch(base + '/convert' + (query || ''), { method: 'POST', body });

test('zip round-trips names and content', () => {
  const files = { 'a.txt': 'hello\n', 'b.txt': 'x'.repeat(5000) };
  assert.deepStrictEqual(unzip(zip(files)), files);
});

test('GET /healthz', async () => {
  const r = await fetch(base + '/healthz');
  assert.strictEqual(r.status, 200);
});

test('POST /convert returns the same config as the library', async () => {
  const r = await post(BASE + MAIN);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'application/zip');
  const files = unzip(Buffer.from(await r.arrayBuffer()));
  const expected = migrate([BASE, MAIN], { rdMode: 'auto', partitions: [] });
  assert.strictEqual(files['alteon-config.txt'], expected.output);
  assert.strictEqual(files['needs-manual-work.txt'], expected.log1);
  assert.strictEqual(files['not-supported.txt'], expected.log2);
  assert.deepStrictEqual(JSON.parse(files['summary.json']).converted, expected.summary);
});

test('input errors are reported as 4xx with a JSON message', async () => {
  const cases = [
    [() => post(''), 400, /empty upload/],
    [() => post(MAIN, '?rdMode=nope'), 400, /rdMode/],
    [() => post('this is not a config\n'), 422, /no F5 configuration objects/],
    [() => post(Buffer.from([1, 0, 2, 0])), 422, /binary content/],
    [() => post(Buffer.alloc(2 * 1024 * 1024, 0x61)), 413, /limit/]
  ];
  for (const [send, status, message] of cases) {
    const r = await send();
    assert.strictEqual(r.status, status);
    const { error } = await r.json();
    assert.match(error, message);
    assert.doesNotMatch(error, /f5-to-alteon-/, 'temp path must not leak');
  }
});

test('unknown route and wrong method', async () => {
  assert.strictEqual((await fetch(base + '/nope')).status, 404);
  assert.strictEqual((await fetch(base + '/convert')).status, 405);
});

test('over the concurrency limit gets 503', async () => {
  const busy = await listen({ maxConcurrent: 0 });
  const r = await fetch('http://127.0.0.1:' + busy.address().port + '/convert', { method: 'POST', body: MAIN });
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.headers.get('retry-after'), '30');
  busy.closeAllConnections();
  busy.close();
});

test('a conversion that runs too long gets 504', async () => {
  const slow = await listen({ convertTimeoutMs: 1 });
  const r = await fetch('http://127.0.0.1:' + slow.address().port + '/convert', { method: 'POST', body: MAIN });
  assert.strictEqual(r.status, 504);
  slow.closeAllConnections();
  slow.close();
});
