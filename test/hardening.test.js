'use strict';
// Tests for the code review fixes: bad requests can't crash the server, the
// login lockout holds under parallel guesses, saving recovers from errors,
// and link parsing edge cases.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { findLinks, parseMapsUrl } = require('../lib/parse');
const { resolveLink, expandShortLink } = require('../lib/resolve');
const { createStore } = require('../lib/store');
const auth = require('../lib/auth');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nascfood-'));

// A fresh server module with its own env and data file.
async function startServer(env = {}) {
  const saved = { ...process.env };
  for (const k of ['GOOGLE_MAPS_API_KEY', 'GOOGLE_MAPS_BROWSER_KEY', 'GOOGLE_PLACES_SERVER_KEY', 'TRUST_PROXY']) delete process.env[k];
  const dataFile = path.join(tmpdir(), 'r.json');
  Object.assign(process.env, { DATA_FILE: dataFile, ...env });
  delete require.cache[require.resolve('../server')];
  const { createServer, loadStore } = require('../server');
  process.env = saved;
  loadStore();
  const srv = createServer().listen(0);
  await new Promise(r => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { srv, base, port: srv.address().port, dataFile };
}

// Send raw bytes (fetch would normalise the bad request away).
function raw(port, request) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.end(request));
    let out = '';
    s.on('data', d => { out += d; });
    s.on('end', () => resolve(out));
    s.on('error', reject);
  });
}

test('malformed requests get 4xx and never crash the server', async () => {
  const { srv, base, port } = await startServer({ ADMIN_PASSWORD_HASH: await auth.hashPassword('right password 1') });
  try {
    for (const target of ['//x:99999/', '//[', 'http://[/']) {
      const res = await raw(port, `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      assert.match(res, /^HTTP\/1\.1 400/, target);
    }
    assert.strictEqual((await fetch(base + '/%E0%A4%A')).status, 400);
    assert.strictEqual((await fetch(base + '/a%00b')).status, 400);
    assert.strictEqual((await fetch(base + '/healthz')).status, 200, 'still running');

    const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
    const nul = await post('/api/auth/login', 'null');
    assert.strictEqual(nul.status, 400);
    const big = await post('/api/auth/login', JSON.stringify({ password: 'x'.repeat(300000) })).catch(e => e);
    assert.ok(big instanceof Error || big.status === 413, 'oversized body is refused');

    const put = await fetch(base + '/api/restaurants', { method: 'PUT' });
    assert.strictEqual(put.status, 405);
    assert.match(put.headers.get('allow'), /GET, POST/);
    assert.strictEqual((await fetch(base + '/api/restaurants/archive')).status, 405);
    assert.strictEqual((await fetch(base + '/api/nope')).status, 404);

    // Unexpected errors don't leak details.
    const err = await (await fetch(base + '/api/restaurants', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":1}' })).json();
    assert.doesNotMatch(JSON.stringify(err), /\/(tmp|home)\//);
  } finally { srv.close(); }
});

test('the page sends a nonce-based CSP that matches its script tag', async () => {
  const { srv, base } = await startServer();
  try {
    const res = await fetch(base + '/');
    const csp = res.headers.get('content-security-policy');
    const nonce = csp.match(/'nonce-([^']+)'/)[1];
    assert.ok((await res.text()).includes(`<script src="app.js" nonce="${nonce}">`));
    assert.match(csp, /frame-ancestors 'none'/);
    assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
    const again = (await fetch(base + '/')).headers.get('content-security-policy');
    assert.notStrictEqual(again, csp, 'a new nonce per response');
  } finally { srv.close(); }
});

test('parallel wrong passwords are capped by the lockout, and the last X-Forwarded-For entry counts', async () => {
  const { srv, base } = await startServer({ ADMIN_PASSWORD_HASH: await auth.hashPassword('right password 1'), TRUST_PROXY: '1' });
  const login = (pw, xff) => fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff }, body: JSON.stringify({ password: pw }) }).then(r => r.status);
  try {
    // A burst gets at most a couple of password checks at once (the rest are
    // told to retry), and every check counts towards the lockout.
    const burst = await Promise.all(Array.from({ length: 12 }, () => login('wrong', '203.0.113.5')));
    assert.ok(burst.filter(s => s === 401).length <= 5, `at most 5 checked: ${burst}`);
    assert.ok(burst.every(s => s === 401 || s === 429), String(burst));
    let tries = 0;
    while (await login('wrong', '203.0.113.5') !== 429) assert.ok(++tries <= 5, 'locked out within 5 wrong passwords in total');
    // The client can't dodge the lockout by putting a fake address first.
    assert.strictEqual(await login('right password 1', '1.1.1.1, 203.0.113.5'), 429);
    assert.strictEqual(await login('right password 1', '198.51.100.7'), 200);
  } finally { srv.close(); }
});

test('lockout: old failures expire, IPv6 counts per /64, and the table is bounded', t => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (let i = 0; i < 4; i++) auth.recordFailure('192.0.2.9');
  Date.now.mock.mockImplementation(() => now + 16 * 60 * 1000);
  auth.recordFailure('192.0.2.9');
  assert.strictEqual(auth.lockedFor('192.0.2.9'), 0, 'four old typos plus one new one is not a lockout');
  for (let i = 0; i < 5; i++) auth.recordFailure(`2001:db8:1:2::${i + 1}`);
  assert.ok(auth.lockedFor('2001:db8:1:2:ffff::1') > 0, 'same /64');
  assert.strictEqual(auth.lockedFor('2001:db8:1:3::1'), 0, 'other /64');
  for (let i = 0; i < 10050; i++) auth.recordFailure(`10.${i >> 16 & 255}.${i >> 8 & 255}.${i & 255}`);
  assert.strictEqual(auth.lockedFor('2001:db8:1:2::1'), 0, 'oldest entries dropped once the table is full');
});

test('saving recovers after a failed write, and backs up once a day', async () => {
  const dir = tmpdir(), file = path.join(dir, 'r.json');
  const store = createStore(file);
  const errors = [];
  const origError = console.error; console.error = m => errors.push(m);
  try {
    store.items.push({ id: 'a' });
    await store.save();
    await store.save(); // first change of the day with a file on disk: backed up
    fs.unlinkSync(file); fs.mkdirSync(file); // make the next write fail
    store.items.push({ id: 'b' });
    await assert.rejects(store.save(), /Couldn't save to disk/);
    assert.ok(store.lastError);
    fs.rmdirSync(file); // disk is fine again
    store.items.push({ id: 'c' });
    await store.save();
    assert.strictEqual(store.lastError, null);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map(r => r.id), ['a', 'b', 'c']);
    assert.ok(errors.some(m => /failed/.test(m)), 'the failure was logged');
    const backups = fs.readdirSync(path.join(dir, 'backups'));
    assert.strictEqual(backups.length, 1);
    assert.match(backups[0], /^restaurants-\d{4}-\d\d-\d\d\.json$/);
  } finally { console.error = origError; }
});

test('an add whose save fails is undone and reported', async () => {
  const { srv, base, dataFile: file } = await startServer({ ADMIN_PASSWORD_HASH: await auth.hashPassword('right password 1') });
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'right password 1' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const add = url => fetch(base + '/api/restaurants', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ url }) }).then(r => r.json());
  const origError = console.error; console.error = () => {};
  try {
    const health = await (await fetch(base + '/healthz')).json();
    assert.strictEqual(health.ok, true);
    await add('https://www.google.com/maps/place/First/@1,1,17z');
    fs.unlinkSync(file); fs.mkdirSync(file); // block the data file
    const r = await add('https://www.google.com/maps/place/Second/@2,2,17z');
    assert.strictEqual(r.results[0].status, 'error');
    assert.strictEqual((await fetch(base + '/healthz')).status, 503);
    const list = await (await fetch(base + '/api/restaurants')).json();
    assert.deepStrictEqual(list.map(x => x.name), ['First'], 'the failed add is not listed');
    fs.rmdirSync(file);
  } finally { console.error = origError; srv.close(); }
});

test('refresh keeps a phone and address set by hand', async () => {
  const { srv, base } = await startServer({ ADMIN_PASSWORD_HASH: await auth.hashPassword('right password 1') });
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'right password 1' }) });
  const headers = { 'Content-Type': 'application/json', Cookie: login.headers.get('set-cookie').split(';')[0] };
  try {
    const { results } = await (await fetch(base + '/api/restaurants', { method: 'POST', headers, body: JSON.stringify({ url: 'https://www.google.com/maps/place/Pho/@1,1,17z' }) })).json();
    const id = results[0].restaurant.id;
    await fetch(`${base}/api/restaurants/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ phone: '360-555-1234', address: '1 Main' }) });
    const { restaurant } = await (await fetch(`${base}/api/restaurants/${id}/refresh`, { method: 'POST', headers })).json();
    assert.deepStrictEqual([restaurant.phone, restaurant.address], ['360-555-1234', '1 Main']);
  } finally { srv.close(); }
});

test('link parsing edge cases', async () => {
  const denny = "https://www.google.com/maps/place/Denny's/@45.6,-122.5,17z";
  assert.deepStrictEqual(findLinks(`- [Denny's](${denny})`).maps, [denny], 'apostrophe kept, Markdown ) dropped');
  assert.deepStrictEqual(findLinks('see (https://www.google.com/maps/place/A_(B)/@1,2,17z).').maps, ['https://www.google.com/maps/place/A_(B)/@1,2,17z']);
  assert.strictEqual(parseMapsUrl('https://www.google.com/maps/place/Caf%E9+Bleu/@45.6,-122.5,17z').lat, 45.6, 'non-UTF-8 escapes do not throw');
  await assert.rejects(resolveLink('https://maps.google.com/?q=Pho+Hung', { fetchImpl: async () => { throw new Error('no fetch'); } }), /doesn't include the place's location/);

  // The HTML fallback only accepts real Google Maps URLs, and http hops are upgraded.
  const seen = [];
  const fake = async url => { seen.push(url); return new Response('<a href="https://www.google.evil.com/maps/place/X/@1,2">', { status: 200 }); };
  await assert.rejects(expandShortLink('http://maps.app.goo.gl/abc', fake), /Could not expand/);
  assert.deepStrictEqual(seen, ['https://maps.app.goo.gl/abc']);
});

test('.env loader handles export, quotes with comments, and keeps real env vars', () => {
  const { loadDotEnv } = require('../server');
  const file = path.join(tmpdir(), '.env');
  fs.writeFileSync(file, 'export NASC_T1=a\nNASC_T2="b c" # note\nNASC_T3=d # note\nNASC_T4=has#hash\nPATH=nope\n');
  const before = process.env.PATH;
  loadDotEnv(file);
  try {
    assert.deepStrictEqual([process.env.NASC_T1, process.env.NASC_T2, process.env.NASC_T3, process.env.NASC_T4], ['a', 'b c', 'd', 'has#hash']);
    assert.strictEqual(process.env.PATH, before);
  } finally { for (const k of ['NASC_T1', 'NASC_T2', 'NASC_T3', 'NASC_T4']) delete process.env[k]; }
});
