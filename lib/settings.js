'use strict';
// Settings changed in the Manage window, kept in settings.json next to the
// restaurant list. Only harmless, already-public values live here (the office
// and the map ID); keys, the password and network settings stay in .env.
//
// A key that is missing means "use the .env value". mapId "" means "no map ID"
// (the built-in style), even when .env sets one.
//
// A file that can't be read or holds bad values is reported (error) and
// ignored, never fatal: the server keeps running on the .env values. The next
// save first keeps it as settings.json.bad-<date and time>.

const fs = require('fs');

const MAP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME = 80;

const badRequest = msg => Object.assign(new Error(msg), { status: 400 });

// Returns a clean office, or throws a 400 with a message for the user.
function checkOffice(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw badRequest('Office must have a name, latitude and longitude.');
  for (const k of Object.keys(o)) if (!['name', 'lat', 'lng'].includes(k)) throw badRequest(`Unknown office field "${k}".`);
  // Control and text-direction characters are removed (they could make the
  // "Sorted by distance from ..." line look odd); the name is escaped where shown.
  const name = typeof o.name === 'string' ? o.name.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').trim() : '';
  if (!name) throw badRequest('Enter a name for the office.');
  if (name.length > MAX_NAME) throw badRequest(`The office name can be at most ${MAX_NAME} characters.`);
  const lat = Number(o.lat), lng = Number(o.lng);
  if (typeof o.lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90) throw badRequest('Latitude must be a number from -90 to 90.');
  if (typeof o.lng !== 'number' || !Number.isFinite(lng) || Math.abs(lng) > 180) throw badRequest('Longitude must be a number from -180 to 180.');
  return { name, lat, lng };
}

function checkMapId(v) {
  if (typeof v !== 'string' || (v !== '' && !MAP_ID_RE.test(v))) throw badRequest('A map ID has only letters, digits, - and _ (at most 64), or is empty for the built-in style.');
  return v;
}

// The whole file, checked as strictly as a save. Unknown keys are an error too.
function checkFile(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('should hold a JSON object');
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === 'office') out.office = checkOffice(v);
    else if (k === 'mapId') out.mapId = checkMapId(v);
    else throw new Error(`unknown setting "${k}"`);
  }
  return out;
}

function createSettings(file) {
  let values = {};
  let error = null; // why the file was ignored, or null
  let chain = Promise.resolve();

  function load() {
    values = {}; error = null;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      if (e.code === 'ENOENT') return;
      error = `Couldn't read ${file} (${e.code || e.message}).`;
    }
    if (!error) {
      try { values = checkFile(JSON.parse(text.replace(/^\uFEFF/, ''))); }
      catch (e) { error = `${file} is damaged (${e.message}).`; values = {}; }
    }
    if (error) console.error(`  ! ${error} Using the .env values; saving in Settings replaces it (the old file is kept as settings.json.bad-<date>).`);
  }

  async function write(next) {
    if (error) {
      // Keep the damaged file to look at, if it's there (it may be unreadable
      // but present). Each one gets its own name, so an older one isn't lost.
      const bad = `${file}.bad-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try { await fs.promises.rename(file, bad); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      // It's out of the way now: even if the write below fails, the server
      // runs on the .env values, and nothing is damaged any more.
      error = null;
    }
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flush: true });
      await fs.promises.chmod(tmp, 0o600); // mode above only applies to a new file
      await fs.promises.rename(tmp, file);
    } catch (e) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }

  return {
    get values() { return values; },
    get error() { return error; },
    load,
    // change: { office?: object|null, mapId?: string|null }; null removes the
    // override (back to .env), a missing key leaves it as it is.
    // Checks first (400), then saves; the new values apply only once on disk.
    // Resolves to the names of the settings that changed.
    update(change) {
      if (!change || typeof change !== 'object' || Array.isArray(change)) throw badRequest('Send a JSON object');
      for (const k of Object.keys(change)) if (k !== 'office' && k !== 'mapId') throw badRequest(`Unknown setting "${k}".`);
      const p = chain.then(async () => {
        const next = { ...values };
        if ('office' in change) { if (change.office === null) delete next.office; else next.office = checkOffice(change.office); }
        if ('mapId' in change) { if (change.mapId === null) delete next.mapId; else next.mapId = checkMapId(change.mapId); }
        try { await write(next); }
        catch (e) {
          console.error(`Saving ${file} failed: ${e.message}`);
          throw Object.assign(new Error("Couldn't save the settings. Check the server log (kevins-food-map logs)."), { status: 500 });
        }
        const changed = ['office', 'mapId'].filter(k => JSON.stringify(values[k]) !== JSON.stringify(next[k]));
        values = next;
        return changed;
      });
      chain = p.catch(() => {});
      return p;
    },
    flush: () => chain,
  };
}

module.exports = { createSettings, checkOffice, checkMapId };
