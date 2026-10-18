'use strict';
// Manage > Settings: only the office and map ID can change, values are checked
// on the server, the file is private and never fatal, and the login is required.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const auth = require('../lib/auth');

const PASSWORD = 'settings password 1';

// A fresh server whose data folder may already hold a settings.json.
async function start({ settingsText, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodmap-'));
  const settingsFile = path.join(dir, 'settings.json');
  if (settingsText != null) fs.writeFileSync(settingsFile, settingsText);
  const saved = { ...process.env };
  for (const k of ['GOOGLE_MAPS_API_KEY', 'GOOGLE_MAPS_BROWSER_KEY', 'GOOGLE_PLACES_SERVER_KEY', 'GOOGLE_MAPS_MAP_ID', 'OFFICE_LAT', 'OFFICE_LNG', 'OFFICE_NAME', 'TRUST_PROXY']) delete process.env[k];
  Object.assign(process.env, { DATA_FILE: path.join(dir, 'r.json'), ADMIN_PASSWORD_HASH: await auth.hashPassword(PASSWORD), ...env });
  delete require.cache[require.resolve('../server')];
  const { createServer, loadStore } = require('../server');
  process.env = saved;
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try { loadStore(); } finally { console.error = origError; }
  const srv = createServer().listen(0);
  await new Promise(r => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  let cookie = '';
  const j = async (p, o = {}) => {
    const r = await fetch(base + p, { ...o, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...o.headers } });
    return [r.status, await r.json()];
  };
  const login = async () => {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    assert.strictEqual(r.status, 200);
    cookie = r.headers.get('set-cookie').split(';')[0];
  };
  const put = body => j('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
  return { srv, base, dir, settingsFile, j, put, login, errors };
}

const quiet = async fn => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

test('settings need a login; office and map ID override .env and go back to it', () => quiet(async () => {
  const s = await start({ env: { OFFICE_LAT: '45.5', OFFICE_LNG: '-122.6', OFFICE_NAME: 'Env office', GOOGLE_MAPS_MAP_ID: 'envmap' } });
  try {
    assert.strictEqual((await s.j('/api/settings'))[0], 401);
    assert.strictEqual((await s.put({ mapId: '' }))[0], 401);
    await s.login();

    let [st, v] = await s.j('/api/settings');
    assert.strictEqual(st, 200);
    assert.deepStrictEqual(v.office.value, { name: 'Env office', lat: 45.5, lng: -122.6, placeholder: false });
    assert.strictEqual(v.office.overridden, false);
    assert.strictEqual(v.mapId.default.value, 'envmap');
    assert.ok(v.serverOnly.some(x => x.key === 'ADMIN_PASSWORD_HASH'));
    assert.ok(!JSON.stringify(v).includes('argon2') && !JSON.stringify(v).includes('scrypt$'), 'never sends the password hash');

    [st, v] = await s.put({ office: { name: '  New\noffice\u0007 ', lat: 45.6, lng: -122.51 }, mapId: '' });
    assert.strictEqual(st, 200);
    assert.deepStrictEqual(v.office.value, { name: 'Newoffice', lat: 45.6, lng: -122.51, placeholder: false });
    assert.strictEqual(v.mapId.value, '', 'built-in style overrides the .env map ID');
    let [, cfg] = await s.j('/api/config');
    assert.strictEqual(cfg.mapId, '');
    assert.strictEqual(cfg.office.name, 'Newoffice');

    const onDisk = JSON.parse(fs.readFileSync(s.settingsFile, 'utf8'));
    assert.deepStrictEqual(onDisk, { office: { name: 'Newoffice', lat: 45.6, lng: -122.51 }, mapId: '' });
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(s.settingsFile).mode & 0o777, 0o600);

    // A missing key leaves that setting alone; null goes back to .env.
    [, v] = await s.put({ mapId: 'abc_DEF-1' });
    assert.strictEqual(v.office.value.name, 'Newoffice');
    assert.strictEqual(v.mapId.value, 'abc_DEF-1');
    [, v] = await s.put({ office: null, mapId: null });
    assert.strictEqual(v.office.overridden, false);
    [, cfg] = await s.j('/api/config');
    assert.strictEqual(cfg.office.name, 'Env office');
    assert.strictEqual(cfg.mapId, 'envmap');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(s.settingsFile, 'utf8')), {});
  } finally { s.srv.close(); auth.clearFailures('127.0.0.1'); fs.rmSync(s.dir, { recursive: true, force: true }); }
}));

test('bad values are refused with a message and change nothing', () => quiet(async () => {
  const s = await start();
  try {
    await s.login();
    const bad = [
      { office: { name: 'X', lat: 91, lng: 0 } },
      { office: { name: 'X', lat: '45', lng: 0 } },
      { office: { name: 'X', lat: 0, lng: -180.5 } },
      { office: { name: ' \n ', lat: 0, lng: 0 } },
      { office: { name: 'x'.repeat(81), lat: 0, lng: 0 } },
      { office: 'here' },
      { mapId: 'has space' },
      { mapId: 'x'.repeat(65) },
      { mapId: 5 },
      { password: 'nope' },
      { HOST: '0.0.0.0' },
    ];
    for (const body of bad) {
      const [st, v] = await s.put(body);
      assert.strictEqual(st, 400, JSON.stringify(body));
      assert.ok(v.error, 'has a message');
    }
    assert.ok(!fs.existsSync(s.settingsFile), 'nothing written');
    const [, cfg] = await s.j('/api/config');
    assert.strictEqual(cfg.office.placeholder, true);
  } finally { s.srv.close(); auth.clearFailures('127.0.0.1'); fs.rmSync(s.dir, { recursive: true, force: true }); }
}));

test('a damaged settings file is reported, ignored, and kept as .bad on the next save', () => quiet(async () => {
  for (const text of ['{not json', '[]', '{"office":{"name":"X","lat":999,"lng":0}}', '{"HOST":"0.0.0.0"}']) {
    const s = await start({ settingsText: text, env: { GOOGLE_MAPS_MAP_ID: 'envmap' } });
    try {
      assert.ok(s.errors.some(e => e.includes('damaged')), `logged: ${text}`);
      const health = await fetch(s.base + '/healthz');
      assert.strictEqual(health.status, 200, 'not an outage');
      assert.strictEqual((await health.json()).settings, 'damaged');
      const [, cfg] = await s.j('/api/config');
      assert.strictEqual(cfg.mapId, 'envmap', 'runs on the .env values');
      await s.login();
      let [, v] = await s.j('/api/settings');
      assert.match(v.error, /damaged/);
      [, v] = await s.put({ mapId: '' });
      assert.strictEqual(v.error, null);
      const bad = fs.readdirSync(s.dir).filter(f => f.startsWith('settings.json.bad-'));
      assert.strictEqual(bad.length, 1);
      assert.strictEqual(fs.readFileSync(path.join(s.dir, bad[0]), 'utf8'), text);
      assert.strictEqual((await (await fetch(s.base + '/healthz')).json()).settings, undefined);
    } finally { s.srv.close(); auth.clearFailures('127.0.0.1'); fs.rmSync(s.dir, { recursive: true, force: true }); }
  }
}));

test('a valid file is loaded at start; a failed save keeps the old values', () => quiet(async () => {
  const s = await start({ settingsText: JSON.stringify({ office: { name: 'Saved', lat: 10, lng: 20 } }) });
  try {
    let [, cfg] = await s.j('/api/config');
    assert.deepStrictEqual(cfg.office, { name: 'Saved', lat: 10, lng: 20, placeholder: false });
    await s.login();
    // Make the rename fail: the target becomes a non-empty folder.
    fs.rmSync(s.settingsFile);
    fs.mkdirSync(s.settingsFile);
    fs.writeFileSync(path.join(s.settingsFile, 'x'), '');
    const errors = [];
    const origError = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    let st, v;
    try { [st, v] = await s.put({ office: { name: 'Other', lat: 1, lng: 2 } }); } finally { console.error = origError; }
    assert.strictEqual(st, 500);
    assert.match(v.error, /Couldn't save the settings/);
    [, cfg] = await s.j('/api/config');
    assert.strictEqual(cfg.office.name, 'Saved');
    assert.deepStrictEqual(fs.readdirSync(s.dir).filter(f => f.endsWith('.tmp')), [], 'no temp file left');
  } finally { s.srv.close(); auth.clearFailures('127.0.0.1'); fs.rmSync(s.dir, { recursive: true, force: true }); }
}));

test('changes a browser marks as cross-site are refused', () => quiet(async () => {
  const s = await start();
  try {
    await s.login();
    let [st] = await s.j('/api/settings', { method: 'PUT', body: JSON.stringify({ mapId: '' }), headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.strictEqual(st, 403);
    [st] = await s.j('/api/settings', { method: 'PUT', body: JSON.stringify({ mapId: '' }), headers: { 'Sec-Fetch-Site': 'same-site' } });
    assert.strictEqual(st, 403);
    [st] = await s.j('/api/settings', { method: 'PUT', body: JSON.stringify({ mapId: '' }), headers: { 'Sec-Fetch-Site': 'same-origin' } });
    assert.strictEqual(st, 200);
    assert.ok(!fs.readdirSync(s.dir).some(f => f.includes('.bad')));
    // No header (curl, older browsers) is allowed; the check covers every change route.
    [st] = await s.j('/api/settings', { method: 'PUT', body: JSON.stringify({ mapId: '' }) });
    assert.strictEqual(st, 200);
    const r = await fetch(s.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, body: JSON.stringify({ password: PASSWORD }) });
    assert.strictEqual(r.status, 403);
    [st] = await s.j('/api/restaurants/x', { method: 'PATCH', body: '{}', headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.strictEqual(st, 403);
  } finally { s.srv.close(); auth.clearFailures('127.0.0.1'); fs.rmSync(s.dir, { recursive: true, force: true }); }
}));

test('server defaults say where they come from; office fields are strict', () => quiet(async () => {
  const s = await start({ env: { OFFICE_LAT: 'abc', OFFICE_LNG: '-122', GOOGLE_MAPS_MAP_ID: 'envmap' } });
  try {
    await s.login();
    let [, v] = await s.j('/api/settings');
    assert.strictEqual(v.office.default.source, 'invalid');
    assert.strictEqual(v.office.default.placeholder, true);
    assert.strictEqual(v.mapId.default.source, 'environment');
    assert.strictEqual(v.serverOnly.find(x => x.key === 'TRUST_PROXY').source, 'not set');
    let [st] = await s.put({ office: { name: 'X', lat: 1, lng: 2, extra: 1 } });
    assert.strictEqual(st, 400, 'unknown office field');
    [st, v] = await s.put({ office: { name: 'A\u202eB\u2066C\u2028', lat: 1, lng: 2 } });
    assert.strictEqual(st, 200);
    assert.strictEqual(v.office.value.name, 'ABC', 'text-direction characters removed');
  } finally { s.srv.close(); auth.clearFailures('127.0.0.1'); fs.rmSync(s.dir, { recursive: true, force: true }); }
}));

test('saves queue up, fix the file mode, and a BOM in a hand-edited file is fine', () => quiet(async () => {
  const s = await start({ settingsText: '\uFEFF' + JSON.stringify({ mapId: 'fromfile' }) });
  try {
    let [, cfg] = await s.j('/api/config');
    assert.strictEqual(cfg.mapId, 'fromfile');
    fs.chmodSync(s.settingsFile, 0o644);
    await s.login();
    const results = await Promise.all([
      s.put({ office: { name: 'One', lat: 1, lng: 1 } }),
      s.put({ mapId: 'two' }),
      s.put({ office: { name: 'Three', lat: 3, lng: 3 } }),
    ]);
    assert.deepStrictEqual(results.map(r => r[0]), [200, 200, 200]);
    const onDisk = JSON.parse(fs.readFileSync(s.settingsFile, 'utf8'));
    assert.deepStrictEqual(onDisk, { mapId: 'two', office: { name: 'Three', lat: 3, lng: 3 } }, 'no save lost another');
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(s.settingsFile).mode & 0o777, 0o600);
  } finally { s.srv.close(); auth.clearFailures('127.0.0.1'); fs.rmSync(s.dir, { recursive: true, force: true }); }
}));

test('a failed save after setting a damaged file aside runs on .env, not "damaged"', () => quiet(async () => {
  const s = await start({ settingsText: '{broken', env: { GOOGLE_MAPS_MAP_ID: 'envmap' } });
  try {
    await s.login();
    // The temp file's path is taken by a folder, so the write fails.
    fs.mkdirSync(`${s.settingsFile}.${process.pid}.tmp`);
    fs.writeFileSync(path.join(`${s.settingsFile}.${process.pid}.tmp`, 'x'), '');
    const origError = console.error; console.error = () => {};
    let st;
    try { [st] = await s.put({ mapId: '' }); } finally { console.error = origError; }
    assert.strictEqual(st, 500);
    assert.ok(fs.readdirSync(s.dir).some(f => f.startsWith('settings.json.bad-')), 'damaged file kept');
    assert.strictEqual((await (await fetch(s.base + '/healthz')).json()).settings, undefined);
    const [, v] = await s.j('/api/settings');
    assert.strictEqual(v.error, null);
    assert.strictEqual(v.mapId.value, 'envmap');
  } finally { s.srv.close(); auth.clearFailures('127.0.0.1'); fs.rmSync(s.dir, { recursive: true, force: true }); }
}));

test('an unreadable settings file is reported, not fatal', { skip: process.getuid?.() === 0 ? 'root can read any file' : process.platform === 'win32' }, () => quiet(async () => {
  const s = await start({ settingsText: '{}' });
  try {
    fs.chmodSync(s.settingsFile, 0);
    const origError = console.error; const errs = []; console.error = (...a) => errs.push(a.join(' '));
    try { require('../server').loadStore(); } finally { console.error = origError; }
    assert.ok(errs.some(e => e.includes("Couldn't read")));
  } finally { s.srv.close(); auth.clearFailures('127.0.0.1'); fs.rmSync(s.dir, { recursive: true, force: true }); }
}));
