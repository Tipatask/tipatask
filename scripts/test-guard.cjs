'use strict';

// Loaded in test workers and their Node children. Tests must explicitly stub
// external services and PTYs; catching a blocked call still fails the suite.
// Writes to the runner's shared account store are recorded, not blocked.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

function record(action) {
  const error = new Error(`Unit test attempted ${action}`);
  fs.appendFileSync(process.env.TIPATASK_TEST_VIOLATIONS, `${process.argv.join(' ')}\n${error.stack}\n`);
  return error;
}

function deny(action) {
  throw record(action);
}

function isLoopback(host) {
  return host === 'localhost' || host === '::1' || host === '[::1]'
    || (net.isIP(host) === 4 && host.startsWith('127.'));
}

const fetch = globalThis.fetch;
globalThis.fetch = function (input, ...args) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (/^https?:$/.test(url.protocol) && !isLoopback(url.hostname)) deny(`external fetch to ${url.hostname}`);
  return fetch.call(this, input, ...args);
};

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const input = Array.isArray(args[0]) ? args[0] : args;
  const opts = typeof input[0] === 'object' ? input[0] : { host: typeof input[1] === 'string' ? input[1] : 'localhost' };
  const host = opts.host || 'localhost';
  if (!opts.path && !isLoopback(host)) deny(`external network access to ${host}`);
  return connect.apply(this, args);
};

require('node-pty').spawn = () => deny('a real PTY spawn');

// scripts/run-tests.js gives every concurrent test file one user-data root, and the account
// store write is read-modify-write, so a file writing it there can drop another file's entry.
// Read once at preload: a test may point TIPATASK_USER_DATA at a private root later.
const sharedRoots = new Set();
const sharedRoot = process.env.TIPATASK_TEST_SHARED_USER_DATA;
if (sharedRoot) {
  sharedRoots.add(path.resolve(sharedRoot));
  try { sharedRoots.add(fs.realpathSync(sharedRoot)); } catch {}
}
// node --test runs each file in its own worker (argv[1]); helpers it spawns inherit the name.
if (sharedRoots.size && process.env.NODE_TEST_CONTEXT && !process.env.TIPATASK_TEST_FILE) {
  process.env.TIPATASK_TEST_FILE = process.argv[1];
}

function isSharedStore(target) {
  if (!sharedRoots.size || typeof target === 'number') return false;
  try {
    const file = path.resolve(target instanceof URL ? fileURLToPath(target) : String(target));
    return path.basename(file) === '.tipatask-account.json' && sharedRoots.has(path.dirname(file));
  } catch {
    return false;
  }
}

function testFile() {
  const file = process.env.TIPATASK_TEST_FILE || process.argv[1];
  if (!file) return 'an unknown test file';
  const relative = path.relative(path.resolve(__dirname, '..'), file);
  return relative.startsWith('..') || path.isAbsolute(relative) ? file : relative;
}

const reported = new Set();
for (const [op, target] of [['writeFileSync', 0], ['renameSync', 1]]) {
  const original = fs[op];
  fs[op] = function (...args) {
    if (isSharedStore(args[target])) {
      const action = `fs.${op} into the runner's shared account store from ${testFile()}. `
        + 'Give that test file its own TIPATASK_USER_DATA (fs.mkdtempSync + test.after cleanup, before requiring app modules); '
        + 'see ai/architecture/tt-ci.md § "Gotcha — tests must seed the account store".';
      if (!reported.has(action)) {
        reported.add(action);
        record(action);
      }
    }
    return original.apply(this, args);
  };
}
