'use strict';
// Turn a pasted Google Maps link into a restaurant record:
// short link -> long URL -> name + pin -> Places API details.

const { classifyUrl, parseMapsUrl, deriveCuisine, haversineMeters, isFoodPlace, titleCase } = require('./parse');

const MAX_HOPS = 5;
// The link itself is unusable (422) vs Google couldn't be asked (502).
const unusable = msg => Object.assign(new Error(msg), { status: 422 });
const unreachable = msg => Object.assign(new Error(msg), { status: 502 });
const TIMEOUT_MS = 10000;

// Follow maps.app.goo.gl redirects until we reach a long google.com/maps URL.
// Only Google Maps hosts are ever requested, so this can't be used to make the
// server fetch arbitrary URLs.
async function expandShortLink(url, fetchImpl = fetch) {
  let current = url;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const kind = classifyUrl(current);
    if (kind === 'long') return current;
    if (kind !== 'short') throw unusable(`Link redirected somewhere unexpected: ${current}`);
    const target = new URL(current);
    target.protocol = 'https:'; // never follow a plain-http hop
    let res;
    try {
      res = await fetchImpl(target.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'User-Agent': 'Mozilla/5.0 (NASC Food link resolver)' },
      });
    } catch (e) {
      throw unreachable(`Couldn't open the short link (${e.cause?.code || e.message}). Try again later.`);
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, target).toString();
      continue;
    }
    // Some clients get a 200 HTML page instead of a redirect; look for the
    // long URL inside it.
    if (res.ok) {
      const html = await res.text();
      const m = html.match(/https:\/\/www\.google\.[a-z.]+\/maps\/place\/[^"'\s<>\\]+/);
      const found = m && m[0].replace(/&amp;/g, '&');
      if (found && classifyUrl(found) === 'long') return found;
    }
    throw unusable(`Could not expand short link (HTTP ${res.status})`);
  }
  throw unusable('Too many redirects');
}

const FIELD_MASK = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.nationalPhoneNumber',
  'places.internationalPhoneNumber', 'places.location', 'places.types', 'places.primaryType',
  'places.googleMapsUri', 'places.websiteUri', 'places.rating', 'places.userRatingCount',
].join(',');

// Places API (New) Text Search, biased to the pin from the link.
async function lookupPlace({ name, lat, lng }, apiKey, fetchImpl = fetch) {
  const body = { textQuery: name, pageSize: 5, locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 500 } } };
  const res = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELD_MASK },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Places API error ${res.status}: ${data.error?.message || 'unknown'}`);
  const places = data.places || [];
  if (!places.length) return null;
  // Prefer the result closest to the pin; reject anything far away so a
  // same-named place in another city is never picked.
  let best = null, bestD = Infinity;
  for (const p of places) {
    if (!p.location) continue;
    const d = haversineMeters({ lat, lng }, { lat: p.location.latitude, lng: p.location.longitude });
    if (d < bestD) { best = p; bestD = d; }
  }
  return bestD <= 300 ? best : null;
}

async function resolveLink(url, { apiKey, fetchImpl = fetch } = {}) {
  if (!classifyUrl(url)) throw unusable('Not a Google Maps link');
  const longUrl = await expandShortLink(url, fetchImpl);
  const parsed = parseMapsUrl(longUrl);
  // A shared place has its name in the link (/maps/place/<name>/...). A bare
  // map position, a search or directions has none, so it isn't a restaurant.
  if (!parsed.name) throw unusable('This link is a map location, not a place. In Google Maps, open the restaurant itself and share that link.');
  // Without the pin we can't tell a place from a same-named one elsewhere.
  if (parsed.lat == null) throw unusable("This link doesn't include the place's location. In Google Maps, open the restaurant, tap Share and copy that link.");

  const rec = {
    name: parsed.name || 'Unnamed place',
    phone: null,
    address: null,
    lat: parsed.lat,
    lng: parsed.lng,
    types: [],
    placeId: null,
    featureId: parsed.featureId,
    cid: parsed.cid,
    mapsUrl: parsed.cid ? `https://maps.google.com/?cid=${parsed.cid}` : longUrl,
    website: null,
    rating: null,       // Google star rating, 1-5
    ratingCount: null,  // number of Google reviews
    sourceUrl: url,
    enriched: false,
    warning: null,
  };

  if (!apiKey) {
    rec.warning = "No Places API key set, so phone and address weren't looked up and it couldn't be checked that this is a restaurant.";
  } else {
    // With a key, the place must exist on Google at the link's pin and be
    // somewhere to eat or drink.
    let p;
    try { p = await lookupPlace(parsed, apiKey, fetchImpl); }
    catch (e) { throw unreachable(`Couldn't check this place with Google (${e.message}). Try again later.`); }
    if (!p) throw unusable(`Google has no place called "${parsed.name}" at this link's location.`);
    const name = p.displayName?.text || rec.name;
    if (!isFoodPlace(p.types)) {
      const kind = p.primaryType ? titleCase(p.primaryType).toLowerCase() : 'place';
      throw unusable(`${name} is listed on Google as a ${kind}, not a restaurant.`);
    }
    Object.assign(rec, {
      name,
      phone: p.nationalPhoneNumber || p.internationalPhoneNumber || null,
      address: p.formattedAddress || null,
      lat: p.location?.latitude ?? rec.lat,
      lng: p.location?.longitude ?? rec.lng,
      types: p.types || [],
      placeId: p.id,
      mapsUrl: p.googleMapsUri || rec.mapsUrl,
      website: p.websiteUri || null,
      rating: typeof p.rating === 'number' ? p.rating : null,
      ratingCount: Number.isInteger(p.userRatingCount) ? p.userRatingCount : null,
      enriched: true,
    });
  }
  rec.cuisine = deriveCuisine(rec.types, rec.name);
  return rec;
}

module.exports = { expandShortLink, lookupPlace, resolveLink };
