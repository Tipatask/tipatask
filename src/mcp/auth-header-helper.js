#!/usr/bin/env node
'use strict';

// Claude's header protocol reads the selected account on each connect/reconnect.
// Only this protocol emits a token (stdout JSON). Failure emits a blank header,
// overriding stale static auth; diagnostics never contain credentials.

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : '';
}

// Only this protocol writes a token to stdout. Fail closed with an empty header:
// exit 1 would make Claude reuse an old static Authorization header after sign-out.
const userData = argValue('--user-data');
if (userData) process.env.TIPATASK_USER_DATA = userData;
let authorization = '';
try {
  const root = argValue('--project-root') || process.env.TIPATASK_PROJECT_ROOT || process.cwd();
  const { getApiCredentials } = require('../server/api-credentials');
  const creds = getApiCredentials(root, { migrate: false });
  const { normalizeBaseUrl } = require('../server/account-store');
  if (argValue('--api-base-url') && normalizeBaseUrl(argValue('--api-base-url')) !== normalizeBaseUrl(creds.baseUrl)) throw new Error();
  if (argValue('--project-id') && argValue('--project-id') !== String(creds.projectId)) throw new Error();
  authorization = `Bearer ${creds.token}`;
} catch {
  process.stderr.write('Tipatask credentials unavailable; check project/user-data paths or sign in again.\n');
}
process.stdout.write(JSON.stringify({ Authorization: authorization }));
