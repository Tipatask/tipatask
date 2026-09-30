'use strict';

// Version string shown on the splash next to the copyright. Never throws: any failure
// (missing/unreadable package.json, getVersion() throwing, junk value) yields '' and the
// splash renders the copyright alone.
const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;

function cleanVersion(v) {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return VERSION_RE.test(t) ? t : '';
}

// getVersion: app.getVersion() in the Electron main process (packaged build reads the
// asar package.json). readPackageVersion: fallback reading package.json's `version`.
function resolveAppVersion({ getVersion, readPackageVersion } = {}) {
  for (const source of [getVersion, readPackageVersion]) {
    if (typeof source !== 'function') continue;
    try {
      const v = cleanVersion(source());
      if (v) return v;
    } catch { /* fall through to the next source */ }
  }
  return '';
}

module.exports = { resolveAppVersion, cleanVersion, VERSION_RE };
