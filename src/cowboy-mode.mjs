// Canonical Cowboy scopes. Legacy booleans preserve the old whole-project behavior.
export const COWBOY_MODES = Object.freeze(['disabled', 'related', 'project']);
export function normalizeCowboyScope(value) {
  if (value === true || value === 1 || value === '1') return 'project';
  return COWBOY_MODES.includes(value) ? value : 'disabled';
}
export function isCowboyScopeInput(value) {
  return value == null || typeof value === 'boolean' || value === 0 || value === 1 || COWBOY_MODES.includes(value);
}
