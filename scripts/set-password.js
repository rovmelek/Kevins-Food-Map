#!/usr/bin/env node
'use strict';
// Set the admin password for the Manage window. Asks for it twice (typing is
// hidden) and saves only its hash (Argon2id, or scrypt on older Node) as
// ADMIN_PASSWORD_HASH in .env, readable only by you. Restart the server
// afterwards.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { hashPassword } = require('../lib/auth');

const ENV = path.join(__dirname, '..', '.env');
const EXAMPLE = path.join(__dirname, '..', '.env.example');
const MIN_LENGTH = 10;

// Reads lines from stdin; when it's a terminal, nothing typed is echoed.
function makeReader() {
  const tty = process.stdin.isTTY;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!tty });
  if (tty) rl._writeToOutput = s => { if (!rl.muted) process.stdout.write(s); };
  const lines = [];
  let waiting = null;
  rl.on('line', l => { if (waiting) { const w = waiting; waiting = null; w(l); } else lines.push(l); });
  rl.on('close', () => { if (waiting) waiting(null); });
  rl.on('SIGINT', () => { rl.close(); if (tty) process.stdout.write('\n'); console.error('Cancelled. Nothing was changed.'); process.exit(130); });
  return {
    ask(prompt) {
      process.stdout.write(prompt);
      rl.muted = true;
      return new Promise(resolve => {
        const done = l => { rl.muted = false; if (tty) process.stdout.write('\n'); resolve(l); };
        if (lines.length) done(lines.shift()); else waiting = done;
      });
    },
    close: () => rl.close(),
  };
}

async function main() {
  const reader = makeReader();
  const pw = await reader.ask('New admin password: ');
  const again = await reader.ask('Type it again: ');
  reader.close();
  if (pw == null || again == null) throw new Error('No password entered.');
  if (pw !== again) throw new Error('The two passwords did not match. Nothing was changed.');
  if (pw.length < MIN_LENGTH) throw new Error(`Use at least ${MIN_LENGTH} characters. Nothing was changed.`);

  const hash = await hashPassword(pw);
  let env = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : fs.existsSync(EXAMPLE) ? fs.readFileSync(EXAMPLE, 'utf8') : '';
  const line = `ADMIN_PASSWORD_HASH=${hash}`;
  // Same pattern the server's .env loader reads (spaces, `export`), so the
  // old line is always the one replaced. Extra copies are dropped, since the
  // loader would use the first.
  const existing = /^[ \t]*(?:export[ \t]+)?ADMIN_PASSWORD_HASH[ \t]*=.*$/gm;
  if (existing.test(env)) {
    let first = true;
    env = env.replace(existing, () => (first ? ((first = false), line) : '')).replace(/\n{3,}/g, '\n\n');
  } else {
    env = `${env.replace(/\s*$/, '\n')}\n# Admin password for Manage (a hash, set with: npm run set-password)\n${line}\n`;
  }
  // Write a private temp file and rename it over .env, so the file is never
  // half-written and ends up readable only by its owner even if it was not.
  // It keeps the existing file's owner, so running this with sudo doesn't
  // leave .env unreadable for the service's user.
  // A new .env takes the app folder's owner.
  const owner = fs.statSync(fs.existsSync(ENV) ? ENV : path.dirname(ENV));
  const uid = process.getuid?.();
  if (uid !== undefined && uid !== 0 && fs.existsSync(ENV) && owner.uid !== uid) {
    throw new Error(`${ENV} belongs to another user. Run this as that user, or with sudo.`);
  }
  const tmp = `${ENV}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, env, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    if (uid === 0 && owner.uid !== 0) fs.chownSync(tmp, owner.uid, owner.gid);
    fs.renameSync(tmp, ENV);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  console.log(`Saved to ${ENV}. Restart the server (nasc-food restart, or npm start) to use it.`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
