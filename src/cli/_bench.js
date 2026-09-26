#!/usr/bin/env node
'use strict';

const t0 = process.hrtime.bigint();
require(require('node:path').resolve(process.cwd(), process.argv[2]));
const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
process.stderr.write(`${elapsed.toFixed(2)}ms\n`);
process.exit(0);
