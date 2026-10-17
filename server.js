'use strict';
// NASC Food: a tiny zero-dependency server. Serves the page, resolves Google
// Maps links, and keeps the shared restaurant list in data/restaurants.json.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { findLinks } = require('./lib/parse');
const { resolveLink } = require('./lib/resolve');
const auth = require('./lib/auth');

// Only when started as the app, so tests aren't affected by a local .env.
if (require.main === module) loadDotEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const BROWSER_KEY = process.env.GOOGLE_MAPS_BROWSER_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
const SERVER_KEY = process.env.GOOGLE_PLACES_SERVER_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
const MAP_ID = process.env.GOOGLE_MAPS_MAP_ID || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'restaurants.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BULK = 100;
const PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
// Behind a reverse proxy (Caddy, nginx) set TRUST_PROXY=1 so the login
// lockout counts the visitor's address, not the proxy's.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const COOKIE = 'nasc_session';

const officeLat = parseFloat(process.env.OFFICE_LAT), officeLng = parseFloat(process.env.OFFICE_LNG);
const officeSet = Math.abs(officeLat) <= 90 && Math.abs(officeLng) <= 180;
const OFFICE = officeSet
  ? { name: process.env.OFFICE_NAME || 'NASC office', lat: officeLat, lng: officeLng, placeholder: false }
  // Default when .env has no office: center of ZIP 98683, Vancouver WA (zippopotam.us).
  : { name: 'NASC area (ZIP 98683)', lat: 45.6032, lng: -122.5133, placeholder: true };

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] in process.env) continue;
    const quoted = m[2].match(/^(['"])(.*)\1$/);
    process.env[m[1]] = quoted ? quoted[2] : m[2].replace(/\s+#.*$/, '');
  }
}

// ---- storage ---------------------------------------------------------------

let restaurants = [];
let writeChain = Promise.resolve();

function loadStore() {
  try { restaurants = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; restaurants = []; }
}

// Writes are queued and atomic (temp file + rename) so concurrent adds
// can't interleave or leave a half-written file.
function saveStore() {
  const snapshot = JSON.stringify(restaurants, null, 2);
  writeChain = writeChain.then(async () => {
    await fs.promises.mkdir(path.dirname(DATA_FILE), { recursive: true });
    const tmp = `${DATA_FILE}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, snapshot);
    await fs.promises.rename(tmp, DATA_FILE);
  });
  return writeChain;
}

function findDuplicate(rec) {
  return restaurants.find(r =>
    (rec.placeId && r.placeId === rec.placeId) ||
    (rec.cid && r.cid === rec.cid) ||
    (r.name.toLowerCase() === rec.name.toLowerCase() &&
      Math.abs(r.lat - rec.lat) < 0.0005 && Math.abs(r.lng - rec.lng) < 0.0005));
}

// Archived restaurants stay in the file (with archivedAt) so they can be
// restored; only the Manage window sees them.
const active = () => restaurants.filter(r => !r.archivedAt);
const archived = () => restaurants.filter(r => r.archivedAt);

async function addFromLink(url) {
  const existingBySource = restaurants.find(r => r.sourceUrl === url);
  if (existingBySource) return restoreIfArchived(url, existingBySource);
  try {
    const rec = await resolveLink(url, { apiKey: SERVER_KEY });
    const dup = findDuplicate(rec);
    if (dup) return restoreIfArchived(url, dup);
    const { warning, ...stored } = rec;
    const restaurant = { id: crypto.randomUUID(), ...stored, cuisineManual: false, addedAt: new Date().toISOString() };
    restaurants.push(restaurant);
    await saveStore();
    return { url, status: 'added', restaurant, warning };
  } catch (e) {
    return { url, status: 'error', error: e.message };
  }
}

// Adding something that was archived brings it back instead of duplicating it.
async function restoreIfArchived(url, r) {
  if (!r.archivedAt) return { url, status: 'duplicate', restaurant: r };
  delete r.archivedAt;
  await saveStore();
  return { url, status: 'restored', restaurant: r };
}

function readIds(body) {
  if (!Array.isArray(body.ids) || !body.ids.every(id => typeof id === 'string')) {
    throw Object.assign(new Error('ids must be a list of restaurant ids'), { status: 400 });
  }
  return new Set(body.ids);
}

// ---- http ------------------------------------------------------------------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readJson(req, limit = 200000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return req.headers['x-forwarded-for'].split(',')[0].trim();
  return req.socket.remoteAddress;
}

function sessionCookie(req, token, maxAgeSec) {
  // Secure when the browser reached us over HTTPS (directly or via the proxy).
  const https = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  return `${COOKIE}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${https ? '; Secure' : ''}`;
}

function isLoggedIn(req) {
  return auth.isValidSession(auth.parseCookies(req.headers.cookie)[COOKIE]);
}

async function handleAuth(req, res, action) {
  if (action === 'session' && req.method === 'GET') {
    return send(res, 200, { passwordSet: !!PASSWORD_HASH, loggedIn: isLoggedIn(req) });
  }
  if (action === 'login' && req.method === 'POST') {
    if (!PASSWORD_HASH) return send(res, 503, { error: 'No admin password is set. On the server run: nasc-food set-password (or npm run set-password), then restart.' });
    const ip = clientIp(req);
    const wait = auth.lockedFor(ip);
    if (wait) return send(res, 429, { error: `Too many wrong passwords. Try again in ${Math.ceil(wait / 60000)} min.` }, undefined, { 'Retry-After': String(Math.ceil(wait / 1000)) });
    const { password } = await readJson(req);
    let ok = false;
    try { ok = typeof password === 'string' && !!password && await auth.verifyPassword(password, PASSWORD_HASH); }
    catch (e) { return send(res, 500, { error: e.message }); } // e.g. Argon2id hash on Node < 24
    if (!ok) {
      auth.recordFailure(ip);
      return send(res, 401, { error: 'Wrong password.' });
    }
    auth.clearFailures(ip);
    const token = auth.createSession();
    return send(res, 200, { loggedIn: true }, undefined, { 'Set-Cookie': sessionCookie(req, token, auth.SESSION_MS / 1000) });
  }
  if (action === 'logout' && req.method === 'POST') {
    auth.endSession(auth.parseCookies(req.headers.cookie)[COOKIE]);
    return send(res, 200, { loggedIn: false }, undefined, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }
  return send(res, 404, { error: 'Not found' });
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  // Every change must be JSON. Browsers can't send that cross-site without
  // permission, which (with the SameSite cookie) blocks forged requests.
  if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
    return send(res, 415, { error: 'Send JSON' });
  }
  if (req.method === 'GET' && parts[1] === 'config') {
    return send(res, 200, { browserKey: BROWSER_KEY, mapId: MAP_ID, office: OFFICE, placesEnabled: !!SERVER_KEY });
  }
  if (parts[1] === 'auth') return handleAuth(req, res, parts[2]);
  if (parts[1] !== 'restaurants') return send(res, 404, { error: 'Not found' });

  if (parts.length === 2 && req.method === 'GET') return send(res, 200, active());

  // Everything below changes the list: only for a logged-in admin.
  if (!isLoggedIn(req)) return send(res, 401, { error: 'Log in to manage restaurants.' });

  if (parts.length === 2 && req.method === 'POST') {
    const body = await readJson(req);
    const { maps: links, other } = findLinks(body.text ?? body.url ?? '');
    if (!links.length) {
      return send(res, 400, { error: other.length
        ? "That isn't a Google Maps link. In Google Maps, open the restaurant, tap Share and copy the link (https://maps.app.goo.gl/...)."
        : 'No Google Maps links found. Links look like https://maps.app.goo.gl/...' });
    }
    if (links.length > MAX_BULK) return send(res, 400, { error: `Too many links at once (max ${MAX_BULK}).` });
    const results = [];
    for (const link of links) results.push(await addFromLink(link)); // sequential: gentle on Google
    for (const link of other) results.push({ url: link, status: 'skipped', error: 'Not a Google Maps link' });
    return send(res, 200, { results });
  }

  if (parts.length === 3 && parts[2] === 'archived' && req.method === 'GET') return send(res, 200, archived());

  // Archive, restore, or permanently delete several at once: POST
  // /api/restaurants/{archive|restore|purge} { ids: [...] }. Purge only
  // removes restaurants that are already archived.
  if (parts.length === 3 && ['archive', 'restore', 'purge'].includes(parts[2]) && req.method === 'POST') {
    const ids = readIds(await readJson(req));
    const now = new Date().toISOString();
    let changed = 0;
    if (parts[2] === 'purge') {
      const before = restaurants.length;
      restaurants = restaurants.filter(r => !(ids.has(r.id) && r.archivedAt));
      changed = before - restaurants.length;
    } else {
      for (const r of restaurants) {
        if (!ids.has(r.id) || !!r.archivedAt === (parts[2] === 'archive')) continue;
        if (parts[2] === 'archive') r.archivedAt = now; else delete r.archivedAt;
        changed++;
      }
    }
    if (changed) await saveStore();
    return send(res, 200, { changed });
  }

  const idx = restaurants.findIndex(r => r.id === parts[2]);
  if (idx === -1) return send(res, 404, { error: 'Restaurant not found' });

  // Re-run the lookup, e.g. after a Places key was added or fixed.
  if (parts.length === 4 && parts[3] === 'refresh' && req.method === 'POST') {
    const r = restaurants[idx];
    const fresh = await resolveLink(r.sourceUrl, { apiKey: SERVER_KEY });
    const { warning, ...data } = fresh;
    if (r.cuisineManual) delete data.cuisine;
    Object.assign(r, data);
    await saveStore();
    return send(res, 200, { restaurant: r, warning });
  }
  if (parts.length !== 3) return send(res, 404, { error: 'Not found' });

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    const r = restaurants[idx];
    if (typeof body.cuisine === 'string' && body.cuisine.trim()) {
      r.cuisine = body.cuisine.trim().slice(0, 40);
      r.cuisineManual = true;
    }
    if (typeof body.phone === 'string') r.phone = body.phone.trim().slice(0, 40) || null;
    if (typeof body.address === 'string') r.address = body.address.trim().slice(0, 200) || null;
    await saveStore();
    return send(res, 200, r);
  }
  if (req.method === 'DELETE') { // archives; see /purge for a real delete
    const r = restaurants[idx];
    if (!r.archivedAt) { r.archivedAt = new Date().toISOString(); await saveStore(); }
    return send(res, 200, r);
  }
  return send(res, 405, { error: 'Method not allowed' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
      serveStatic(req, res, url);
    } catch (e) {
      send(res, e.status || 500, { error: e.message || 'Server error' });
    }
  });
}

if (require.main === module) {
  loadStore();
  const server = createServer();
  // On stop/restart, finish pending saves before exiting.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => {
      server.close();
      writeChain.finally(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
  server.listen(PORT, HOST, () => {
    const shown = HOST === '127.0.0.1' || HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log(`NASC Food running at http://${shown}:${PORT}`);
    if (!BROWSER_KEY) console.warn('  ! No GOOGLE_MAPS_API_KEY: the map will not load (list still works).');
    if (!SERVER_KEY) console.warn('  ! No Places key: added restaurants will have name and pin only, no phone/address.');
    if (PASSWORD_HASH.startsWith('argon2id$') && auth.algorithm !== 'argon2id') console.warn('  ! ADMIN_PASSWORD_HASH uses Argon2id, which needs Node.js 24+. Upgrade Node or run set-password again.');
    if (!PASSWORD_HASH) console.warn('  ! No ADMIN_PASSWORD_HASH: Manage is locked. Run: npm run set-password');
    if (OFFICE.placeholder) console.warn('  ! OFFICE_LAT/OFFICE_LNG missing or invalid: using the ZIP 98683 default location.');
  });
}

module.exports = { createServer, loadStore };
