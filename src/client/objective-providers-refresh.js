// Pure policy for when the objective chat's model selector must re-fetch its provider list
// (chat-ui.js). No imports and no DOM, so it is unit-tested directly
// (objective-providers-refresh.test.js) — chat-ui.js itself is not importable under node.
//
// The list is otherwise only written by a one-shot page-load fetch, the WS `config` frame (sent
// on WS connect only) and `tiptask:providers-changed`, so a composer opened after the server's
// agent detection changed (a CLI installed after boot, a Re-Check) would keep rendering whatever
// the page-load fetch saw.

// A healthy list is re-checked at most once a minute.
export const PROVIDERS_REFRESH_TTL_MS = 60_000;
// An unhealthy list (see providersUnhealthy) is retried on the next render, but not on every
// render — attachChatHandlers() runs on every board event while a New-section tab is showing,
// and a project that genuinely has nothing selectable would otherwise poll forever.
export const PROVIDERS_UNHEALTHY_MIN_AGE_MS = 5_000;
// One delayed follow-up after an unhealthy answer. The provider read is `{peek:true}`
// server-side: base-agent.js peekDetect() serves a stale negative to its FIRST caller and only
// schedules the re-detect, so the answer right after a stale negative is one request behind.
export const PROVIDERS_RETRY_DELAY_MS = 2_000;

// Nothing to offer, or only entries that are enabled but whose CLI is unavailable — the two
// shapes that render no selector / an all-disabled one. Server-side, the latter is
// registry.js listVisibleObjectiveProviders()'s rung 2 (explicit allowlist, nothing selectable).
export function providersUnhealthy(providers) {
  if (!Array.isArray(providers) || providers.length === 0) return true;
  return providers.some((p) => p && p.enabled && !p.available);
}

// A healthy list is left alone mid-turn (a repaint under a streaming composer buys nothing), but
// an unhealthy one is exactly what the user is staring at while the first turn runs — a stale
// negative from before the CLI was detected — so it is allowed to heal during a stream.
export function shouldRefreshProviders({ providers, lastFetchedAt, now, inFlight, streaming }) {
  if (inFlight) return false;
  const age = now - (lastFetchedAt || 0);
  if (providersUnhealthy(providers)) return age >= PROVIDERS_UNHEALTHY_MIN_AGE_MS;
  if (streaming) return false;
  return age >= PROVIDERS_REFRESH_TTL_MS;
}

// What "the selector would render differently" means. Includes objectiveSelection and every
// per-provider field (defaultModel, models, reason, …) so a change that only touches a default
// model — an Edit Agents model pick — still counts as a change.
export function providersSignature(payload) {
  return JSON.stringify([payload && payload.objectiveProviders, (payload && payload.objectiveSelection) || '']);
}
