// Project brand colors as the Task App reads them: an ordered list of up to three distinct
// #RRGGBB values, uppercase, empty when no color is selected. The API owns and validates the
// list (api/src/lib/brand-colors.js, `identity.brand_colors`); this module only sanitizes what
// it receives. Pure, no imports: the client imports it, the server and Electron main require()
// it (require(esm)).

export const MAX_BRAND_COLORS = 3;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function isBrandColor(value) {
  return typeof value === 'string' && HEX_COLOR.test(value);
}

// Any value -> the list: invalid entries dropped, uppercased, first occurrence kept, at most three.
export function normalizeBrandColors(value) {
  if (!Array.isArray(value)) return [];
  const colors = [];
  for (const entry of value) {
    if (!isBrandColor(entry)) continue;
    const color = entry.toUpperCase();
    if (!colors.includes(color)) colors.push(color);
    if (colors.length === MAX_BRAND_COLORS) break;
  }
  return colors;
}

// A project identity -> its list. An API older than the list sends only `brand_color`, read as
// a one-entry list. No identity at all returns null: "unknown", not "no color selected".
export function identityBrandColors(identity) {
  if (!identity || typeof identity !== 'object') return null;
  if (Array.isArray(identity.brand_colors)) return normalizeBrandColors(identity.brand_colors);
  return normalizeBrandColors([identity.brand_color]);
}

export function sameBrandColors(a, b) {
  const left = normalizeBrandColors(a);
  const right = normalizeBrandColors(b);
  return left.length === right.length && left.every((color, i) => color === right[i]);
}
