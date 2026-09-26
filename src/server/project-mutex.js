'use strict';

// Per-project async mutex via promise-chain. No external deps.
// Each key maps to the tail of its queued promise chain.
const locks = new Map();

async function withProjectLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const next = new Promise(r => { release = r; });
  const tail = prev.then(() => next);
  locks.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Only delete if nothing else queued after us
    if (locks.get(key) === tail) locks.delete(key);
  }
}

module.exports = { withProjectLock };
