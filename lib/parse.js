'use strict';
// Pure helpers: pulling links out of pasted text, reading place data out of
// Google Maps URLs, and turning Places types into a food-type label.

function isGoogleMapsHost(host) {
  host = host.toLowerCase();
  if (host === 'maps.google.com') return true;
  // google.com, www.google.com, google.co.uk, www.google.com.tw, ...
  return /^(www\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host);
}

// Returns 'short' | 'long' | null for a URL string.
function classifyUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  if (host === 'maps.app.goo.gl') return 'short';
  if (host === 'goo.gl' && u.pathname.startsWith('/maps')) return 'short';
  if (isGoogleMapsHost(host) && (host === 'maps.google.com' || u.pathname.startsWith('/maps'))) return 'long';
  return null;
}

// Find every Google Maps link in free text (plain lines, markdown links,
// bullet lists). Keeps order, drops duplicates and non-Maps links.
function extractMapsLinks(text) {
  const found = [];
  const seen = new Set();
  const re = /https?:\/\/[^\s<>()\[\]"'`]+/gi;
  for (const m of String(text || '').matchAll(re)) {
    const url = m[0].replace(/[.,;:!?*_]+$/, '');
    if (!classifyUrl(url) || seen.has(url)) continue;
    seen.add(url);
    found.push(url);
  }
  return found;
}

function decodePlus(s) {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')).trim(); } catch { return s.replace(/\+/g, ' ').trim(); }
}

function validLatLng(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

// Read name, pin location and Google feature id from a long Maps URL.
// The !3d/!4d pair is the place pin; the @lat,lng pair is only the camera,
// so it is the fallback.
function parseMapsUrl(raw) {
  const u = new URL(raw);
  const out = { name: null, lat: null, lng: null, featureId: null, cid: null };

  const placeMatch = u.pathname.match(/\/maps\/place\/([^/]+)/);
  if (placeMatch) out.name = decodePlus(placeMatch[1]);
  if (!out.name) {
    const q = u.searchParams.get('q') || u.searchParams.get('query');
    if (q && !/^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(q.trim())) out.name = q.trim();
  }

  const full = decodeURIComponent(u.pathname) + u.search;
  const pin = full.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  const cam = full.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  const pair = s => (s || '').trim().match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
  for (const m of [pin, pair(u.searchParams.get('q')), pair(u.searchParams.get('ll')), cam]) {
    if (!m) continue;
    const lat = Number(m[1]), lng = Number(m[2]);
    if (validLatLng(lat, lng)) { out.lat = lat; out.lng = lng; break; }
  }

  const ftid = full.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i) || [null, u.searchParams.get('ftid')];
  if (ftid[1] && /^0x[0-9a-f]+:0x[0-9a-f]+$/i.test(ftid[1])) {
    out.featureId = ftid[1].toLowerCase();
    out.cid = BigInt(out.featureId.split(':')[1]).toString(10);
  } else if (u.searchParams.get('cid')) {
    out.cid = u.searchParams.get('cid');
  }
  return out;
}

const CUISINE_WORDS = [
  'Japanese', 'Chinese', 'Korean', 'Thai', 'Vietnamese', 'Indian', 'Italian', 'Mexican',
  'French', 'Greek', 'Mediterranean', 'Middle Eastern', 'Lebanese', 'Turkish', 'Spanish',
  'American', 'Brazilian', 'Indonesian', 'Filipino', 'Hawaiian', 'Taiwanese', 'Afghani',
  'African', 'Ethiopian', 'Peruvian', 'Cuban', 'Caribbean', 'German', 'Nepali', 'Pakistani',
];
// Words in a place name or type that imply a cuisine.
const KEYWORD_CUISINE = {
  sushi: 'Japanese', ramen: 'Japanese', izakaya: 'Japanese', teriyaki: 'Japanese', udon: 'Japanese',
  szechuan: 'Chinese', sichuan: 'Chinese', dim_sum: 'Chinese', 'dim sum': 'Chinese', cantonese: 'Chinese', hunan: 'Chinese',
  pho: 'Vietnamese', banh: 'Vietnamese', taqueria: 'Mexican', taco: 'Mexican', burrito: 'Mexican',
  pizza: 'Pizza', pizzeria: 'Pizza', burger: 'Burgers', hamburger: 'Burgers', bbq: 'Barbecue', barbecue: 'Barbecue',
  boba: 'Drinks', tea: 'Drinks', coffee: 'Cafe', cafe: 'Cafe', bakery: 'Bakery', seafood: 'Seafood',
  steak: 'Steakhouse', steak_house: 'Steakhouse', sandwich: 'Sandwiches', deli: 'Sandwiches',
  vegan: 'Vegetarian', vegetarian: 'Vegetarian', breakfast: 'Breakfast', brunch: 'Breakfast',
  curry: 'Indian', tandoori: 'Indian', kebab: 'Middle Eastern', falafel: 'Middle Eastern', gyro: 'Greek',
  dessert: 'Dessert', ice_cream: 'Dessert', donut: 'Dessert', fast_food: 'Fast food', korean_bbq: 'Korean',
};

function titleCase(s) {
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Turn Places API types (e.g. "chinese_restaurant") and the name into one
// food-type label. Returns 'Other' when nothing matches.
function deriveCuisine(types, name) {
  const list = [].concat(types || []).filter(Boolean).map(t => String(t).toLowerCase());
  for (const t of list) {
    const base = t.replace(/_(restaurant|shop|house)$/, '');
    if (KEYWORD_CUISINE[t]) return KEYWORD_CUISINE[t];
    if (KEYWORD_CUISINE[base]) return KEYWORD_CUISINE[base];
    const word = CUISINE_WORDS.find(w => w.toLowerCase().replace(' ', '_') === base);
    if (word) return word;
  }
  const lowerName = String(name || '').toLowerCase();
  for (const w of CUISINE_WORDS) if (new RegExp(`\\b${w.toLowerCase()}\\b`).test(lowerName)) return w;
  for (const [k, v] of Object.entries(KEYWORD_CUISINE)) {
    if (new RegExp(`\\b${k.replace('_', ' ')}\\b`).test(lowerName)) return v;
  }
  // A specific "<x>_restaurant" type we don't know yet still beats "Other".
  const generic = new Set(['restaurant', 'food', 'point_of_interest', 'establishment', 'meal_takeaway', 'meal_delivery', 'store']);
  const specific = list.find(t => /_restaurant$/.test(t) && !generic.has(t));
  if (specific) return titleCase(specific.replace(/_restaurant$/, ''));
  return 'Other';
}

function haversineMeters(a, b) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

module.exports = { classifyUrl, extractMapsLinks, parseMapsUrl, deriveCuisine, haversineMeters };
