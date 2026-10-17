'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractMapsLinks, parseMapsUrl, deriveCuisine, classifyUrl } = require('../lib/parse');
const { resolveLink, expandShortLink } = require('../lib/resolve');

const SHORT = 'https://maps.app.goo.gl/v5wA1hGRb3JP2tYb8';
// The Location header Google returned for SHORT on 2026-10-17.
const LONG = 'https://www.google.com/maps/place/Szechuan+Brothers+Chinese+Restaurant/@45.6176348,-122.5343915,21z/data=!4m6!3m5!1s0x5495a5b41df92d73:0xa21fc128308ac6f2!8m2!3d45.6176318!4d-122.5346857!16s%2Fg%2F11gnsk9d2l!5m1!1e1?entry=tts&g_ep=EgoyMDI2MTAxMy4wIPu8ASoASAFQAw%3D%3D&skid=89e80e25-40a3-4111-87a4-a142d2d05179';

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    const r = routes(url, opts);
    if (!r) throw new Error(`unexpected fetch ${url}`);
    return new Response(r.body ?? null, { status: r.status, headers: r.headers });
  };
  fn.calls = calls;
  return fn;
}

test('extracts links from markdown, bullets and plain text, deduped', () => {
  const text = `# Lunch\n- [Szechuan](${SHORT})\n* ${SHORT}\n${LONG}.\nnot a map https://example.com/x\nhttps://goo.gl/maps/abc123,`;
  assert.deepStrictEqual(extractMapsLinks(text), [SHORT, LONG, 'https://goo.gl/maps/abc123']);
});

test('rejects non-Google hosts that look similar', () => {
  assert.strictEqual(classifyUrl('https://google.com.evil.example/maps/place/x'), null);
  assert.strictEqual(classifyUrl('https://evil.example/?u=https://maps.app.goo.gl/x'), null);
  assert.strictEqual(classifyUrl('https://goo.gl/notmaps'), null);
  assert.strictEqual(classifyUrl('javascript:alert(1)'), null);
});

test('parses name, pin (not camera) and feature id from the example long URL', () => {
  const p = parseMapsUrl(LONG);
  assert.strictEqual(p.name, 'Szechuan Brothers Chinese Restaurant');
  assert.strictEqual(p.lat, 45.6176318);
  assert.strictEqual(p.lng, -122.5346857);
  assert.strictEqual(p.featureId, '0x5495a5b41df92d73:0xa21fc128308ac6f2');
  assert.strictEqual(p.cid, BigInt('0xa21fc128308ac6f2').toString());
});

test('falls back to camera coords and q= names', () => {
  const p = parseMapsUrl('https://www.google.com/maps/place/Foo+Bar/@10.5,-20.25,15z');
  assert.deepStrictEqual([p.name, p.lat, p.lng], ['Foo Bar', 10.5, -20.25]);
  const q = parseMapsUrl('https://maps.google.com/?q=Pho+Hung&ll=1.5,2.5');
  assert.deepStrictEqual([q.name, q.lat, q.lng], ['Pho Hung', 1.5, 2.5]);
});

test('derives food type from Places types, then the name', () => {
  assert.strictEqual(deriveCuisine(['chinese_restaurant', 'restaurant', 'food'], 'X'), 'Chinese');
  assert.strictEqual(deriveCuisine(['sushi_restaurant'], 'X'), 'Japanese');
  assert.strictEqual(deriveCuisine(['restaurant'], 'Szechuan Brothers'), 'Chinese');
  assert.strictEqual(deriveCuisine([], 'Pho 99'), 'Vietnamese');
  assert.strictEqual(deriveCuisine(['restaurant', 'food'], 'Bob’s Place'), 'Other');
  assert.strictEqual(deriveCuisine(['basque_restaurant'], 'Zazpi'), 'Basque');
});

test('expands the short link with a manual redirect and stays on Google hosts', async () => {
  const f = fakeFetch(u => u === SHORT ? { status: 302, headers: { location: LONG } } : null);
  assert.strictEqual(await expandShortLink(SHORT, f), LONG);
  assert.strictEqual(f.calls[0].opts.redirect, 'manual');
  assert.strictEqual(f.calls.length, 1, 'long URL must not be fetched');
  const evil = fakeFetch(() => ({ status: 302, headers: { location: 'http://169.254.169.254/latest' } }));
  await assert.rejects(expandShortLink(SHORT, evil), /unexpected/);
  assert.strictEqual(evil.calls.length, 1);
});

test('resolves without an API key using link data only', async () => {
  const f = fakeFetch(u => u === SHORT ? { status: 302, headers: { location: LONG } } : null);
  const r = await resolveLink(SHORT, { fetchImpl: f });
  assert.strictEqual(r.name, 'Szechuan Brothers Chinese Restaurant');
  assert.strictEqual(r.cuisine, 'Chinese');
  assert.strictEqual(r.enriched, false);
  assert.match(r.warning, /No Places API key/);
});

test('enriches from Places and ignores a same-named place far away', async () => {
  const placesBody = (lat) => JSON.stringify({ places: [{
    id: 'ChIJtest', displayName: { text: 'Szechuan Brothers' }, formattedAddress: '123 Main St, Vancouver, WA',
    nationalPhoneNumber: '(360) 555-0100', location: { latitude: lat, longitude: -122.5346 },
    types: ['chinese_restaurant', 'restaurant'], googleMapsUri: 'https://maps.google.com/?cid=1',
  }] });
  let lat = 45.61765;
  const f = fakeFetch((u, o) => {
    if (u === SHORT) return { status: 302, headers: { location: LONG } };
    if (u.startsWith('https://places.googleapis.com/')) {
      assert.strictEqual(o.headers['X-Goog-Api-Key'], 'k');
      assert.ok(o.headers['X-Goog-FieldMask'].includes('places.nationalPhoneNumber'));
      return { status: 200, body: placesBody(lat) };
    }
  });
  const r = await resolveLink(SHORT, { apiKey: 'k', fetchImpl: f });
  assert.deepStrictEqual([r.enriched, r.phone, r.placeId, r.cuisine], [true, '(360) 555-0100', 'ChIJtest', 'Chinese']);

  lat = 47.6; // Seattle, ~220 km away
  const far = await resolveLink(SHORT, { apiKey: 'k', fetchImpl: f });
  assert.strictEqual(far.enriched, false);
  assert.strictEqual(far.lat, 45.6176318);
  assert.match(far.warning, /no matching place/);
});

test('reports Places API errors as a warning, not a failure', async () => {
  const f = fakeFetch(u => u === SHORT ? { status: 302, headers: { location: LONG } }
    : { status: 403, body: JSON.stringify({ error: { message: 'API key not valid' } }) });
  const r = await resolveLink(SHORT, { apiKey: 'bad', fetchImpl: f });
  assert.strictEqual(r.enriched, false);
  assert.match(r.warning, /403.*API key not valid/);
});

test('HTTP API: add (bulk), dedupe, filter data, edit, delete, persistence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nascfood-'));
  process.env.DATA_FILE = path.join(dir, 'r.json');
  for (const k of ['GOOGLE_MAPS_API_KEY', 'GOOGLE_MAPS_BROWSER_KEY', 'GOOGLE_PLACES_SERVER_KEY', 'OFFICE_LAT', 'OFFICE_LNG', 'OFFICE_NAME']) delete process.env[k];
  delete require.cache[require.resolve('../server')];
  const { createServer, loadStore } = require('../server');
  loadStore();
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (p, o = {}) => { const r = await fetch(base + p, { headers: { 'Content-Type': 'application/json' }, ...o }); return [r.status, await r.json()]; };
  try {
    const text = `- [a](${LONG})\n- https://www.google.com/maps/place/Pho+Hung/@45.6,-122.6,17z\n- ${LONG}\n- https://example.com`;
    const [s1, b1] = await j('/api/restaurants', { method: 'POST', body: JSON.stringify({ text }) });
    assert.strictEqual(s1, 200);
    assert.deepStrictEqual(b1.results.map(r => r.status), ['added', 'added']); // duplicate link deduped by extractor
    const [, b2] = await j('/api/restaurants', { method: 'POST', body: JSON.stringify({ url: LONG }) });
    assert.strictEqual(b2.results[0].status, 'duplicate');
    const [s3] = await j('/api/restaurants', { method: 'POST', body: JSON.stringify({ text: 'nothing here' }) });
    assert.strictEqual(s3, 400);

    const [, list] = await j('/api/restaurants');
    assert.deepStrictEqual(list.map(r => r.cuisine).sort(), ['Chinese', 'Vietnamese']);
    const pho = list.find(r => r.name === 'Pho Hung');
    const [, edited] = await j(`/api/restaurants/${pho.id}`, { method: 'PATCH', body: JSON.stringify({ cuisine: 'Noodles' }) });
    assert.deepStrictEqual([edited.cuisine, edited.cuisineManual], ['Noodles', true]);
    const [sr, refreshed] = await j(`/api/restaurants/${pho.id}/refresh`, { method: 'POST' });
    assert.strictEqual(sr, 200);
    assert.strictEqual(refreshed.restaurant.cuisine, 'Noodles', 'manual food type survives a refresh');
    assert.match(refreshed.warning, /No Places API key/);
    await j(`/api/restaurants/${list[0].id}`, { method: 'DELETE' });
    await new Promise(r => setTimeout(r, 50));
    const onDisk = JSON.parse(fs.readFileSync(process.env.DATA_FILE, 'utf8'));
    assert.strictEqual(onDisk.length, 1);

    const [sb, bad] = await j('/api/restaurants/delete', { method: 'POST', body: JSON.stringify({ ids: 'x' }) });
    assert.strictEqual(sb, 400, bad.error);
    await j('/api/restaurants', { method: 'POST', body: JSON.stringify({ text: 'https://www.google.com/maps/place/A/@1,1,17z https://www.google.com/maps/place/B/@2,2,17z' }) });
    const [, three] = await j('/api/restaurants');
    assert.strictEqual(three.length, 3);
    const [, del] = await j('/api/restaurants/delete', { method: 'POST', body: JSON.stringify({ ids: [three[1].id, three[2].id, 'no-such-id'] }) });
    assert.strictEqual(del.deleted, 2);
    const [, left] = await j('/api/restaurants');
    assert.deepStrictEqual(left.map(r => r.id), [three[0].id]);
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(JSON.parse(fs.readFileSync(process.env.DATA_FILE, 'utf8')).length, 1);

    const [, cfg] = await j('/api/config');
    assert.strictEqual(cfg.office.placeholder, true);
    const trav = await fetch(base + '/..%2fserver.js');
    assert.notStrictEqual(trav.status, 200);
    const page = await fetch(base + '/');
    assert.match(await page.text(), /NASC Food/);
  } finally {
    srv.close();
  }
});
