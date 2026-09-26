'use strict';

// Loaded in test workers and their Node children. Tests must explicitly stub
// external services and PTYs; catching a blocked call still fails the suite.
const fs = require('node:fs');
const net = require('node:net');

function deny(action) {
  const error = new Error(`Unit test attempted ${action}`);
  fs.appendFileSync(process.env.TIPATASK_TEST_VIOLATIONS, `${process.argv.join(' ')}\n${error.stack}\n`);
  throw error;
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
