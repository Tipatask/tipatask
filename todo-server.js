'use strict';
// Persistent v8 compile cache (Node >=22.8). Must run before any other require.
process.env.NODE_COMPILE_CACHE = process.env.NODE_COMPILE_CACHE
  || require('node:path').join(__dirname, 'node_modules/.cache/v8-compile-cache');
try { require('node:module').enableCompileCache(process.env.NODE_COMPILE_CACHE); } catch {}
require('./src/server/startup-banner').printStartupBanner();
require('./src/server/index');
