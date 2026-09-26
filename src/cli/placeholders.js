'use strict';

const PLACEHOLDER_RE = /\{\{([A-Z0-9_]+)\}\}/g;

/**
 * Substitute `{{KEY}}` placeholders in a string. Single-pass — placeholder
 * values are never scanned for further placeholders.
 *
 * Missing keys are replaced with an empty string and logged as a warning
 * (but do not throw).
 *
 * @param {string} content
 * @param {Record<string,string>} ctx
 * @param {{ warn?: (msg: string) => void, source?: string }} [opts]
 */
function substitute(content, ctx, opts = {}) {
  const warn = opts.warn || ((msg) => console.warn(`[placeholders] ${msg}`));
  const source = opts.source ? ` (${opts.source})` : '';

  return content.replace(PLACEHOLDER_RE, (_, key) => {
    if (Object.prototype.hasOwnProperty.call(ctx, key)) {
      const value = ctx[key];
      if (value == null) return '';
      return String(value);
    }
    warn(`unknown placeholder {{${key}}}${source}`);
    return '';
  });
}

module.exports = { substitute, PLACEHOLDER_RE };
