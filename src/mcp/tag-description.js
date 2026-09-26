'use strict';

// C1038 — placeholder-description rule for tag registration tools (create_system_tag,
// ensure_project_tag). Mirrors api/src/lib/tag-descriptions.js — separate npm packages,
// so this is a deliberate copy, not a shared import. Keep both in sync on change.
const PLACEHOLDER_DESCRIPTIONS = [
  'Auto-registered by objective save',
  'Auto-registered by createTask',
];

const PLACEHOLDER_PREFIX_RE = /^auto-registered\b/i;

function isPlaceholderDescription(description) {
  if (typeof description !== 'string') return false;
  const trimmed = description.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (PLACEHOLDER_DESCRIPTIONS.some((p) => p.toLowerCase() === lower)) return true;
  return PLACEHOLDER_PREFIX_RE.test(trimmed);
}

function placeholderError(tagName) {
  const literals = PLACEHOLDER_DESCRIPTIONS.map((p) => `"${p}"`).join(' or ');
  return `description for tag "${tagName}" must be a real one-line summary, not a placeholder (rejected: ${literals}, or any "Auto-registered..." text)`;
}

module.exports = { PLACEHOLDER_DESCRIPTIONS, isPlaceholderDescription, placeholderError };
