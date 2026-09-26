import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PROVIDERS_REFRESH_TTL_MS, PROVIDERS_UNHEALTHY_MIN_AGE_MS,
  providersUnhealthy, shouldRefreshProviders, providersSignature,
} from './objective-providers-refresh.js';

const HEALTHY = [{ id: 'claude', enabled: true, available: true, selectable: true, models: [{ value: 'opus' }] }];
const ALL_DISABLED = [{ id: 'claude', enabled: true, available: false, selectable: false, models: [{ value: 'opus' }] }];
const NOW = 1_000_000;
const base = { providers: HEALTHY, lastFetchedAt: NOW, now: NOW, inFlight: false, streaming: false };

// ── providersUnhealthy ───────────────────────────────────────────────────────────────────────

test('providersUnhealthy: empty list (no selector renders) is unhealthy', () => {
  assert.equal(providersUnhealthy([]), true);
  assert.equal(providersUnhealthy(undefined), true);
  assert.equal(providersUnhealthy(null), true);
});

test('providersUnhealthy: an enabled-but-unavailable entry (all-disabled <select>) is unhealthy', () => {
  assert.equal(providersUnhealthy(ALL_DISABLED), true);
  assert.equal(providersUnhealthy([...HEALTHY, ...ALL_DISABLED]), true);
});

test('providersUnhealthy: available entries are healthy; a not-enabled unavailable one is ignored', () => {
  assert.equal(providersUnhealthy(HEALTHY), false);
  assert.equal(providersUnhealthy([...HEALTHY, { id: 'codex', enabled: false, available: false }]), false);
});

// ── shouldRefreshProviders ───────────────────────────────────────────────────────────────────

test('shouldRefreshProviders: a healthy, fresh list is left alone', () => {
  assert.equal(shouldRefreshProviders({ ...base, now: NOW + 1 }), false);
  assert.equal(shouldRefreshProviders({ ...base, now: NOW + PROVIDERS_REFRESH_TTL_MS - 1 }), false);
});

test('shouldRefreshProviders: a healthy list is re-fetched once the TTL has elapsed', () => {
  assert.equal(shouldRefreshProviders({ ...base, now: NOW + PROVIDERS_REFRESH_TTL_MS }), true);
});

test('shouldRefreshProviders: an empty list (Symptom A) is re-fetched well inside the TTL', () => {
  const at = NOW + PROVIDERS_UNHEALTHY_MIN_AGE_MS;
  assert.equal(shouldRefreshProviders({ ...base, providers: [], now: at }), true);
  assert.ok(at - NOW < PROVIDERS_REFRESH_TTL_MS);
});

test('shouldRefreshProviders: an all-disabled list (Symptom B) is re-fetched well inside the TTL', () => {
  assert.equal(shouldRefreshProviders({ ...base, providers: ALL_DISABLED, now: NOW + PROVIDERS_UNHEALTHY_MIN_AGE_MS }), true);
});

test('shouldRefreshProviders: an unhealthy list is not polled on every render', () => {
  // attachChatHandlers() runs on every board event while a New-section tab is showing.
  assert.equal(shouldRefreshProviders({ ...base, providers: [], now: NOW + 1 }), false);
  assert.equal(shouldRefreshProviders({ ...base, providers: [], now: NOW + PROVIDERS_UNHEALTHY_MIN_AGE_MS - 1 }), false);
});

test('shouldRefreshProviders: never while a fetch is in flight', () => {
  const stale = { ...base, providers: [], lastFetchedAt: 0, now: NOW + PROVIDERS_REFRESH_TTL_MS * 10 };
  assert.equal(shouldRefreshProviders(stale), true, 'sanity: would refresh otherwise');
  assert.equal(shouldRefreshProviders({ ...stale, inFlight: true }), false);
});

test('shouldRefreshProviders: a healthy list is not re-fetched mid-turn, even past the TTL', () => {
  const past = { ...base, lastFetchedAt: 0, now: NOW + PROVIDERS_REFRESH_TTL_MS * 10 };
  assert.equal(shouldRefreshProviders(past), true, 'sanity: would refresh when idle');
  assert.equal(shouldRefreshProviders({ ...past, streaming: true }), false);
});

test('shouldRefreshProviders: an unhealthy list still heals mid-turn (TPT182)', () => {
  // The first turn is exactly when the user is staring at a dead selector left over from a stale
  // negative — a hard "never while streaming" bail would keep it dead for the whole turn.
  const at = NOW + PROVIDERS_UNHEALTHY_MIN_AGE_MS;
  assert.equal(shouldRefreshProviders({ ...base, providers: [], streaming: true, now: at }), true);
  assert.equal(shouldRefreshProviders({ ...base, providers: ALL_DISABLED, streaming: true, now: at }), true);
});

test('shouldRefreshProviders: an unhealthy list mid-turn is still rate-limited', () => {
  assert.equal(shouldRefreshProviders({ ...base, providers: ALL_DISABLED, streaming: true, now: NOW + 1 }), false);
  assert.equal(shouldRefreshProviders({ ...base, providers: [], streaming: true, now: NOW + PROVIDERS_UNHEALTHY_MIN_AGE_MS - 1 }), false);
});

test('shouldRefreshProviders: lastFetchedAt of 0 (never fetched / invalidated) always refreshes', () => {
  assert.equal(shouldRefreshProviders({ ...base, lastFetchedAt: 0, now: NOW }), true);
  assert.equal(shouldRefreshProviders({ ...base, lastFetchedAt: undefined, now: NOW }), true);
});

// ── providersSignature ───────────────────────────────────────────────────────────────────────

test('providersSignature: identical payloads match', () => {
  const a = { objectiveProviders: HEALTHY, objectiveSelection: 'claude:opus' };
  const b = { objectiveProviders: JSON.parse(JSON.stringify(HEALTHY)), objectiveSelection: 'claude:opus' };
  assert.equal(providersSignature(a), providersSignature(b));
});

test('providersSignature: a change in availability, defaultModel, models, reason or selection differs', () => {
  const ref = { objectiveProviders: HEALTHY, objectiveSelection: 'claude:opus' };
  const sig = providersSignature(ref);
  const withProvider = (patch) => ({ ...ref, objectiveProviders: [{ ...HEALTHY[0], ...patch }] });
  assert.notEqual(sig, providersSignature(withProvider({ available: false })));
  assert.notEqual(sig, providersSignature(withProvider({ defaultModel: 'sonnet' })), 'an Edit Agents model pick must repaint');
  assert.notEqual(sig, providersSignature(withProvider({ models: [{ value: 'opus' }, { value: 'sonnet' }] })));
  assert.notEqual(sig, providersSignature(withProvider({ reason: 'not logged in' })));
  assert.notEqual(sig, providersSignature({ ...ref, objectiveSelection: 'claude:sonnet' }));
});

test('providersSignature: tolerates a missing selection', () => {
  assert.equal(
    providersSignature({ objectiveProviders: [] }),
    providersSignature({ objectiveProviders: [], objectiveSelection: '' }),
  );
});
