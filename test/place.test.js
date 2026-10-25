'use strict';
// The opened restaurant's name and address in the visitor's language
// (GET /api/place/:id), the rate limit behind it, and the Google Maps link's hl.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLimiter } = require('../lib/ratelimit');
const { localizedMapsUrl } = require('../public/i18n');

const rec = (id, extra = {}) => ({ id, name: `Place ${id}`, lat: 45.6, lng: -122.5, cuisine: 'Chinese', address: '1 Main St',
  mapsUrl: 'https://maps.google.com/?cid=1', addedAt: '2026-10-01T00:00:00Z', ...extra });
// The real fetch, kept once so every server's stub is removed again.
const REAL_FETCH = globalThis.fetch;
const RESTAURANTS = [
  rec('r1', { placeId: 'ChIJ_abc-1' }),
  rec('r2'), // added without a Places key
  rec('r3', { placeId: 'ChIJgone', archivedAt: '2026-10-02T00:00:00Z' }),
  rec('r4', { placeId: 'bad id/../x?y' }), // not a place ID we would ever have stored
];

// A server with the restaurants above on disk. Google (Place Details) is
// answered by `google(url, opts)`; everything else goes to the real fetch.
async function start(google, { key = 'server-key', env = {} } = {}) {
  const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'foodmap-')), 'r.json');
  fs.writeFileSync(dataFile, JSON.stringify(RESTAURANTS));
  const saved = { ...process.env };
  for (const k of ['GOOGLE_MAPS_API_KEY', 'GOOGLE_MAPS_BROWSER_KEY', 'GOOGLE_PLACES_SERVER_KEY', 'TRUST_PROXY']) delete process.env[k];
  Object.assign(process.env, { DATA_FILE: dataFile, ...(key ? { GOOGLE_PLACES_SERVER_KEY: key } : {}), ...env });
  delete require.cache[require.resolve('../server')];
  const { createServer, loadStore } = require('../server');
  process.env = saved;
  loadStore();
  const calls = [];
  globalThis.fetch = (url, opts) => {
    if (String(url).startsWith('https://places.googleapis.com/')) { calls.push({ url: String(url), opts }); return google(String(url), opts); }
    return REAL_FETCH(url, opts);
  };
  const srv = createServer().listen(0);
  await new Promise(r => srv.once('listening', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, dataFile, calls, stop: () => new Promise(done => { globalThis.fetch = REAL_FETCH; srv.close(done); srv.closeAllConnections(); }) };
}
const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const ZH = { displayName: { text: '四川兄弟餐廳', languageCode: 'zh-TW' }, formattedAddress: '美國華盛頓州溫哥華市 Main St 1 號', attributions: [] };

test('place: lang is validated; unknown and archived ids are 404', async () => {
  const s = await start(() => json(ZH));
  try {
    for (const q of ['', '?lang=ja', '?lang=zh-tw', '?lang=zh-TW%00']) {
      assert.strictEqual((await fetch(`${s.base}/api/place/r1${q}`)).status, 400, q);
    }
    assert.strictEqual((await fetch(`${s.base}/api/place/nope?lang=zh-TW`)).status, 404);
    assert.strictEqual((await fetch(`${s.base}/api/place/r3?lang=zh-TW`)).status, 404, 'archived');
    assert.strictEqual(s.calls.length, 0, 'Google was never asked');
    assert.strictEqual((await fetch(`${s.base}/api/place/r1?lang=en`)).status, 200);
  } finally { await s.stop(); }
});

test('place: no place ID or no key means "not available", without asking Google', async () => {
  const s = await start(() => json(ZH));
  try {
    const r = await fetch(`${s.base}/api/place/r2?lang=zh-TW`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(await r.json(), { available: false });
    assert.deepStrictEqual(await (await fetch(`${s.base}/api/place/r4?lang=zh-TW`)).json(), { available: false }, 'odd stored place ID');
    assert.strictEqual(s.calls.length, 0);
  } finally { await s.stop(); }
  const noKey = await start(() => json(ZH), { key: '' });
  try {
    assert.deepStrictEqual(await (await fetch(`${noKey.base}/api/place/r1?lang=zh-TW`)).json(), { available: false });
    assert.strictEqual(noKey.calls.length, 0);
  } finally { await noKey.stop(); }
});

test('place: success returns only the three fields, asks Google for only those, and stores nothing', async () => {
  const s = await start(() => json({ ...ZH, id: 'x', rating: 4.5, nationalPhoneNumber: '555', location: {} }));
  try {
    const before = fs.readFileSync(s.dataFile, 'utf8');
    const res = await fetch(`${s.base}/api/place/r1?lang=zh-TW`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('cache-control'), 'no-store');
    assert.deepStrictEqual(await res.json(), { name: '四川兄弟餐廳', nameLang: 'zh-TW', address: ZH.formattedAddress, attributions: [] });
    assert.strictEqual(s.calls.length, 1);
    const { url, opts } = s.calls[0];
    // The stored place ID, URL-encoded, never anything from the visitor.
    assert.strictEqual(url, 'https://places.googleapis.com/v1/places/ChIJ_abc-1?languageCode=zh-TW');
    assert.strictEqual(opts.headers['X-Goog-FieldMask'], 'displayName,formattedAddress,attributions');
    assert.strictEqual(opts.headers['X-Goog-Api-Key'], 'server-key');
    assert.ok(opts.signal, 'has a timeout');
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(fs.readFileSync(s.dataFile, 'utf8'), before, 'data file unchanged');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(s.dataFile)), ['r.json'], 'nothing else written');
    await fetch(`${s.base}/api/place/r1?lang=en`);
    assert.match(s.calls[1].url, /\?languageCode=en$/);
  } finally { await s.stop(); }
});

test('place: attributions are cleaned up', async () => {
  const s = await start(() => json({ ...ZH, attributions: [
    { provider: 'Yelp', providerUri: 'https://yelp.com/x' },
    { provider: 'Plain', providerUri: 'javascript:alert(1)' },
    { provider: 'NoLink' },
    { provider: 7, providerUri: 'https://a.example' },
    { providerUri: 'https://b.example' },
    'junk', null,
  ] }));
  try {
    const d = await (await fetch(`${s.base}/api/place/r1?lang=zh-TW`)).json();
    assert.deepStrictEqual(d.attributions, [
      { provider: 'Yelp', providerUri: 'https://yelp.com/x' },
      { provider: 'Plain', providerUri: null },
      { provider: 'NoLink', providerUri: null },
    ]);
  } finally { await s.stop(); }
});

test('place: a Google failure or timeout is a short 502', async () => {
  let mode = 'http';
  const s = await start(() => (mode === 'http' ? json({ error: { message: 'secret detail' } }, 403) : Promise.reject(new Error('timed out'))));
  try {
    for (mode of ['http', 'throw']) {
      const res = await fetch(`${s.base}/api/place/r1?lang=zh-TW`);
      assert.strictEqual(res.status, 502);
      const text = await res.text();
      assert.doesNotMatch(text, /secret|server-key|timed out/);
    }
  } finally { await s.stop(); }
});

test('place: 15 requests a minute per visitor address, then 429 with Retry-After', async () => {
  const s = await start(() => json(ZH), { env: { TRUST_PROXY: '1' } });
  const get = ip => fetch(`${s.base}/api/place/r1?lang=zh-TW`, { headers: { 'X-Forwarded-For': ip } });
  try {
    for (let i = 0; i < 15; i++) assert.strictEqual((await get('203.0.113.9')).status, 200, `request ${i + 1}`);
    const over = await get('203.0.113.9');
    assert.strictEqual(over.status, 429);
    const wait = Number(over.headers.get('retry-after'));
    assert.ok(wait >= 1 && wait <= 60, `Retry-After ${wait}`);
    assert.strictEqual(s.calls.length, 15, 'the refused request did not reach Google');
    assert.strictEqual((await get('203.0.113.10')).status, 200, 'another address is unaffected');
  } finally { await s.stop(); }
});

test('place: forged X-Forwarded-For does not get around the limit', async () => {
  const get = (s, xff) => fetch(`${s.base}/api/place/r1?lang=zh-TW`, { headers: { 'X-Forwarded-For': xff } }).then(r => r.status);
  // No trusted proxy: the header is ignored, so changing it changes nothing.
  const direct = await start(() => json(ZH));
  try {
    for (let i = 0; i < 15; i++) await get(direct, `198.51.100.${i}`);
    assert.strictEqual(await get(direct, '198.51.100.200'), 429);
  } finally { await direct.stop(); }
  // Behind a proxy: only the last entry (the proxy's own) counts.
  const proxied = await start(() => json(ZH), { env: { TRUST_PROXY: '1' } });
  try {
    for (let i = 0; i < 15; i++) assert.strictEqual(await get(proxied, `10.0.0.${i}, 10.1.0.${i}, 203.0.113.7`), 200);
    assert.strictEqual(await get(proxied, '1.2.3.4, 5.6.7.8, 203.0.113.7'), 429);
    assert.strictEqual(await get(proxied, '1.2.3.4, 5.6.7.8, 203.0.113.8'), 200);
  } finally { await proxied.stop(); }
});

test('place: the daily budget caps calls to Google; 0 turns lookups off', async () => {
  const s = await start(() => json(ZH), { env: { PLACE_DETAILS_PER_DAY: '2' } });
  try {
    const get = () => fetch(`${s.base}/api/place/r1?lang=zh-TW`).then(r => r.json());
    assert.strictEqual((await get()).name, '四川兄弟餐廳');
    assert.strictEqual((await get()).name, '四川兄弟餐廳');
    assert.deepStrictEqual(await get(), { available: false });
    assert.strictEqual(s.calls.length, 2, 'the third did not reach Google');
    // Calls that never reach Google (no place ID) don't use the budget.
    assert.deepStrictEqual(await (await fetch(`${s.base}/api/place/r2?lang=zh-TW`)).json(), { available: false });
  } finally { await s.stop(); }
  const off = await start(() => json(ZH), { env: { PLACE_DETAILS_PER_DAY: '0' } });
  try {
    assert.deepStrictEqual(await (await fetch(`${off.base}/api/place/r1?lang=zh-TW`)).json(), { available: false });
    assert.strictEqual(off.calls.length, 0);
  } finally { await off.stop(); }
});

test('place: one address gets only half of the daily budget (at least 10) per 24 hours', async () => {
  // Budget 5: the address cap is the floor of 10; the minute limit (15) is not reached first.
  const s = await start(() => json(ZH), { env: { PLACE_DETAILS_PER_DAY: '5' } });
  try {
    const get = () => fetch(`${s.base}/api/place/r1?lang=zh-TW`);
    for (let i = 0; i < 10; i++) assert.strictEqual((await get()).status, 200, `request ${i + 1}`);
    const over = await get();
    assert.strictEqual(over.status, 429);
    assert.ok(Number(over.headers.get('retry-after')) > 60, 'told to wait for the 24-hour window');
    assert.strictEqual(s.calls.length, 5, 'only the budget reached Google');
  } finally { await s.stop(); }
});

test('place: failed calls use the budget too, so a rejecting Google cannot be hammered', async () => {
  const s = await start(() => json({ error: { message: 'bad key' } }, 403), { env: { PLACE_DETAILS_PER_DAY: '2' } });
  try {
    const get = () => fetch(`${s.base}/api/place/r1?lang=zh-TW`);
    assert.strictEqual((await get()).status, 502);
    assert.strictEqual((await get()).status, 502);
    assert.deepStrictEqual(await (await get()).json(), { available: false });
    assert.strictEqual(s.calls.length, 2, '403s used up the budget');
  } finally { await s.stop(); }
});

test('place: a place ID Google rejects with 404 or 400 is asked for only once', async () => {
  const s = await start(() => json({ error: { message: 'Place not found: ChIJ_secret' } }, 404));
  try {
    const get = id => fetch(`${s.base}/api/place/${id}?lang=zh-TW`);
    assert.strictEqual((await get('r1')).status, 502, 'the first visitor sees a failure');
    for (let i = 0; i < 3; i++) assert.deepStrictEqual(await (await get('r1')).json(), { available: false });
    assert.strictEqual(s.calls.length, 1, 'not asked again');
  } finally { await s.stop(); }
});

test('place: a bad API key (HTTP 400) is not blamed on the restaurant, and is logged once with a hint', async () => {
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  const s = await start(() => json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } }, 400));
  try {
    for (let i = 0; i < 3; i++) assert.strictEqual((await fetch(`${s.base}/api/place/r1?lang=zh-TW`)).status, 502);
    assert.strictEqual(s.calls.length, 3, 'the restaurant was not marked bad');
    const lines = logged.filter(l => l.includes('place details for r1'));
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /check GOOGLE_PLACES_SERVER_KEY/);
    assert.doesNotMatch(lines[0], /place ID/);
  } finally { console.error = orig; await s.stop(); }
});

test('place: a 5xx is retried later and logged once per restaurant and status', async () => {
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  const s = await start(() => json({ error: {} }, 503));
  try {
    for (let i = 0; i < 4; i++) assert.strictEqual((await fetch(`${s.base}/api/place/r1?lang=zh-TW`)).status, 502);
    assert.strictEqual(s.calls.length, 4, 'a 5xx is not remembered');
    assert.strictEqual(logged.filter(l => l.includes('place details for r1')).length, 1);
  } finally { console.error = orig; await s.stop(); }
});

test('config: placeDetails is off when the budget is 0 or there is no key', async () => {
  const flag = async (opts) => { const s = await start(() => json(ZH), opts); try { return (await (await fetch(`${s.base}/api/config`)).json()).placeDetails; } finally { await s.stop(); } };
  assert.strictEqual(await flag({}), true);
  assert.strictEqual(await flag({ env: { PLACE_DETAILS_PER_DAY: '0' } }), false);
  assert.strictEqual(await flag({ key: '' }), false);
  assert.strictEqual(await flag({ env: { PLACE_DETAILS_PER_DAY: 'lots' } }), true, 'invalid value: default budget');
});

test('rate limiter: window resets and the table stays bounded', () => {
  let t = 1000;
  const l = createLimiter({ max: 2, windowMs: 100, maxTracked: 3, now: () => t });
  assert.strictEqual(l.check('a'), 0);
  assert.strictEqual(l.check('a'), 0);
  assert.strictEqual(l.check('a'), 100);
  t += 100;
  assert.strictEqual(l.check('a'), 0, 'new window');
  for (const k of 'bcdefg') l.check(k);
  assert.ok(l.size <= 3);
});

test('Google Maps links open in Chinese on the Chinese page only', () => {
  const long = 'https://www.google.com/maps/place/X/@45.6,-122.5,15z?entry=tts';
  assert.strictEqual(localizedMapsUrl(long, 'en'), long);
  assert.strictEqual(new URL(localizedMapsUrl(long, 'zh-TW')).searchParams.get('hl'), 'zh-TW');
  assert.strictEqual(new URL(localizedMapsUrl(long, 'zh-TW')).searchParams.get('entry'), 'tts', 'other parameters kept');
  assert.strictEqual(localizedMapsUrl('https://maps.google.com/?cid=1&hl=en', 'zh-TW'), 'https://maps.google.com/?cid=1&hl=zh-TW');
  for (const same of ['https://maps.app.goo.gl/abc', 'http://maps.google.com/?cid=1', 'https://example.com/maps/x',
    'https://www.google.com/search?q=x', 'javascript:alert(1)', 'not a url', '', null, undefined]) {
    assert.strictEqual(localizedMapsUrl(same, 'zh-TW'), same, String(same));
  }
});
