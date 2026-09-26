'use strict';

function parseAllowedExternalUrl(url, base) {
  if (typeof url !== 'string' || !url || url.trim() !== url || /[\u0000-\u001f\u007f]/.test(url)) return null;
  try {
    const target = base ? new URL(url, base) : new URL(url);
    if (target.protocol === 'mailto:') return target;
    if ((target.protocol === 'http:' || target.protocol === 'https:') && target.hostname) return target;
  } catch { /* invalid URL */ }
  return null;
}

function shouldOpenExternally(url, appOrigin) {
  if (typeof appOrigin !== 'string') return false;
  const app = parseAllowedExternalUrl(appOrigin);
  if (!app || (app.protocol !== 'http:' && app.protocol !== 'https:')) return false;
  const target = parseAllowedExternalUrl(url, app);
  if (!target) return false;
  return target.protocol === 'mailto:' || target.origin !== app.origin;
}

module.exports = { parseAllowedExternalUrl, shouldOpenExternally };
