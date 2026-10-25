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

// Find every link in free text (plain lines, markdown links, bullet lists),
// split into Google Maps links and everything else. Keeps order, drops repeats.
function findLinks(text) {
  const maps = [], other = [];
  const seen = new Set();
  // Apostrophes and parentheses can be part of a place name (Denny's), so
  // they're allowed inside a link; a ")" that closes a Markdown link isn't.
  const re = /https?:\/\/[^\s<>\[\]"`]+/gi;
  for (const m of String(text || '').matchAll(re)) {
    // One pass from the end: drop trailing punctuation, and a ")" only while
    // there are more ")" than "(" in the link.
    const raw = m[0];
    let opens = 0, closes = 0;
    for (const ch of raw) { if (ch === '(') opens++; else if (ch === ')') closes++; }
    let end = raw.length;
    while (end > 0) {
      const ch = raw[end - 1];
      if (".,;:!?*_'".includes(ch)) end--;
      else if (ch === ')' && closes > opens) { end--; closes--; }
      else break;
    }
    const url = raw.slice(0, end);
    if (seen.has(url)) continue;
    seen.add(url);
    (classifyUrl(url) ? maps : other).push(url);
  }
  return { maps, other };
}
const extractMapsLinks = text => findLinks(text).maps;

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

  let full;
  try { full = decodeURIComponent(u.pathname) + u.search; } catch { full = u.pathname + u.search; } // e.g. Latin-1 %E9
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

// Places API (New) food-and-drink types that count as somewhere to eat or
// drink. Any "<x>_restaurant" type counts too. "food" alone is not enough:
// Google also gives it to grocery stores.
const FOOD_TYPES = new Set([
  'restaurant', 'cafe', 'coffee_shop', 'cat_cafe', 'dog_cafe', 'tea_house', 'bakery', 'bagel_shop', 'donut_shop',
  'dessert_shop', 'ice_cream_shop', 'juice_shop', 'acai_shop', 'confectionery', 'chocolate_shop', 'candy_store',
  'sandwich_shop', 'deli', 'diner', 'cafeteria', 'food_court', 'steak_house', 'bar', 'bar_and_grill', 'pub',
  'wine_bar', 'brewpub', 'meal_takeaway', 'meal_delivery',
]);
function isFoodPlace(types) {
  return [].concat(types || []).some(t => FOOD_TYPES.has(t) || /_restaurant$/.test(t));
}

function haversineMeters(a, b) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---- country ---------------------------------------------------------------

// The two-letter country code (ISO 3166, e.g. "US", "JP") from the Places
// API's address components.
function countryFromComponents(components) {
  const c = [].concat(components || []).find(x => [].concat(x?.types || []).includes('country'));
  const code = String(c?.shortText || '').toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

// Country names in the languages Google writes addresses in for Kevin's
// places, from the runtime's own country list, plus common short forms.
const COUNTRY_NAMES = (() => {
  const names = new Map();
  const add = (name, code) => { const k = normCountry(name); if (k && !names.has(k)) names.set(k, code); };
  const locales = ['en', 'zh-TW', 'zh-CN', 'ja', 'ko', 'fr', 'de', 'es', 'it', 'pt', 'nl'];
  // Groups and test codes, not countries.
  const skip = new Set(['EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'ZZ']);
  // A retired code is named after today's country (DD is "Germany"); only
  // the current code counts.
  const current = code => { try { return new Intl.Locale(`und-${code}`).region === code; } catch { return false; } };
  for (const loc of locales) {
    let dn;
    try { dn = new Intl.DisplayNames([loc], { type: 'region' }); } catch { continue; }
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      if (skip.has(code) || !current(code)) continue;
      let name;
      try { name = dn.of(code); } catch { continue; }
      if (name && name !== code) add(name, code);
    }
  }
  for (const [name, code] of Object.entries({
    USA: 'US', 'U.S.A.': 'US', 'U.S.': 'US', 'United States of America': 'US', 美國: 'US', 美国: 'US', アメリカ: 'US',
    UK: 'GB', 'Great Britain': 'GB', England: 'GB', Scotland: 'GB', Wales: 'GB',
    臺灣: 'TW', 中華民國: 'TW', 台湾: 'TW', 'Taiwan (ROC)': 'TW', 'Republic of China': 'TW',
    'South Korea': 'KR', 'Republic of Korea': 'KR', 대한민국: 'KR', 韓國: 'KR', 韩国: 'KR', 韓国: 'KR',
    'Hong Kong': 'HK', 'Hong Kong SAR': 'HK', 香港: 'HK', Macau: 'MO', Macao: 'MO', 'Macao SAR': 'MO', 'Macau SAR': 'MO', 澳門: 'MO',
    中國: 'CN', 中国: 'CN', 'Czech Republic': 'CZ', Turkey: 'TR', 'Ivory Coast': 'CI', 'Viet Nam': 'VN', 'Việt Nam': 'VN',
    'Russian Federation': 'RU', Korea: 'KR', 한국: 'KR', ROC: 'TW', 澳门: 'MO',
  })) add(name, code);
  return names;
})();
function normCountry(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").replace(/[\s.()]+/g, ' ').trim();
}

// Google writes Japan and Taiwan first in English ("Japan, 〒104-0061 Tokyo,
// …", "111, Taiwan, Taipei City, …"), and East Asian addresses in their own
// script start with the country ("日本、〒100-0005 東京都…", "100台灣台北市…").
// Only these count at the start, so a place name such as 黑山 (a county in
// China, and Montenegro in Chinese) is never read as a country.
const COUNTRY_FIRST = new Set(['JP', 'TW']);
const LEADING_NAMES = ['日本', '台灣', '臺灣', '台湾', '中華民國', '中國', '中国', '香港', '澳門', '澳门', '대한민국', '한국'];

// For a restaurant without a stored country: the country named in Google's
// formatted address, which ends with it ("…, WA 98683, USA") except for the
// countries above. Null when no country is recognised.
function countryFromAddress(address) {
  const a = String(address || '').normalize('NFKC').trim();
  if (!a) return null;
  const parts = a.split(/[,，、]/).map(x => x.replace(/^[\s〒\d-]+|[\s\d-]+$/g, '')).filter(Boolean);
  const last = COUNTRY_NAMES.get(normCountry(parts[parts.length - 1]));
  if (last) return last;
  const first = COUNTRY_NAMES.get(normCountry(parts[0]));
  if (COUNTRY_FIRST.has(first)) return first;
  // Unseparated: "100台灣台北市…".
  const head = a.replace(/^[\s〒\d-]+/, '');
  const name = LEADING_NAMES.find(n => head.startsWith(n));
  return (name && COUNTRY_NAMES.get(normCountry(name))) || null;
}

module.exports = { classifyUrl, findLinks, extractMapsLinks, isFoodPlace, titleCase, parseMapsUrl, deriveCuisine, haversineMeters, countryFromComponents, countryFromAddress };
