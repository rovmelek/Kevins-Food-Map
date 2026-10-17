'use strict';
// Admin password and login sessions for the Manage window.
//
// Only a hash of the password is stored, in ADMIN_PASSWORD_HASH, using Node's
// built-in crypto (no packages). OWASP's first choice is Argon2id; Node has it
// from v24 (crypto.argon2), so we use it when available and fall back to
// scrypt, OWASP's next choice, on older Node. Formats:
//   argon2id$<memory KiB>$<passes>$<parallelism>$<salt b64>$<hash b64>
//   scrypt$<log2 N>$<r>$<p>$<salt b64>$<hash b64>

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const argon2 = crypto.argon2 ? promisify(crypto.argon2) : null;
const KEYLEN = 32;
// OWASP minimums: Argon2id m=19 MiB, t=2, p=1; scrypt N=2^17, r=8, p=1.
const ARGON = { memory: 19456, passes: 2, parallelism: 1 };
const SCRYPT = { logN: 17, r: 8, p: 1 };
const MAXMEM = 256 * 1024 * 1024; // scrypt N=2^17, r=8 needs 128 MiB; Node's default cap is lower

function argon2id(password, salt, { memory, passes, parallelism }, tagLength) {
  return argon2('argon2id', { message: Buffer.from(password), nonce: salt, memory, passes, parallelism, tagLength });
}
function scryptHash(password, salt, { logN, r, p }, keylen) {
  return scrypt(password, salt, keylen, { N: 2 ** logN, r, p, maxmem: MAXMEM });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  if (argon2) {
    const hash = await argon2id(password, salt, ARGON, KEYLEN);
    return ['argon2id', ARGON.memory, ARGON.passes, ARGON.parallelism, salt.toString('base64'), hash.toString('base64')].join('$');
  }
  const hash = await scryptHash(password, salt, SCRYPT, KEYLEN);
  return ['scrypt', SCRYPT.logN, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6) return false;
  const [kind, a, b, c, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64'), expected = Buffer.from(hashB64, 'base64');
  if (!expected.length) return false;
  let actual;
  if (kind === 'argon2id') {
    if (!argon2) throw new Error('This password hash needs Node.js 24 or newer (Argon2id). Upgrade Node or run set-password again.');
    actual = await argon2id(String(password), salt, { memory: +a, passes: +b, parallelism: +c }, expected.length);
  } else if (kind === 'scrypt') {
    actual = await scryptHash(String(password), salt, { logN: +a, r: +b, p: +c }, expected.length);
  } else {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

// In-memory sessions: a restart logs everyone out, which is fine for one admin.
const SESSION_MS = 12 * 60 * 60 * 1000;
const sessions = new Map(); // token -> expiry time

function createSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, Date.now() + SESSION_MS);
  return token;
}
function isValidSession(token) {
  const exp = token && sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(token); return false; }
  return true;
}
function endSession(token) { sessions.delete(token); }

// Brute-force guard: 5 wrong passwords from one address locks it out for 15 min.
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;
const fails = new Map(); // ip -> { count, until }

function lockedFor(ip) {
  const f = fails.get(ip);
  if (!f || f.count < MAX_FAILS) return 0;
  const left = f.until - Date.now();
  if (left <= 0) { fails.delete(ip); return 0; }
  return left;
}
function recordFailure(ip) {
  const f = fails.get(ip) || { count: 0, until: 0 };
  f.count += 1;
  f.until = Date.now() + LOCK_MS;
  fails.set(ip, f);
}
function clearFailures(ip) { fails.delete(ip); }

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore bad cookie */ } }
  }
  return out;
}

module.exports = {
  hashPassword, verifyPassword, algorithm: argon2 ? 'argon2id' : 'scrypt', createSession, isValidSession, endSession,
  lockedFor, recordFailure, clearFailures, parseCookies, SESSION_MS,
};
