'use strict';
// The page's two languages: both dictionaries have the same keys, every text the
// page asks for exists, food types are covered, and the browser's language maps
// to the right one.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { MESSAGES, FOOD_TYPES, detectLang } = require('../public/i18n');
const { CUISINE_WORDS } = require('../lib/parse');

const read = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const placeholders = v => [...new Set([].concat(v).join(' ').match(/\{\w+\}/g) || [])].sort();

test('English and Traditional Chinese have the same keys and placeholders', () => {
  assert.deepStrictEqual(Object.keys(MESSAGES['zh-TW']).sort(), Object.keys(MESSAGES.en).sort());
  for (const [key, en] of Object.entries(MESSAGES.en)) {
    assert.deepStrictEqual(placeholders(MESSAGES['zh-TW'][key]), placeholders(en), key);
    assert.strictEqual(typeof MESSAGES['zh-TW'][key], 'string', `${key}: Chinese has no plural forms`);
  }
});

// The quoted words inside each t(...) / tHtml(...) call, including nested and conditional ones.
function keysUsedIn(source) {
  const keys = [];
  for (const m of source.matchAll(/\bt(?:Html)?\(/g)) {
    let depth = 1, i = m.index + m[0].length;
    const start = i;
    for (; i < source.length && depth; i++) depth += source[i] === '(' ? 1 : source[i] === ')' ? -1 : 0;
    keys.push(...[...source.slice(start, i).matchAll(/'([^']+)'/g)].map(k => k[1]));
  }
  return keys;
}

test('every text key used in index.html and app.js is in the dictionary', () => {
  const used = [
    ...[...read('index.html').matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map(m => m[1]),
    ...keysUsedIn(read('app.js')),
  ];
  assert.ok(used.includes('locDenied') && used.includes('ratingLabelReviews'), 'finds keys in conditional calls');
  assert.ok(used.length > 30);
  for (const key of used) assert.ok(Object.hasOwn(MESSAGES.en, key), key);
});

test('every known food type has a Chinese name', () => {
  const icons = read('app.js').match(/const ICONS = \{([^}]*)\}/)[1];
  const names = [...icons.matchAll(/(?:^|[\s,{])(?:'([^']+)'|(\w+)):\s*'/g)].map(m => m[1] || m[2]);
  assert.ok(names.length > 20);
  for (const n of [...names, ...CUISINE_WORDS, 'Other']) assert.ok(FOOD_TYPES['zh-TW'][n], n);
});

test('the browser language picks English or Traditional Chinese', () => {
  for (const tag of ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-TW', 'zh-tw', 'yue-Hant-HK']) assert.strictEqual(detectLang([tag]), 'zh-TW', tag);
  for (const tag of ['en-US', 'zh', 'zh-CN', 'zh-Hans', 'yue', 'ja', 'fr-FR']) assert.strictEqual(detectLang([tag]), 'en', tag);
  assert.strictEqual(detectLang(['ja', 'zh-TW', 'en']), 'zh-TW', 'the first language we have decides');
  assert.strictEqual(detectLang(['en-GB', 'zh-TW']), 'en');
  assert.strictEqual(detectLang([]), 'en');
  assert.strictEqual(detectLang(undefined), 'en');
});
