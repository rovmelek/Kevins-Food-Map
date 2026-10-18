'use strict';
// NASC Food: a tiny zero-dependency server. Serves the page, resolves Google
// Maps links, and keeps the shared restaurant list in data/restaurants.json.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { findLinks } = require('./lib/parse');
const { resolveLink } = require('./lib/resolve');
const { createStore } = require('./lib/store');
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
const MAX_BODY = 200000;
const PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
// Behind a reverse proxy (Caddy, nginx) set TRUST_PROXY=1 so the login
// lockout counts the visitor's address, not the proxy's.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const COOKIE = 'nasc_session';
// Password checks are deliberately slow and memory-hungry; only this many run
// at once, so a flood of logins can't stall or exhaust the server.
const MAX_CONCURRENT_LOGINS = 2;

const officeLat = parseFloat(process.env.OFFICE_LAT), officeLng = parseFloat(process.env.OFFICE_LNG);
const officeSet = Math.abs(officeLat) <= 90 && Math.abs(officeLng) <= 180;
const OFFICE = officeSet
  ? { name: process.env.OFFICE_NAME || 'NASC office', lat: officeLat, lng: officeLng, placeholder: false }
  // Default when .env has no office: center of ZIP 98683, Vancouver WA (zippopotam.us).
  : { name: 'NASC area (ZIP 98683)', lat: 45.6032, lng: -122.5133, placeholder: true };

// KEY=value lines; `export KEY=...`, quotes and trailing # comments allowed.
// Variables already set in the environment win.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] in process.env) continue;
    const quoted = m[2].match(/^(['"])(.*?)\1(\s+#.*)?$/);
    process.env[m[1]] = quoted ? quoted[2] : m[2].replace(/(^|\s+)#.*$/, '');
  }
}

// ---- restaurants -------------------------------------------------------------

const store = createStore(DATA_FILE);

function findDuplicate(rec) {
  return store.items.find(r =>
    (rec.placeId && r.placeId === rec.placeId) ||
    (rec.cid && r.cid === rec.cid) ||
    (r.name.toLowerCase() === rec.name.toLowerCase() &&
      Math.abs(r.lat - rec.lat) < 0.0005 && Math.abs(r.lng - rec.lng) < 0.0005));
}

// Archived restaurants stay in the file (with archivedAt) so they can be
// restored; only the Manage window sees them.
const active = () => store.items.filter(r => !r.archivedAt);
const archived = () => store.items.filter(r => r.archivedAt);

async function addFromLink(url) {
  const existingBySource = store.items.find(r => r.sourceUrl === url);
  if (existingBySource) return restoreIfArchived(url, existingBySource);
  try {
    const rec = await resolveLink(url, { apiKey: SERVER_KEY });
    const dup = findDuplicate(rec);
    if (dup) return restoreIfArchived(url, dup);
    const { warning, ...stored } = rec;
    const restaurant = { id: crypto.randomUUID(), ...stored, cuisineManual: false, addedAt: new Date().toISOString() };
    store.items.push(restaurant);
    try { await store.save(); }
    catch (e) { store.items = store.items.filter(r => r !== restaurant); throw e; }
    return { url, status: 'added', restaurant, warning };
  } catch (e) {
    return { url, status: 'error', error: e.message };
  }
}

// Adding something that was archived brings it back instead of duplicating it.
async function restoreIfArchived(url, r) {
  if (!r.archivedAt) return { url, status: 'duplicate', restaurant: r };
  const was = r.archivedAt;
  delete r.archivedAt;
  try { await store.save(); }
  catch (e) { r.archivedAt = was; return { url, status: 'error', error: e.message }; }
  return { url, status: 'restored', restaurant: r };
}

const badRequest = msg => Object.assign(new Error(msg), { status: 400 });

function readIds(body) {
  if (!Array.isArray(body.ids) || !body.ids.every(id => typeof id === 'string')) throw badRequest('ids must be a list of restaurant ids');
  return new Set(body.ids);
}

// ---- http helpers ------------------------------------------------------------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

// Content Security Policy for the page, following Google's "strict CSP" for
// the Maps JavaScript API: only scripts carrying this response's nonce (and
// what they load) may run.
function pageCsp(nonce) {
  return [
    `script-src 'nonce-${nonce}' 'strict-dynamic' https: 'unsafe-eval' blob:`,
    "img-src 'self' https://*.googleapis.com https://*.gstatic.com *.google.com *.googleusercontent.com data:",
    'frame-src *.google.com',
    "connect-src 'self' https://*.googleapis.com *.google.com https://*.gstatic.com data: blob:",
    'font-src https://fonts.gstatic.com',
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'worker-src blob:',
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// Reads a JSON object body. Anything else (a list, null, bad JSON, too big)
// is a 400/413, never a crash.
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0, tooBig = false; const chunks = [];
    req.on('data', c => {
      if (tooBig) return;
      size += c.length;
      if (size > MAX_BODY) { tooBig = true; reject(Object.assign(new Error('Request too large'), { status: 413, close: true })); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      let body;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
      catch { return reject(badRequest('Invalid JSON')); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(badRequest('Send a JSON object'));
      resolve(body);
    });
    req.on('error', reject);
  });
}

// The visitor's address. Behind a trusted proxy, the last X-Forwarded-For
// entry is the one the proxy itself added; earlier ones come from the client
// and can be forged.
function clientIp(req) {
  const xff = TRUST_PROXY && req.headers['x-forwarded-for'];
  if (xff) return xff.split(',').pop().trim();
  return req.socket.remoteAddress;
}

function sessionCookie(req, token, maxAgeSec) {
  // Secure when the browser reached us over HTTPS (directly or via the proxy).
  const https = req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
  return `${COOKIE}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${https ? '; Secure' : ''}`;
}

function isLoggedIn(req) {
  return auth.isValidSession(auth.parseCookies(req.headers.cookie)[COOKIE]);
}

// ---- API handlers ------------------------------------------------------------

let loginsRunning = 0;

async function login(req, res) {
  if (!PASSWORD_HASH) return send(res, 503, { error: 'No admin password is set. On the server run: nasc-food set-password (or npm run set-password), then restart.' });
  const ip = clientIp(req);
  const wait = auth.lockedFor(ip);
  if (wait) return send(res, 429, { error: `Too many wrong passwords. Try again in ${Math.ceil(wait / 60000)} min.` }, undefined, { 'Retry-After': String(Math.ceil(wait / 1000)) });
  const { password } = await readJson(req);
  if (typeof password !== 'string' || !password) throw badRequest('Enter the password.');
  // Check again now the body is in: a client could open many requests
  // before the lockout and send their bodies later.
  const waitNow = auth.lockedFor(ip);
  if (waitNow) return send(res, 429, { error: `Too many wrong passwords. Try again in ${Math.ceil(waitNow / 60000)} min.` }, undefined, { 'Retry-After': String(Math.ceil(waitNow / 1000)) });
  if (loginsRunning >= MAX_CONCURRENT_LOGINS) return send(res, 429, { error: 'Busy, try again in a moment.' }, undefined, { 'Retry-After': '2' });
  // Count the attempt before the slow check, so parallel guesses can't all
  // slip in before the lockout; a correct password clears it.
  auth.recordFailure(ip);
  loginsRunning++;
  let ok;
  try { ok = await auth.verifyPassword(password, PASSWORD_HASH); }
  finally { loginsRunning--; }
  if (!ok) return send(res, 401, { error: 'Wrong password.' });
  auth.clearFailures(ip);
  const token = auth.createSession();
  return send(res, 200, { loggedIn: true }, undefined, { 'Set-Cookie': sessionCookie(req, token, auth.SESSION_MS / 1000) });
}

function logout(req, res) {
  auth.endSession(auth.parseCookies(req.headers.cookie)[COOKIE]);
  return send(res, 200, { loggedIn: false }, undefined, { 'Set-Cookie': sessionCookie(req, '', 0) });
}

async function addRestaurants(req, res) {
  const body = await readJson(req);
  const { maps: links, other } = findLinks(typeof (body.text ?? body.url) === 'string' ? body.text ?? body.url : '');
  if (!links.length) {
    throw badRequest(other.length
      ? "That isn't a Google Maps link. In Google Maps, open the restaurant, tap Share and copy the link (https://maps.app.goo.gl/...)."
      : 'No Google Maps links found. Links look like https://maps.app.goo.gl/...');
  }
  if (links.length > MAX_BULK) throw badRequest(`Too many links at once (max ${MAX_BULK}).`);
  const results = [];
  for (const link of links) results.push(await addFromLink(link)); // sequential: gentle on Google
  for (const link of other) results.push({ url: link, status: 'skipped', error: 'Not a Google Maps link' });
  return send(res, 200, { results });
}

// Archive, restore, or permanently delete several at once: { ids: [...] }.
// Purge only removes restaurants that are already archived.
async function bulkChange(req, res, { action }) {
  const ids = readIds(await readJson(req));
  // Remember exactly what this request changed, so a failed save undoes only
  // that, not changes other requests made meanwhile.
  const undo = new Map(); // new object -> old object
  let removed = [];
  if (action === 'purge') {
    removed = store.items.filter(r => ids.has(r.id) && r.archivedAt);
    store.items = store.items.filter(r => !removed.includes(r));
  } else {
    const now = new Date().toISOString();
    store.items = store.items.map(r => {
      if (!ids.has(r.id) || !!r.archivedAt === (action === 'archive')) return r;
      let next;
      if (action === 'archive') next = { ...r, archivedAt: now };
      else { const { archivedAt, ...rest } = r; next = rest; }
      undo.set(next, r);
      return next;
    });
  }
  const changed = removed.length + undo.size;
  if (changed) {
    try { await store.save(); } catch (e) {
      store.items = [...store.items.map(x => undo.get(x) ?? x), ...removed];
      throw e;
    }
  }
  return send(res, 200, { changed });
}

function findRestaurant(id) {
  const r = store.items.find(x => x.id === id);
  if (!r) throw Object.assign(new Error('Restaurant not found'), { status: 404 });
  return r;
}

// Replace one restaurant with an updated copy, undoing it if saving fails.
async function replaceRestaurant(r, next) {
  store.items = store.items.map(x => (x === r ? next : x));
  try { await store.save(); }
  catch (e) { store.items = store.items.map(x => (x === next ? r : x)); throw e; }
  return next;
}

// Look the place up again, e.g. after a Places key was added, or for a fresh
// rating. Choices made by hand (food type, phone, address) are kept.
async function refreshRestaurant(req, res, { id }) {
  const { warning, ...data } = await resolveLink(findRestaurant(id).sourceUrl, { apiKey: SERVER_KEY });
  const r = findRestaurant(id); // again: it may have changed during the lookup
  if (r.cuisineManual) delete data.cuisine;
  if (r.phoneManual) delete data.phone;
  if (r.addressManual) delete data.address;
  return send(res, 200, { restaurant: await replaceRestaurant(r, { ...r, ...data }), warning });
}

async function editRestaurant(req, res, { id }) {
  const body = await readJson(req);
  const r = findRestaurant(id);
  const next = { ...r };
  if (typeof body.cuisine === 'string' && body.cuisine.trim()) Object.assign(next, { cuisine: body.cuisine.trim().slice(0, 40), cuisineManual: true });
  if (typeof body.phone === 'string') Object.assign(next, { phone: body.phone.trim().slice(0, 40) || null, phoneManual: true });
  if (typeof body.address === 'string') Object.assign(next, { address: body.address.trim().slice(0, 200) || null, addressManual: true });
  return send(res, 200, await replaceRestaurant(r, next));
}

async function archiveRestaurant(req, res, { id }) { // a real delete is /purge
  const r = findRestaurant(id);
  return send(res, 200, r.archivedAt ? r : await replaceRestaurant(r, { ...r, archivedAt: new Date().toISOString() }));
}

// [method, path pattern, handler, needs login]
const ID = '(?<id>[A-Za-z0-9-]{1,64})';
const ROUTES = [
  ['GET', '/api/config', (req, res) => send(res, 200, { browserKey: BROWSER_KEY, mapId: MAP_ID, office: OFFICE, placesEnabled: !!SERVER_KEY }), false],
  ['GET', '/api/auth/session', (req, res) => send(res, 200, { passwordSet: !!PASSWORD_HASH, loggedIn: isLoggedIn(req) }), false],
  ['POST', '/api/auth/login', login, false],
  ['POST', '/api/auth/logout', logout, false],
  ['GET', '/api/restaurants', (req, res) => send(res, 200, active()), false],
  ['POST', '/api/restaurants', addRestaurants, true],
  ['GET', '/api/restaurants/archived', (req, res) => send(res, 200, archived()), true],
  ['POST', '/api/restaurants/(?<action>archive|restore|purge)', bulkChange, true],
  ['POST', `/api/restaurants/${ID}/refresh`, refreshRestaurant, true],
  ['PATCH', `/api/restaurants/${ID}`, editRestaurant, true],
  ['DELETE', `/api/restaurants/${ID}`, archiveRestaurant, true],
].map(([method, pattern, handler, needsLogin]) => ({ method, re: new RegExp(`^${pattern}$`), handler, needsLogin }));

async function handleApi(req, res, url) {
  const matches = ROUTES.map(r => ({ r, m: url.pathname.match(r.re) })).filter(x => x.m);
  if (!matches.length) return send(res, 404, { error: 'Not found' });
  const hit = matches.find(x => x.r.method === req.method);
  if (!hit) return send(res, 405, { error: 'Method not allowed' }, undefined, { Allow: [...new Set(matches.map(x => x.r.method))].join(', ') });
  // Every change must be JSON. Browsers can't send that cross-site without
  // permission, which (with the SameSite cookie) blocks forged requests.
  if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
    return send(res, 415, { error: 'Send JSON' });
  }
  if (hit.r.needsLogin && !isLoggedIn(req)) return send(res, 401, { error: 'Log in to manage restaurants.' });
  return hit.r.handler(req, res, hit.m.groups || {});
}

// ---- static files ------------------------------------------------------------

function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request', 'text/plain'); }
  if (rel.includes('\0')) return send(res, 400, 'Bad request', 'text/plain');
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    if (path.extname(file) === '.html') {
      const nonce = crypto.randomBytes(16).toString('base64');
      return send(res, 200, buf.toString('utf8').replaceAll('__CSP_NONCE__', nonce), MIME['.html'], { 'Content-Security-Policy': pageCsp(nonce) });
    }
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

// ---- server ------------------------------------------------------------------

async function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, { error: 'Bad request' }); }
  if (url.pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
    return send(res, store.lastError ? 503 : 200, { ok: !store.lastError, restaurants: store.items.length });
  }
  if (url.pathname.startsWith('/api/')) {
    const started = Date.now();
    res.on('finish', () => console.log(`${clientIp(req)} ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`));
    return handleApi(req, res, url);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain', { Allow: 'GET, HEAD' });
  return serveStatic(req, res, url);
}

function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch(e => {
      // Expected errors carry a status and a message meant for the user;
      // anything else is a bug: log it, and don't leak details.
      if (!e.status) console.error(e);
      if (res.headersSent) return res.destroy();
      send(res, e.status || 500, { error: e.status ? e.message : 'Server error' }, undefined, e.close ? { Connection: 'close' } : {});
    });
  });
}

if (require.main === module) {
  store.load();
  const server = createServer();
  // On stop/restart, finish pending saves before exiting.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => {
      server.close();
      store.flush().finally(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
  server.listen(PORT, HOST, () => {
    const shown = HOST === '127.0.0.1' || HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log(`NASC Food running at http://${shown}:${PORT}`);
    if (!BROWSER_KEY) console.warn('  ! No GOOGLE_MAPS_API_KEY: the map will not load (list still works).');
    if (!SERVER_KEY) console.warn('  ! No Places key: added restaurants will have name and pin only, no phone/address.');
    if (BROWSER_KEY && BROWSER_KEY === SERVER_KEY && TRUST_PROXY) console.warn('  ! One key is used for the map and for Places. Visitors can see it, so anyone could run Places lookups on your bill: set daily quotas, or split it into two keys (README, "Google setup").');
    if (PASSWORD_HASH.startsWith('argon2id$') && auth.algorithm !== 'argon2id') console.warn('  ! ADMIN_PASSWORD_HASH uses Argon2id, which needs Node.js 24.7+. Upgrade Node or run set-password again.');
    if (!PASSWORD_HASH) console.warn('  ! No ADMIN_PASSWORD_HASH: Manage is locked. Run: npm run set-password');
    if (OFFICE.placeholder) console.warn('  ! OFFICE_LAT/OFFICE_LNG missing or invalid: using the ZIP 98683 default location.');
  });
}

module.exports = { createServer, loadStore: () => store.load(), loadDotEnv };
