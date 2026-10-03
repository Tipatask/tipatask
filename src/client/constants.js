// (C1187) Status constants moved to status-registry.js — per-project registry, not a
// fixed list. STATUSES/STATUS_LABELS/STATUS_ORDER are gone; use statusNames()/
// statusLabel()/statusOrder() from status-registry.js instead.

// ── Tipatask API default host ──
// (TPT161) Shared by project-creation-wizard.js (create) and setup-modal.js (link/
// re-auth) — neither wizard has a URL field, the API host is no longer user-supplied.
export const DEFAULT_API_BASE_URL = 'https://web.tipatask.com';

// ── Draft/storage keys ──
export const DRAFT_KEY_OBJECTIVE = 'todo-draft-objective';
export const DRAFT_KEY_TASK = 'todo-draft-task';
export const ACTIVE_NEW_TAB_KEY = 'todo-active-new-form';
export const LAST_PROMPT_KEY = 'todo-last-prompt';
export const CHAT_STATE_KEY = 'todo-chat-state';

// ── Chain dependency highlight colors ──
export const CHAIN_COLORS = [
  '#7c3aed', '#0891b2', '#c026d3', '#ea580c',
  '#0d9488', '#4f46e5', '#db2777', '#65a30d',
];

// ── Truncation limit for task descriptions ──
// Was 4000 (C1065): preset-A seeded descriptions grew close to that ceiling
// once the code-scan/inspection step was added — see seed-setup-tasks.js.
export const MAX_DESC_LEN = 6000;

// ── (TPT469) Chat glyph ──
// A plain outline speech bubble: the left menu's Start Chat button, each started project chat's
// row in the active-sessions list, and the chat window's start gate. Sized by CSS.
export const CHAT_BUBBLE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 15a2 2 0 0 1-2 2H7.5L3 20.5V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

// ── (TPT272) Hourglass glyph for a board card locked by Rehash → Discuss ──
// Path from design/hourglass.svg (Boxicons v3, free license); sized by CSS (.card-discuss-overlay).
export const HOURGLASS_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M5 2H4v2h1v1c0 2.46 1.32 4.77 3.43 6.02.35.21.57.55.57.9v.16c0 .35-.21.69-.57.9A7.01 7.01 0 0 0 5 19v1H4v2h16v-2h-1v-1c0-2.46-1.32-4.77-3.43-6.02-.36-.21-.57-.55-.57-.9v-.16c0-.35.21-.69.57-.9A7.01 7.01 0 0 0 19 5V4h1V2zm12 3c0 1.76-.94 3.41-2.45 4.3-.97.57-1.55 1.55-1.55 2.62v.16c0 1.07.58 2.05 1.55 2.62 1.51.89 2.45 2.54 2.45 4.3v1H7v-1c0-1.76.94-3.41 2.45-4.3.97-.57 1.55-1.55 1.55-2.62v-.16c0-1.07-.58-2.05-1.55-2.62A5.01 5.01 0 0 1 7 5V4h10z"/></svg>';

// ── Agent model option lists ──
// Keep in sync with src/server/config.js CLAUDE_MODELS / CODEX_MODELS
export const CLAUDE_MODELS = [
  { value: 'opusplan',                    label: 'opusplan (default)' },
  { value: 'claude-opus-4-8',            label: 'Opus 4.8' },
  { value: 'claude-sonnet-4-6',          label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5-20251001',  label: 'Haiku 4.5' },
  { value: 'claude-fable-5',            label: 'Fable 5' },
  { value: 'claude-opus-5',             label: 'Opus 5' },
  { value: 'claude-sonnet-5',           label: 'Sonnet 5' },
];

// ── (TPT285) Per-task reasoning effort ──
// Mirror of api/src/lib/task-service.js EFFORT_LEVELS — the API validates (normalizeEffort),
// this list only drives the edit-modal/New Task select and the card badge. Blank/null on a
// task = inherit the agent default. EFFORT_LABELS maps each level to its i18n key.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'];
export const EFFORT_LABELS = { low: 'effort.low', medium: 'effort.medium', high: 'effort.high', max: 'effort.max' };

// ── Chat-model-selector (C1029) ──
// localStorage (not sessionStorage) so the choice survives an app restart, not just a
// page reload. Only stores the sticky cross-session default — per-tab overrides live on
// chatState.objectiveModel / the chat-draft, not here.
export const OBJECTIVE_MODEL_KEY = 'tipatask-objective-model';

export const CODEX_MODELS = [
  { value: 'gpt-5.6-sol',   label: 'gpt-5.6-sol (default)', description: 'Latest frontier agentic coding model.' },
  { value: 'gpt-5.6-terra', label: 'gpt-5.6-terra',         description: 'Balanced agentic coding model for everyday work.' },
  { value: 'gpt-5.6-luna',  label: 'gpt-5.6-luna',          description: 'Fast and affordable agentic coding model.' },
  { value: 'gpt-5.5',       label: 'gpt-5.5',                description: 'Frontier model for complex coding, research, and real-world work.' },
  { value: 'gpt-5.4',       label: 'gpt-5.4',                description: 'Strong model for everyday coding.' },
  { value: 'gpt-5.4-mini',  label: 'gpt-5.4-mini',           description: 'Small, fast, and cost-efficient model for simpler coding tasks.' },
];

// C1030 — objective-chat selector labels for Gemini/Pi. Keep in sync with
// src/server/config.js GEMINI_MODELS / PI_MODELS. Server only ships bare
// {value} entries (per-provider allowlist), so an unlabeled value here still renders —
// chat-ui.js modelLabel() falls back to the raw value when no match is found.
export const GEMINI_MODELS = [
  { value: 'gemini-2.5-pro',        label: 'Gemini 2.5 Pro' },
  { value: 'gemini-2.5-flash',      label: 'Gemini 2.5 Flash (default)' },
  { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
];

export const PI_MODELS = [
  { value: 'openrouter/anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet (default)' },
  { value: 'openrouter/openai/gpt-4o',                label: 'GPT-4o' },
];

// (C1118) Shared display-label lookup for a provider's model id — server only ships bare
// {value} model entries (single source of truth is config.js CLAUDE_MODELS/CODEX_MODELS/
// GEMINI_MODELS/PI_MODELS), display labels live client-side in the lists above. Used by both
// the chat-model-selector (chat-ui.js) and the terminal header caption (console-modal.js).
export const MODEL_LABEL_LISTS = { claude: CLAUDE_MODELS, codex: CODEX_MODELS, gemini: GEMINI_MODELS, pi: PI_MODELS };
export function modelLabel(providerId, value) {
  const live = (_liveModelOptions.get(providerId) || []).find(m => m.value === value);
  if (live) return live.label;
  const found = (MODEL_LABEL_LISTS[providerId] || []).find(m => m.value === value);
  return found ? found.label : value;
}

// ── Live per-agent model registry client (C1505) ──
// Consumes the C1504 server registry (GET /api/agent-models) so the Task Edit Modal, New Task
// form, and Settings ▸ Agents modal show whatever models the installed claude/codex CLIs
// actually support, instead of only this file's hand-maintained CLAUDE_MODELS/CODEX_MODELS.
// Those two arrays remain the fallback (used verbatim whenever the server has nothing better)
// and the label/description source (see normalizeAgentModels below) — never remove them.
// `pi` is deliberately excluded: base-agent.js's default probeModels() always returns [], so
// the server's `pi` entry is always an empty fallback list; Pi model choice lives in the
// agent-picker (renderAgentPicker), not a model <select>.
const STATIC_MODEL_LISTS = { claude: CLAUDE_MODELS, codex: CODEX_MODELS };
const _liveModelOptions = new Map(); // agentId -> [{value, label, description?, isLatest}]
let _agentModelsPromise = null;

// Pure — maps one server registry entry's `{id, label, isLatest}` models onto the
// `{value, label, description?, isLatest}` shape every existing dropdown/option-renderer here
// already consumes. The static list's label wins when the id is one we already know: this is
// what keeps the `source:'fallback'` case (server has no live probe, ids come straight from
// config.js) rendering identically to the pre-C1505 hardcoded dropdown, and keeps
// console-modal.js's `_modelDisplayName()` finding its trailing "(default)" suffix on
// `opusplan`. A new id the static list has never heard of keeps the server's own label (or the
// raw id, if the server had none either — same fallback modelLabel() already used everywhere).
export function normalizeAgentModels(agentId, entry) {
  const staticList = STATIC_MODEL_LISTS[agentId];
  if (!staticList) return [];
  const models = Array.isArray(entry?.models) ? entry.models : [];
  if (!models.length) return staticList;
  const staticById = new Map(staticList.map(m => [m.value, m]));
  return models.map(m => {
    const known = staticById.get(m.id);
    return {
      value: m.id,
      label: known?.label ?? m.label ?? m.id,
      ...(known?.description ? { description: known.description } : {}),
      isLatest: !!m.isLatest,
    };
  });
}

// Module-lifetime single-flight fetch (mirrors task-board.js's _ensureProjectConfig) — the
// registry is machine-wide (keyed by agent id only, not by project — see tt-task-agent.md
// § Model Registry), so no `x-tipatask-project` header is needed, same as the existing bare
// fetch('/api/config') calls in the edit-modal open path. Never throws: a missing server, a
// non-OK response, or a malformed body all leave `_liveModelOptions` exactly as it was
// (empty on first call — agentModelOptions() then serves the static fallback).
export async function ensureAgentModels({ force = false } = {}) {
  if (_agentModelsPromise) return _agentModelsPromise;
  _agentModelsPromise = (async () => {
    try {
      const res = await fetch(`/api/agent-models${force ? '?refresh=1' : ''}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const agents = data?.agents || {};
      for (const agentId of Object.keys(STATIC_MODEL_LISTS)) {
        if (agents[agentId]) _liveModelOptions.set(agentId, normalizeAgentModels(agentId, agents[agentId]));
      }
    } catch { /* offline / unreachable — keep whatever was cached (static fallback if nothing yet) */ }
  })();
  try {
    return await _agentModelsPromise;
  } finally {
    _agentModelsPromise = null;
  }
}

// Synchronous — every option renderer calls this instead of the raw CLAUDE_MODELS/CODEX_MODELS
// arrays. Returns the live list once ensureAgentModels() has resolved at least once, else the
// static fallback (or [] for an agent with no model select, e.g. 'human'/'pi').
export function agentModelOptions(agentId) {
  return _liveModelOptions.get(agentId) || STATIC_MODEL_LISTS[agentId] || [];
}

// Cheap identity check so a caller can skip repainting a dropdown when a warm ensureAgentModels()
// resolves to the same list that's already on screen (agents-modal.js's grid re-render guard).
export function agentModelsSignature(agentId) {
  return agentModelOptions(agentId).map(m => m.value).join(',');
}

export function _resetAgentModelsForTest() {
  _liveModelOptions.clear();
  _agentModelsPromise = null;
}

// ── Xterm theme (Catppuccin Mocha) ──
export const XTERM_THEME = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  selectionBackground: '#585b7066',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#f5c2e7',
  cyan: '#94e2d5',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5',
  brightWhite: '#a6adc8',
};
