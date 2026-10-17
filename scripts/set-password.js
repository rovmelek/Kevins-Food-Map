#!/usr/bin/env node
'use strict';
// Set the admin password for the Manage window. Asks for it twice (typing is
// hidden) and saves only its scrypt hash as ADMIN_PASSWORD_HASH in .env.
// Restart the server afterwards.

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
  env = /^ADMIN_PASSWORD_HASH=.*$/m.test(env)
    ? env.replace(/^ADMIN_PASSWORD_HASH=.*$/m, line)
    : `${env.replace(/\s*$/, '\n')}\n# Admin password for Manage (a hash, set with: npm run set-password)\n${line}\n`;
  fs.writeFileSync(ENV, env, { mode: 0o600 });
  console.log(`Saved to ${ENV}. Restart the server (nasc-food restart, or npm start) to use it.`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
