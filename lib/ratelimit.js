'use strict';
// A fixed-window request limit per visitor address, kept in memory. The table
// is capped (oldest entries go first) so a flood of addresses can't grow
// memory without limit.

function createLimiter({ max, windowMs, maxTracked = 10000, keyOf = String, now = Date.now }) {
  const hits = new Map(); // key -> { count, resetAt }
  return {
    // Counts one request. Returns 0 if allowed, else the ms until the window ends.
    check(who) {
      const key = keyOf(who), t = now();
      let h = hits.get(key);
      if (!h || h.resetAt <= t) {
        h = { count: 0, resetAt: t + windowMs };
        hits.delete(key); // re-insert so the Map stays ordered oldest-first
        hits.set(key, h);
        while (hits.size > maxTracked) hits.delete(hits.keys().next().value);
      }
      h.count += 1;
      return h.count > max ? h.resetAt - t : 0;
    },
    get size() { return hits.size; },
  };
}

module.exports = { createLimiter };
