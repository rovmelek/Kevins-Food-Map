'use strict';
// The restaurant list, kept in one JSON file.
//
// Writes are queued and atomic (temp file + rename), and each write saves the
// list as it is at that moment, so a later successful write repairs an earlier
// failed one. A failed write is logged and reported to the caller (which can
// undo its change); it never blocks later writes. Before the first change of each
// day, the file as it was is copied to backups/ (the last 14 are kept).

const fs = require('fs');
const path = require('path');

const KEEP_BACKUPS = 14;

function createStore(file, { backupDir = path.join(path.dirname(file), 'backups'), keep = KEEP_BACKUPS } = {}) {
  let items = [];
  let chain = Promise.resolve();
  let lastError = null;

  function read() {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    if (!Array.isArray(data)) throw new Error(`${file} should hold a JSON list`);
    return data;
  }

  async function backupOnce() {
    const d = new Date(); // the server's local date
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const target = path.join(backupDir, `restaurants-${today}.json`);
    if (fs.existsSync(target) || !fs.existsSync(file)) return;
    await fs.promises.mkdir(backupDir, { recursive: true });
    await fs.promises.copyFile(file, target);
    const old = (await fs.promises.readdir(backupDir)).filter(f => /^restaurants-\d{4}-\d\d-\d\d\.json$/.test(f)).sort();
    for (const f of old.slice(0, -keep)) await fs.promises.unlink(path.join(backupDir, f));
  }

  async function write() {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    try { await backupOnce(); } catch (e) { console.error(`Backup failed: ${e.message}`); }
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(items, null, 2) + '\n');
    await fs.promises.rename(tmp, file);
  }

  return {
    get items() { return items; },
    set items(v) { items = v; },
    get lastError() { return lastError; },
    load() { items = read(); },
    // Resolves when this change is on disk; rejects (status 500) if not.
    save() {
      const p = chain.then(write);
      chain = p.then(() => { lastError = null; }, e => {
        lastError = e;
        console.error(`Saving ${file} failed: ${e.message}`);
      });
      return chain.then(() => {
        if (lastError) throw Object.assign(new Error("Couldn't save to disk. Check the server log (nasc-food logs)."), { status: 500 });
      });
    },
    flush: () => chain,
  };
}

module.exports = { createStore };
