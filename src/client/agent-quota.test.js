import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  createQuotaLoader, quotaUsageState, renderAgentQuotaSidebarBody, formatQuotaResetRemaining, createAgentQuotaSidebar,
  initializeAgentQuotaSidebar, refreshAgentQuota, resetAgentQuota, syncAgentQuotaSidebarLocale, REFRESH_MS,
} from './agent-quota.js';
import { setLocale } from './i18n.js';

const payload = (root, usage = 30) => ({ projectRoot: root, agents: Object.fromEntries(['claude', 'codex'].map(provider => [provider, {
  provider, projectRoot: root, connectionState: 'connected', plan: 'pro', status: 'available',
  windows: [{ id: provider === 'claude' ? 'five_hour' : 'codex_primary', usagePercent: usage, resetAt: null, windowMinutes: 300 }],
}])) });
// Caption of every drawn bar, in order (the first text layer of each row).
const captions = html => [...html.matchAll(/<span class="agent-quota-sidebar-text"><span>([^<]*)<\/span><strong>(.*?)<\/strong>/g)].map(m => `${m[1]} | ${m[2].replace(/<[^>]*>/g, '')}`);
const agentWith = (provider, windows, extra = {}) => ({ provider, projectRoot: '/A', connectionState: 'connected', plan: 'max', status: 'available', windows, ...extra });
const response = data => ({ ok: true, json: async () => data });
const flush = () => new Promise(resolve => setImmediate(resolve));
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');

// Hand-rolled DOM (no jsdom in this project) covering only what the sidebar touches.
function harness() {
  const classes = new Set(['agent-quota-sidebar', 'agent-quota-sidebar--loading']);
  const attrs = new Map();
  const spans = [];
  const body = {
    innerHTML: '',
    querySelectorAll: () => [...(body.innerHTML.matchAll(/data-reset-at="([^"]*)"/g))].map((m, i) => spans[i] ||= {
      textContent: '', getAttribute: () => m[1],
    }),
  };
  const status = { textContent: '' };
  const title = { textContent: '' };
  const button = {
    title: '', attrs: new Map(), listeners: [],
    setAttribute(key, value) { this.attrs.set(key, value); },
    addEventListener(type, fn) { if (type === 'click') this.listeners.push(fn); },
    click() { for (const fn of this.listeners) fn({ preventDefault() {} }); },
  };
  const els = {
    '.agent-quota-sidebar-body': body, '.agent-quota-sidebar-status': status,
    '.agent-quota-sidebar-title': title, '.agent-quota-sidebar-refresh': button,
  };
  const root = {
    classList: { toggle(name, force) { if (force) classes.add(name); else classes.delete(name); } },
    setAttribute(key, value) { attrs.set(key, value); },
    querySelector: selector => els[selector] ?? null,
  };
  const calls = [];
  // Honors abort like a real fetch, so superseded reads settle and release their timeout.
  const fetchImpl = (url, options) => new Promise((resolve, reject) => {
    calls.push({ url, options, resolve, reject });
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const timers = [];
  const setTimer = (fn, ms) => timers.push({ fn, ms, cleared: false }) - 1;
  const clearTimer = id => { if (id != null && timers[id]) timers[id].cleared = true; };
  const doc = {
    hidden: false, listeners: new Set(),
    addEventListener(type, fn) { if (type === 'visibilitychange') this.listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'visibilitychange') this.listeners.delete(fn); },
    fire() { for (const fn of this.listeners) fn(); },
  };
  const opts = (projectPath = '/A') => ({ projectPath, fetchImpl, setTimer, clearTimer, document: doc, now: () => Date.UTC(2026, 8, 23, 21, 40) });
  return {
    root, body, status, title, button, classes, attrs, calls, timers, doc, opts,
    async settle(i, data) { calls[i].resolve(response(data)); await flush(); },
    async fail(i) { calls[i].reject(new Error('boom')); await flush(); },
    has: name => classes.has(`agent-quota-sidebar--${name}`),
  };
}

test('fresh quota reads carry project scope, bypass cache, and cancel superseded reads', async () => {
  const calls = [];
  const loader = createQuotaLoader(() => 'A', (url, options) => new Promise(resolve => calls.push({ url, options, resolve })));
  const old = loader.read({ 'x-tipatask-project': '/A' });
  const fresh = loader.read({ 'x-tipatask-project': '/A' });
  assert.equal(calls[0].url, '/api/agent-quota');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.headers['x-tipatask-project'], '/A');
  assert.equal(calls[0].options.signal.aborted, true);
  calls[1].resolve(response(payload('/A', 88)));
  assert.equal((await fresh).data.agents.codex.windows[0].usagePercent, 88);
  calls[0].resolve(response(payload('/A', 12)));
  assert.equal(await old, null);
});

test('project changes, close, and A -> B -> A invalidate responses even when fetch ignores abort', async () => {
  let scope = 'A';
  let resolve;
  const loader = createQuotaLoader(() => scope, () => new Promise(done => { resolve = done; }));
  const request = loader.read({ 'x-tipatask-project': '/A' });
  scope = 'B';
  resolve(response(payload('/A')));
  assert.equal(await request, null);
  for (const action of ['close', 'roundtrip']) {
    scope = 'A';
    const pending = loader.read({ 'x-tipatask-project': '/A' });
    if (action === 'roundtrip') scope = 'B';
    loader.invalidate();
    scope = 'A';
    resolve(response(payload('/A')));
    assert.equal(await pending, null);
  }
});

test('mismatched top-level/provider scope and failed requests never expose data', async () => {
  const wrongProvider = payload('/A');
  wrongProvider.agents.codex.projectRoot = '/B';
  for (const data of [payload('/B'), wrongProvider, {}, null]) {
    const loader = createQuotaLoader(() => 'A', async () => response(data));
    assert.deepEqual(await loader.read({ 'x-tipatask-project': '/A' }), { error: 'request_failed' });
  }
  const loader = createQuotaLoader(() => 'A', async () => { throw new Error('secret diagnostic'); });
  assert.deepEqual(await loader.read({}), { error: 'request_failed' });
});

test('usage states preserve true zero, unavailable values, thresholds, and over-limit values', () => {
  for (const value of [null, undefined, NaN, Infinity, -1, '42']) assert.equal(quotaUsageState(value), 'unavailable');
  for (const [value, state] of [[0, 'normal'], [79.9, 'normal'], [80, 'near-limit'], [99, 'near-limit'], [100, 'exhausted'], [120, 'exhausted']]) {
    assert.equal(quotaUsageState(value), state);
  }
});

test('sidebar requests happen only at mount, per refresh click, and for a different project', async () => {
  setLocale('en');
  const h = harness();
  const sidebar = createAgentQuotaSidebar(h.root, h.opts('/A'));
  assert.equal(h.calls.length, 0, 'creating the block must not fetch');

  sidebar.mount();
  sidebar.mount();
  assert.equal(h.calls.length, 1, 'startup fetches exactly once, even if mounted twice');
  assert.equal(h.calls[0].url, '/api/agent-quota');
  assert.equal(h.calls[0].options.headers['x-tipatask-project'], '/A');
  h.button.click();
  sidebar.syncLocale();
  assert.equal(h.calls.length, 1, 'clicking or re-rendering while a read is pending must not stack requests');
  await h.settle(0, payload('/A', 42));
  assert.match(h.body.innerHTML, /role="progressbar"/);

  // Electron re-sends project:changed on every window load and on rename.
  assert.equal(sidebar.reset('/A'), false);
  assert.equal(sidebar.reset(''), false);
  assert.equal(sidebar.reset(undefined), false);
  sidebar.syncLocale();
  assert.equal(h.calls.length, 1, 'same-project reset and locale sync must never fetch');

  h.button.click();
  assert.equal(h.calls.length, 2, 'a refresh click fetches once');
  h.button.click();
  assert.equal(h.calls.length, 2, 'clicking again while it loads is ignored');
  await h.settle(1, payload('/A', 43));

  h.button.click();
  assert.equal(sidebar.reset('/B'), true);
  assert.equal(h.calls.length, 4, 'a different project supersedes the pending refresh with one new read');
  assert.equal(h.calls[3].options.headers['x-tipatask-project'], '/B');
  // The superseded /A read settles late and must neither paint nor end the /B loading state.
  h.calls[2].resolve(response(payload('/A', 99)));
  await flush();
  assert.ok(h.has('loading'));
  assert.doesNotMatch(h.body.innerHTML, /role="progressbar"|99/);
  await h.settle(3, payload('/B', 55));
  assert.ok(!h.has('loading'));
  assert.match(h.body.innerHTML, /55% used/);
  assert.doesNotMatch(h.body.innerHTML, /99|43%/);
  sidebar.dispose();
});

test('loading fades the block and disables refresh; loaded flashes for 1600ms then clears', async () => {
  setLocale('en');
  const h = harness();
  const sidebar = createAgentQuotaSidebar(h.root, h.opts());
  sidebar.mount();
  assert.ok(h.has('loading'));
  assert.equal(h.attrs.get('aria-busy'), 'true');
  assert.equal(h.button.attrs.get('aria-disabled'), 'true');
  assert.equal(h.status.textContent, 'Updating…');
  assert.equal(h.title.textContent, 'Plan usage');
  assert.equal(h.button.attrs.get('aria-label'), 'Refresh plan usage');
  assert.equal(h.button.title, 'Refresh plan usage');
  assert.match(h.body.innerHTML, /aria-hidden="true"/, 'placeholder tracks while nothing has loaded');
  assert.doesNotMatch(h.body.innerHTML, /role="progressbar"/);

  await h.settle(0, payload('/A'));
  assert.ok(!h.has('loading'));
  assert.ok(h.has('loaded'));
  assert.equal(h.attrs.get('aria-busy'), 'false');
  assert.equal(h.button.attrs.get('aria-disabled'), 'false');
  assert.equal(h.status.textContent, 'Loaded');
  const loadedTimers = () => h.timers.filter(timer => timer.ms === 1600);
  assert.equal(loadedTimers().length, 1, 'one "Loaded" timer, at 1600ms');
  assert.match(h.button.title, /^Refresh plan usage · Updated \d{1,2}:\d{2}/);
  assert.equal(h.button.attrs.get('aria-label'), h.button.title);

  loadedTimers()[0].fn();
  assert.ok(!h.has('loaded'));
  assert.equal(h.status.textContent, '');

  // A new refresh cancels a still-pending "Loaded" timer instead of letting it clear the new state.
  h.button.click();
  await h.settle(1, payload('/A'));
  h.button.click();
  assert.equal(loadedTimers().length, 2);
  assert.equal(loadedTimers()[1].cleared, true);
  assert.ok(h.has('loading') && !h.has('loaded'));
  sidebar.dispose();
});

test('a failed read replaces the bars with a short message and never keeps old values', async () => {
  setLocale('en');
  const h = harness();
  const sidebar = createAgentQuotaSidebar(h.root, h.opts());
  sidebar.mount();
  await h.settle(0, payload('/A', 64));
  assert.match(h.body.innerHTML, /64% used/);

  h.button.click();
  await h.fail(1);
  assert.ok(!h.has('loading') && !h.has('loaded'));
  assert.match(h.body.innerHTML, /role="alert"/);
  assert.match(h.body.innerHTML, /Couldn't load usage/);
  assert.match(h.body.innerHTML, /Could not load subscription usage/);
  assert.doesNotMatch(h.body.innerHTML, /role="progressbar"|64/);
  assert.doesNotMatch(h.body.innerHTML, /secret|boom/);
  assert.equal(h.button.title, 'Refresh plan usage', 'a failed read must not advertise an update time');

  h.button.click();
  await h.settle(2, payload('/A', 10));
  assert.match(h.body.innerHTML, /10% used/, 'a later refresh recovers');
  sidebar.dispose();
});

test('sidebar body: one thin provider-coloured bar per window, caption inside, unknown usage never drawn as zero, fields escaped', () => {
  setLocale('en');
  const data = payload('/A', 120);
  data.agents.claude = agentWith('claude', [
    { id: 'five_hour', usagePercent: 120, resetAt: null, windowMinutes: 300 },
    { id: 'seven_day', usagePercent: null, resetAt: 'bad', windowMinutes: 10080 },
  ], { plan: '<img src=x onerror=alert(1)>' });
  const html = renderAgentQuotaSidebarBody({ data });
  assert.deepEqual(captions(html), ['Claude 5-hour | 120%', 'Claude 7-day | —', 'Codex 5-hour | 120%']);
  assert.match(html, /aria-valuenow="100"/);
  assert.match(html, /--fill:100%/);
  assert.match(html, /aria-valuetext="120% used · Limit reached"/);
  assert.match(html, /agent-quota-sidebar-row--claude/);
  assert.match(html, /agent-quota-sidebar-row--codex/);
  // Colour never encodes usage: no near-limit / exhausted variants, only the provider row class.
  assert.doesNotMatch(html, /--near-limit|--exhausted|--normal/);
  assert.equal((html.match(/role="progressbar"/g) || []).length, 2, 'the unknown 7-day window is not a progressbar');
  assert.match(html, /role="img" aria-label="Claude 7-day: Usage unavailable"/);
  assert.match(html, /agent-quota-sidebar-bar agent-quota-sidebar-bar--unavailable/);
  // The fill-clipped caption copy is decorative; only known bars get one.
  assert.equal((html.match(/agent-quota-sidebar-text--fill" aria-hidden="true"/g) || []).length, 2);
  assert.equal((html.match(/class="agent-quota-sidebar-fill"/g) || []).length, 2);
  // Every row is keyboard-focusable so :focus-visible can reveal its caption.
  assert.equal((html.match(/tabindex="0"/g) || []).length, 3);
  // Provider/plan, reset and recovery hint ride on the tooltip; user-controlled text is escaped.
  assert.match(html, /title="Claude Code · &lt;img/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /Reset time unavailable/);

  data.agents.claude = agentWith('claude', [], { status: 'unavailable', unavailableReason: 'credentials_expired' });
  data.agents.codex = null;
  const unavailable = renderAgentQuotaSidebarBody({ data });
  assert.deepEqual(captions(unavailable), ['Claude | —', 'Codex | —'], 'a provider with no windows shows its bare name');
  assert.doesNotMatch(unavailable, /role="progressbar"|120% used|0% used/);
  assert.match(unavailable, /Sign in again/);
  assert.match(unavailable, /refresh later/);
  assert.match(unavailable, /role="img" aria-label="Codex: Usage unavailable"/);
});

test('placeholder and failure tracks are inert: no caption, no hover growth, no progressbar', () => {
  setLocale('en');
  for (const html of [renderAgentQuotaSidebarBody(null), renderAgentQuotaSidebarBody({ error: 'request_failed' })]) {
    assert.doesNotMatch(html, /role="progressbar"|tabindex|agent-quota-sidebar-text/);
    assert.match(html, /agent-quota-sidebar-row--inert/);
  }
  assert.match(renderAgentQuotaSidebarBody({ error: 'request_failed' }), /role="alert"[^>]*>[\s\S]*Couldn't load usage/);
});

// The state a user sees at rest must tell "loading", "loaded 0%", "loaded value", "unavailable" and
// "failed" apart. Anything else lets a healthy 0% look identical to a block that never loaded.
const bars = html => [...html.matchAll(/<div class="(agent-quota-sidebar-bar[^"]*)">/g)].map(m => m[1]);

test('a loaded 0% is a known, tinted, empty track — distinct from loading, unavailable and failed (TPT341)', () => {
  setLocale('en');
  // The real 2026-09-24 payload: Claude 5-hour 0%, Claude 7-day 0%, Fable 7-day 0%, Codex 7-day 5%.
  const data = { projectRoot: '/A', agents: {
    claude: agentWith('claude', [
      { id: 'five_hour', usagePercent: 0, resetAt: '2026-09-24T20:00:00.000Z', windowMinutes: 300 },
      { id: 'seven_day', usagePercent: 0, resetAt: '2026-10-01T17:00:00.000Z', windowMinutes: 10080 },
      { id: 'seven_day_fable', usagePercent: 0, resetAt: '2026-10-01T17:00:00.000Z', windowMinutes: 10080 },
    ]),
    codex: agentWith('codex', [{ id: 'codex_primary', usagePercent: 5, resetAt: '2026-10-01T13:31:45.000Z', windowMinutes: 10080 }], { plan: 'prolite' }),
  } };
  const loaded = renderAgentQuotaSidebarBody({ data }, Date.UTC(2026, 8, 24, 19, 0));
  assert.deepEqual(captions(loaded), ['Claude 5-hour | 0% (1h)', 'Claude 7-day | 0% (6d 22h)', 'Fable 7-day | 0% (6d 22h)', 'Codex 7-day | 5% (6d 18h)']);
  assert.equal((loaded.match(/role="progressbar"/g) || []).length, 4, 'zero is a real measurement, so it is a progressbar');
  assert.equal((loaded.match(/aria-valuenow="0"/g) || []).length, 3);
  assert.match(loaded, /aria-valuetext="0% used"/);
  assert.deepEqual(bars(loaded), Array(4).fill('agent-quota-sidebar-bar agent-quota-sidebar-bar--known'));
  // Only the nonzero window draws a fill, at its own width; the zeros are an empty tinted track.
  assert.equal((loaded.match(/class="agent-quota-sidebar-fill"/g) || []).length, 1);
  assert.match(loaded, /agent-quota-sidebar-row--codex"[^>]*style="--fill:5%"/);
  assert.equal((loaded.match(/style="--fill:0%"/g) || []).length, 3);
  assert.doesNotMatch(loaded, /--unavailable|--pending|--inert/);

  const loading = renderAgentQuotaSidebarBody(null);
  assert.deepEqual(bars(loading), Array(3).fill('agent-quota-sidebar-bar'));
  assert.equal((loading.match(/agent-quota-sidebar-row--pending/g) || []).length, 3, 'placeholder rows pulse');
  assert.doesNotMatch(loading, /--known|--unavailable|class="agent-quota-sidebar-fill"/);

  const unavailable = renderAgentQuotaSidebarBody({ data: { projectRoot: '/A', agents: {
    claude: agentWith('claude', [{ id: 'five_hour', usagePercent: null, resetAt: null, windowMinutes: 300 }]),
    codex: agentWith('codex', [], { status: 'unavailable', connectionState: 'signed_out', unavailableReason: 'signed_out' }),
  } } });
  assert.deepEqual(bars(unavailable), Array(2).fill('agent-quota-sidebar-bar agent-quota-sidebar-bar--unavailable'));
  assert.doesNotMatch(unavailable, /--known|--pending|role="progressbar"|<strong>\d/);
  assert.equal((unavailable.match(/<strong>—<\/strong>/g) || []).length, 2, 'unknown usage shows a dash, never a number');

  const failed = renderAgentQuotaSidebarBody({ error: 'request_failed' });
  assert.deepEqual(bars(failed), ['agent-quota-sidebar-bar agent-quota-sidebar-bar--unavailable']);
  assert.doesNotMatch(failed, /--pending|--known/);

  // Four resting states, four different bar markups.
  assert.equal(new Set([bars(loaded)[0], bars(loading)[0], bars(unavailable)[0]]).size, 3);
});

test('nonzero usage renders on the initial load and on every refresh, for both providers (TPT341)', async () => {
  setLocale('en');
  const h = harness();
  const sidebar = createAgentQuotaSidebar(h.root, h.opts('/A'));
  const two = (claude, codex) => ({ projectRoot: '/A', agents: {
    claude: agentWith('claude', [{ id: 'five_hour', usagePercent: claude, resetAt: null, windowMinutes: 300 }]),
    codex: agentWith('codex', [{ id: 'codex_primary', usagePercent: codex, resetAt: null, windowMinutes: 10080 }]),
  } });
  const fills = () => [...h.body.innerHTML.matchAll(/agent-quota-sidebar-row--(claude|codex)" tabindex="0"[^>]*style="--fill:([\d.]+)%"/g)].map(m => `${m[1]}:${m[2]}`);

  sidebar.mount();
  assert.match(h.body.innerHTML, /agent-quota-sidebar-row--pending/, 'placeholder until the first read lands');
  await h.settle(0, two(37, 62));
  assert.deepEqual(fills(), ['claude:37', 'codex:62'], 'initial load paints both providers');
  assert.doesNotMatch(h.body.innerHTML, /--pending/);
  assert.equal((h.body.innerHTML.match(/class="agent-quota-sidebar-fill"/g) || []).length, 2);

  h.button.click();
  assert.equal(h.calls.length, 2);
  await h.settle(1, two(0, 5));
  assert.deepEqual(fills(), ['claude:0', 'codex:5'], 'refresh shows the new values, zero included');
  assert.equal((h.body.innerHTML.match(/class="agent-quota-sidebar-fill"/g) || []).length, 1);

  h.button.click();
  await h.settle(2, two(12.5, 88));
  assert.deepEqual(fills(), ['claude:12.5', 'codex:88']);
  assert.match(h.body.innerHTML, /12\.5% used/);
  assert.doesNotMatch(h.body.innerHTML, /--pending|role="alert"/);
  sidebar.dispose();
});

test('captions come from the window: provider/model name plus a duration derived from windowMinutes', () => {
  setLocale('en');
  const caption = (provider, window) => {
    const data = { projectRoot: '/A', agents: { claude: agentWith('claude', provider === 'claude' ? [window] : []), codex: agentWith('codex', provider === 'codex' ? [window] : []) } };
    return captions(renderAgentQuotaSidebarBody({ data })).find(line => !/^(Claude|Codex) \| —$/.test(line)).split(' | ')[0];
  };
  const w = (id, windowMinutes) => ({ id, usagePercent: 10, resetAt: null, ...(windowMinutes === undefined ? {} : { windowMinutes }) });
  // Claude: five_hour / seven_day are plain "Claude"; the opus window is shown as Fable (requested alias).
  assert.equal(caption('claude', w('five_hour', 300)), 'Claude 5-hour');
  assert.equal(caption('claude', w('seven_day', 10080)), 'Claude 7-day');
  assert.equal(caption('claude', w('seven_day_opus', 10080)), 'Fable 7-day');
  assert.equal(caption('claude', w('seven_day_sonnet', 10080)), 'Sonnet 7-day');
  assert.equal(caption('claude', w('seven_day_cowork', 10080)), 'Cowork 7-day');
  assert.equal(caption('claude', w('seven_day_oauth_apps', 10080)), 'OAuth apps 7-day');
  assert.equal(caption('claude', w('seven_day_futuremodel', 10080)), 'Futuremodel 7-day', 'unknown per-model windows are humanized, not hidden');
  // Claude ids encode their own duration when windowMinutes is missing.
  assert.equal(caption('claude', w('five_hour')), 'Claude 5-hour');
  assert.equal(caption('claude', w('seven_day_opus')), 'Fable 7-day');
  // Codex: the slot name says nothing about duration — a 10080-minute "primary" is a 7-day window.
  assert.equal(caption('codex', w('codex_primary', 10080)), 'Codex 7-day');
  assert.equal(caption('codex', w('codex_primary', 300)), 'Codex 5-hour');
  assert.equal(caption('codex', w('codex_secondary', 10080)), 'Codex 7-day');
  assert.equal(caption('codex', w('codex_bengalfox_primary', 300)), 'Codex Bengalfox 5-hour');
  assert.equal(caption('codex', w('codex_primary', 1440)), 'Codex 1-day');
  assert.equal(caption('codex', w('codex_primary', 90)), 'Codex 90 min');
  assert.equal(caption('codex', w('codex_primary')), 'Codex', 'no duration known -> just the name');
});

test('sidebar labels resolve in English and Ukrainian, and a locale switch re-renders without fetching', async () => {
  const h = harness();
  const data = payload('/A', 42);
  data.agents.claude.windows.push({ id: 'seven_day_oauth_apps', usagePercent: 5, resetAt: null, windowMinutes: 10080 });
  try {
    setLocale('uk');
    const sidebar = createAgentQuotaSidebar(h.root, h.opts());
    sidebar.mount();
    assert.equal(h.title.textContent, 'Використання плану');
    assert.equal(h.button.attrs.get('aria-label'), 'Оновити використання плану');
    assert.equal(h.status.textContent, 'Оновлення…');
    await h.settle(0, data);
    assert.equal(h.status.textContent, 'Завантажено');
    assert.deepEqual(captions(h.body.innerHTML), ['Claude · 5 год | 42%', 'Застосунки OAuth · 7 дн. | 5%', 'Codex · 5 год | 42%']);
    assert.match(h.body.innerHTML, /aria-valuetext="Використано 42%"/);
    assert.match(h.button.title, /^Оновити використання плану · Оновлено \d{1,2}:\d{2}/);

    setLocale('en');
    sidebar.syncLocale();
    assert.equal(h.title.textContent, 'Plan usage');
    assert.match(h.button.title, /^Refresh plan usage · Updated \d{1,2}:\d{2}/);
    assert.equal(h.status.textContent, 'Loaded');
    assert.deepEqual(captions(h.body.innerHTML), ['Claude 5-hour | 42%', 'OAuth apps 7-day | 5%', 'Codex 5-hour | 42%']);
    assert.equal(h.calls.length, 1);
    sidebar.dispose();
  } finally {
    setLocale('en');
  }
});

test('module entry points are inert before mount and idempotent per root afterwards', async () => {
  setLocale('en');
  assert.equal(resetAgentQuota('/A'), false);
  assert.equal(await refreshAgentQuota(), false);
  assert.doesNotThrow(() => syncAgentQuotaSidebarLocale());
  assert.equal(initializeAgentQuotaSidebar(null), null);

  const h = harness();
  const first = initializeAgentQuotaSidebar(h.root, h.opts('/A'));
  const second = initializeAgentQuotaSidebar(h.root, h.opts('/A'));
  assert.equal(first, second, 'the same panel root must not mount (and fetch) twice');
  assert.equal(h.calls.length, 1);
  await h.settle(0, payload('/A'));
  assert.equal(resetAgentQuota('/A'), false);
  const refreshed = refreshAgentQuota();
  assert.equal(h.calls.length, 2);
  await h.settle(1, payload('/A', 70));
  assert.equal(await refreshed, true);
  assert.equal(resetAgentQuota('/B'), true);
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].options.headers['x-tipatask-project'], '/B');

  // A rebuilt panel replaces (and disposes) the old instance.
  const rebuilt = harness();
  const third = initializeAgentQuotaSidebar(rebuilt.root, rebuilt.opts('/B'));
  assert.notEqual(third, first);
  assert.equal(rebuilt.calls.length, 1);
  await rebuilt.settle(0, payload('/B'));
  third.dispose();
});

test('template mounts the block once with the nav panel and resets it with the project dir', () => {
  const template = read('./template.html');
  assert.match(template, /onProjectChanged\(async \(dir, name\) => \{(?:\s*\/\/[^\n]*)*\s*resetAgentQuota\(dir\);/);
  assert.equal(template.split('initializeAgentQuotaSidebar(').length - 1, 1, 'exactly one mount call site');
  const block = template.indexOf('<section id="agent-quota-sidebar"');
  assert.ok(block > template.indexOf('id="active-sessions-list"'), 'block follows the main nav group');
  assert.ok(block < template.indexOf('<button id="left-nav-toggle"'), 'block sits above the collapse toggle');
  const appended = template.indexOf('document.body.appendChild(panel);', block);
  const mounted = template.indexOf('initializeAgentQuotaSidebar(panel.querySelector', block);
  assert.ok(appended > 0 && mounted > appended, 'mounted inside the build-once branch, after the panel is attached');
  assert.ok(mounted < template.indexOf("panel.querySelectorAll('.left-nav-btn[data-section]')", block));
  assert.doesNotMatch(template, /openAgentQuotaModal|onOpenAgentQuotaModal/);
  // (TPT381) The hover container is the whole section (bars + head), so the pointer can travel
  // from the bars to the button without the button hiding under it.
  const section = template.slice(block, template.indexOf('</section>', block));
  assert.match(section, /<section id="agent-quota-sidebar" class="[^"]*\bquota-bars\b[^"]*"/);
  assert.match(section, /<button type="button" class="[^"]*\bagent-quota-sidebar-refresh\b[^"]*\bquota-refresh-btn\b[^"]*"/);
});

test('the card-hover quota path is gone: no hover binding, modal, badge attrs, or modal CSS remain', () => {
  for (const file of ['./task-card.js', './task-board.js']) {
    assert.doesNotMatch(read(file), /agent-quota|AgentQuota|agent-badge--quota|quota\./, file);
  }
  assert.doesNotMatch(read('./agent-quota.js'), /pointerenter|mouseenter|bindAgentQuotaHover|openAgentQuotaModal/);
  const css = read('./styles.css');
  assert.doesNotMatch(css, /\.agent-quota-modal|\.agent-quota-overlay|agent-badge--quota/);
  const i18n = read('./i18n.js');
  assert.doesNotMatch(i18n, /"quota\.(title|refresh|badge|badgeLocked|plan|unknown|usage|duration|window\.[a-z_]+|connection\.[a-z_]+)"/);
});

test('block CSS: hidden when collapsed/mobile, hover only ever grows the single bar, provider colours only', () => {
  const css = read('./styles.css');
  assert.match(css, /body\.left-nav-collapsed \.agent-quota-sidebar\s*\{\s*display:\s*none/);
  assert.match(css, /@media \(max-width: 768px\)\s*\{\s*\.agent-quota-sidebar\s*\{\s*display:\s*none/);
  assert.match(css, /prefers-reduced-motion: reduce\)\s*\{[^}]*\.agent-quota-sidebar-bar/);
  const block = css.slice(css.indexOf('(TPT310) Agent plan usage'), css.indexOf('(C1144) Active agent sessions'));
  assert.ok(block.length > 1000, 'sidebar CSS block found');
  // Hovering the block itself only reveals the refresh button (TPT381); only a row's own hover/focus reveals a caption.
  assert.doesNotMatch(block, /\.agent-quota-sidebar:(?:hover|is\(|focus-within)/);
  assert.doesNotMatch(block, /\.quota-bars:hover\s+(?!\.quota-refresh-btn)/, 'block hover targets only the refresh button');
  // (TPT381) Refresh button: hidden at rest but still focusable, shown on block hover, keyboard focus and while loading.
  const hidden = block.match(/(?:^|\s)\.quota-refresh-btn\s*\{([^}]*)\}/)[1];
  assert.match(hidden, /opacity:\s*0\b/);
  assert.match(hidden, /pointer-events:\s*none/);
  assert.doesNotMatch(hidden, /display:|visibility:|transition:/, 'stays in tab order; base rule owns the fade');
  const reveal = block.match(/\.quota-bars:hover \.quota-refresh-btn,\s*\.quota-refresh-btn:focus-visible,\s*\.agent-quota-sidebar--loading \.quota-refresh-btn\s*\{([^}]*)\}/)[1];
  assert.match(reveal, /opacity:\s*1\b/);
  assert.match(reveal, /pointer-events:\s*auto/);
  assert.match(block, /@media \(hover: none\)\s*\{\s*\.quota-refresh-btn\s*\{[^}]*opacity:\s*1/);
  assert.match(block, /\.agent-quota-sidebar-refresh\s*\{[^}]*transition:[^;}]*opacity/);
  assert.doesNotMatch(block.match(/\.agent-quota-sidebar-refresh\s*\{([^}]*)\}/)[1], /opacity:\s*0?\.75/);
  assert.match(block, /\.agent-quota-sidebar-row:hover \.agent-quota-sidebar-bar,\s*\.agent-quota-sidebar-row:focus-visible \.agent-quota-sidebar-bar\s*\{\s*height:\s*16px/);
  assert.match(block, /\.agent-quota-sidebar-row:hover \.agent-quota-sidebar-text,\s*\.agent-quota-sidebar-row:focus-visible \.agent-quota-sidebar-text\s*\{\s*opacity:\s*1/);
  // Mouse wins over keyboard focus, so two grown (overlapping) bars can never be shown at once.
  assert.match(block, /\.agent-quota-sidebar-body:has\(\.agent-quota-sidebar-row:hover\) \.agent-quota-sidebar-row:not\(:hover\) \.agent-quota-sidebar-bar\s*\{\s*height:\s*3px/);
  // Fixed 12px rows, 3px bars: the grown bar never reaches a neighbour, so the block height is constant.
  assert.match(block, /\.agent-quota-sidebar-row\s*\{[^}]*height:\s*12px/);
  assert.match(block, /\.agent-quota-sidebar-bar\s*\{[^}]*height:\s*3px/);
  // Provider colours match the card badges; the fill always uses them.
  assert.match(block, /\.agent-quota-sidebar-row--claude\s*\{\s*--agent-quota-brand:\s*#d97757/);
  assert.match(block, /\.agent-quota-sidebar-row--codex\s*\{\s*--agent-quota-brand:\s*#10a37f/);
  assert.match(block, /\.agent-quota-sidebar-fill\s*\{[^}]*background:\s*var\(--agent-quota-brand\)/);
  // No card chrome (TPT341): the block is just bars + refresh button on the nav surface.
  const shell = block.match(/\.agent-quota-sidebar\s*\{([^}]*)\}/)[1];
  assert.doesNotMatch(shell, /(?:^|[\s;])(?:background|border|border-radius|box-shadow)\s*:/);
  // Resting states differ: a known value gets a provider-tinted track (so a real 0% is not the grey
  // placeholder), any nonzero fill has a visible minimum, and the placeholder pulses.
  assert.match(block, /\.agent-quota-sidebar-bar--known\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--agent-quota-brand\) \d+%, transparent\)/);
  assert.match(block, /\.agent-quota-sidebar-fill\s*\{[^}]*width:\s*max\(var\(--fill\),\s*3px\)/);
  assert.match(block, /\.agent-quota-sidebar-row--pending \.agent-quota-sidebar-bar\s*\{[^}]*animation:\s*agent-quota-pending/);
  assert.match(block, /prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.agent-quota-sidebar-row--pending \.agent-quota-sidebar-bar[^{}]*\{\s*animation:\s*none/);
  // No stripe, no usage-state colours (the only --c-danger is the request-failed message).
  assert.doesNotMatch(block, /border-left|--c-warning|near-limit|exhausted/);
  assert.equal((block.match(/--c-danger/g) || []).length, 1);
  // Caption legibility: the base layer is clipped to the empty track, the ink copy to the fill.
  assert.match(block, /\.agent-quota-sidebar-text\s*\{[^}]*clip-path:\s*inset\(0 0 0 var\(--fill\)\)/);
  assert.match(block, /\.agent-quota-sidebar-text--fill\s*\{[^}]*clip-path:\s*inset\(0 calc\(100% - var\(--fill\)\) 0 0\)/);
});

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const minute = 60000;

test('formatQuotaResetRemaining: days with leftover hours, else hours, else minutes; expired clamps to 0m; bad input omitted (TPT455/TPT520)', () => {
  setLocale('en');
  const at = ms => new Date(NOW + ms).toISOString();
  const f = ms => formatQuotaResetRemaining(at(ms), NOW);
  assert.equal(f(59000), '0m');
  assert.equal(f(minute), '1m');
  assert.equal(f(59 * minute + 59000), '59m');
  assert.equal(f(60 * minute), '1h');
  assert.equal(f(23 * 60 * minute + 59 * minute), '23h');
  assert.equal(f(24 * 60 * minute), '1d');
  assert.equal(f(1440 * minute + 59 * minute + 59000), '1d', 'a sub-hour leftover drops the hours part');
  assert.equal(f(1440 * minute + 60 * minute), '1d 1h');
  assert.equal(f(1440 * minute + 3 * 60 * minute), '1d 3h');
  assert.equal(f(1440 * minute + 3 * 60 * minute + 59 * minute), '1d 3h', 'minutes are floored away');
  assert.equal(f(2 * 1440 * minute), '2d', 'an exact day count has no hours part');
  assert.equal(f(2 * 1440 * minute + 59 * minute), '2d');
  assert.equal(f(6 * 1440 * minute + 23 * 60 * minute), '6d 23h');
  assert.equal(f(6 * 1440 * minute + 23 * 60 * minute + 59 * minute + 59000), '6d 23h');
  assert.equal(f(-5 * minute), '0m');
  assert.equal(f(-9 * 1440 * minute), '0m');
  for (const bad of [null, undefined, '', 'bad', 12345, {}]) assert.equal(formatQuotaResetRemaining(bad, NOW), null);
  try {
    setLocale('uk');
    assert.equal(f(2 * 1440 * minute), '2 дн');
    assert.equal(f(1440 * minute + 3 * 60 * minute), '1д 3г');
    assert.equal(f(5 * 60 * minute), '5 год');
    assert.equal(f(7 * minute), '7 хв');
  } finally {
    setLocale('en');
  }
});

test('countdown renders after the percentage in both caption layers, only for a valid reset (TPT455)', () => {
  setLocale('en');
  const data = { projectRoot: '/A', agents: {
    claude: agentWith('claude', [
      { id: 'five_hour', usagePercent: 58, resetAt: new Date(NOW + 1440 * minute + 5000).toISOString(), windowMinutes: 300 },
      { id: 'seven_day', usagePercent: 10, resetAt: 'bad', windowMinutes: 10080 },
      { id: 'seven_day_sonnet', usagePercent: 10, resetAt: null, windowMinutes: 10080 },
    ]),
    codex: agentWith('codex', [{ id: 'codex_primary', usagePercent: 3, resetAt: new Date(NOW - minute).toISOString(), windowMinutes: 10080 }]),
  } };
  const html = renderAgentQuotaSidebarBody({ data }, NOW);
  assert.deepEqual(captions(html), ['Claude 5-hour | 58% (1d)', 'Claude 7-day | 10%', 'Sonnet 7-day | 10%', 'Codex 7-day | 3% (0m)']);
  assert.equal((html.match(/agent-quota-sidebar-reset/g) || []).length, 4, 'two layers x two rows with a reset');
  assert.match(html, /58%<span class="agent-quota-sidebar-reset" data-reset-at="[^"]+"> \(1d\)<\/span>/);
});

test('countdown ticks locally each minute, never fetches, and stops with the view (TPT455)', async () => {
  setLocale('en');
  const h = harness();
  let clock = Date.UTC(2026, 8, 23, 21, 40, 20);
  const opts = { ...h.opts('/A'), now: () => clock };
  const sidebar = createAgentQuotaSidebar(h.root, opts);
  const withReset = (usage, ms) => ({ projectRoot: '/A', agents: {
    claude: agentWith('claude', [{ id: 'five_hour', usagePercent: usage, resetAt: new Date(clock + ms).toISOString(), windowMinutes: 300 }]),
    codex: agentWith('codex', []),
  } });
  sidebar.mount();
  await h.settle(0, withReset(40, 61 * minute));
  assert.match(captions(h.body.innerHTML)[0], /40% \(1h\)/);
  const tick = () => h.timers.filter(t => !t.cleared && t.ms !== 1600 && t.ms !== REFRESH_MS);
  const fire = timer => { timer.cleared = true; timer.fn(); };
  assert.equal(tick().length, 1);
  assert.equal(tick()[0].ms, minute - 20000, 'aligned to the wall-clock minute');

  clock += minute - 20000 + 2 * minute; // 21:43:00 — reset is at 22:41:20 -> 58m left
  fire(tick()[0]);
  assert.equal(h.calls.length, 1, 'ticking never fetches');
  const spans = h.body.querySelectorAll();
  assert.equal(spans.length, 2, 'both caption layers updated in place');
  assert.ok(spans.every(span => span.textContent === ' (58m)'), spans.map(span => span.textContent).join());
  assert.equal(tick().length, 1, 'next tick scheduled');
  assert.equal(tick()[0].ms, minute, 'already on the minute boundary');

  // A failed read removes the countdowns and stops the timer.
  h.button.click();
  await h.fail(1);
  assert.equal(tick().length, 0, 'tick timer stopped on failure');
  h.button.click();
  await h.settle(2, withReset(41, 5 * minute));
  assert.equal(tick().length, 1, 'a recovered read restarts it');
  sidebar.reset('/B');
  assert.equal(tick().length, 0, 'project reset stops it until data returns');
  sidebar.dispose();
});

test('light-theme caption ink: white on a deepened fill, dark themes untouched; AA in every light palette (TPT455)', () => {
  const css = read('./styles.css');
  assert.match(css, /\.agent-quota-sidebar-text--fill\s*\{\s*color:\s*#16160f/, 'dark-theme ink unchanged');
  assert.match(css, /html:not\(\.theme-dark\) \.agent-quota-sidebar-text--fill\s*\{\s*color:\s*#fff/);
  assert.match(css, /html:not\(\.theme-dark\) \.agent-quota-sidebar-row:is\(:hover, :focus-visible\) \.agent-quota-sidebar-fill\s*\{\s*background:\s*var\(--agent-quota-fill-deep\)/);
  const lum = hex => {
    const [r, g, b] = hex.match(/../g).map(c => { const v = parseInt(c, 16) / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const mix = (a, b, pct) => '' + [0, 2, 4].map(i => Math.round(parseInt(a.substr(i, 2), 16) * pct + parseInt(b.substr(i, 2), 16) * (1 - pct)).toString(16).padStart(2, '0')).join('');
  const dark = new Set([...read('./task-board.js').match(/_DARK_THEMES\s*=\s*new Set\(\[([^\]]*)\]\)/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]));
  const palettes = [...css.matchAll(/^\s*\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/gm)].filter(m => !dark.has(m[1]));
  assert.ok(palettes.length >= 10, 'light palettes found');
  for (const [, id, body] of palettes) {
    const text = /--c-text:\s*#([0-9a-f]{6})/i.exec(body)[1];
    const nav = /--c-nav-bg:\s*#([0-9a-f]{6})/i.exec(body)[1];
    for (const brand of ['d97757', '10a37f']) {
      assert.ok(ratio('ffffff', mix(brand, '000000', 0.7)) >= 4.5, `${id} ${brand} white on deep fill`);
      const track = mix(brand, nav, 0.32);
      assert.ok(ratio(text, track) >= 4.5, `${id} ${brand} text on track ${ratio(text, track).toFixed(2)}`);
    }
  }
});

// Timers still armed for the auto-refresh interval.
const autoTimers = h => h.timers.filter(timer => !timer.cleared && timer.ms === REFRESH_MS);
const fireTimer = timer => { timer.cleared = true; timer.fn(); };

test('auto-refresh reads every 5 minutes, re-arms after errors and resets, and stops on dispose (TPT521)', async () => {
  setLocale('en');
  assert.equal(REFRESH_MS, 300000);
  const h = harness();
  const sidebar = createAgentQuotaSidebar(h.root, h.opts('/A'));
  sidebar.mount();
  assert.equal(autoTimers(h).length, 0, 'nothing is armed while the first read is pending');
  await h.settle(0, payload('/A', 10));
  assert.equal(autoTimers(h).length, 1, 'armed after the first completed read');

  fireTimer(autoTimers(h)[0]);
  assert.equal(h.calls.length, 2, 'the interval reads once');
  assert.equal(h.calls[1].options.headers['x-tipatask-project'], '/A');
  assert.equal(autoTimers(h).length, 0, 'no second timer while that read is pending');
  await h.settle(1, payload('/A', 20));
  assert.match(h.body.innerHTML, /20% used/);
  assert.equal(autoTimers(h).length, 1, 're-armed after success');

  fireTimer(autoTimers(h)[0]);
  assert.equal(h.calls.length, 3);
  await h.fail(2);
  assert.match(h.body.innerHTML, /role="alert"/);
  assert.equal(autoTimers(h).length, 1, 're-armed after an error');

  // A manual refresh cancels the pending interval, so the click never stacks a second read.
  const armed = autoTimers(h)[0];
  h.button.click();
  assert.equal(armed.cleared, true);
  assert.equal(h.calls.length, 4);
  armed.fn();
  assert.equal(h.calls.length, 4, 'a cleared interval firing late does not read while one is pending');
  await h.settle(3, payload('/A', 30));
  assert.equal(autoTimers(h).length, 1);

  // A different project drops the old interval; the new project's read re-arms it.
  const before = autoTimers(h)[0];
  assert.equal(sidebar.reset('/B'), true);
  assert.equal(before.cleared, true);
  assert.equal(autoTimers(h).length, 0);
  assert.equal(h.calls.length, 5);
  await h.settle(4, payload('/B', 40));
  assert.equal(autoTimers(h).length, 1, 're-armed for the new project');
  fireTimer(autoTimers(h)[0]);
  assert.equal(h.calls[5].options.headers['x-tipatask-project'], '/B');
  await h.settle(5, payload('/B', 41));

  const last = autoTimers(h)[0];
  sidebar.dispose();
  assert.equal(last.cleared, true);
  assert.equal(autoTimers(h).length, 0, 'dispose clears the interval');
  last.fn();
  h.doc.fire();
  assert.equal(h.calls.length, 6, 'no reads after dispose');
});

test('auto-refresh never fetches while hidden and catches up once on becoming visible (TPT521)', async () => {
  setLocale('en');
  const h = harness();
  const sidebar = createAgentQuotaSidebar(h.root, h.opts('/A'));
  sidebar.mount();
  assert.equal(h.doc.listeners.size, 1);
  await h.settle(0, payload('/A', 10));

  h.doc.fire();
  assert.equal(h.calls.length, 1, 'becoming visible before the interval elapsed does not read');

  h.doc.hidden = true;
  fireTimer(autoTimers(h)[0]);
  assert.equal(h.calls.length, 1, 'no read while hidden');
  assert.equal(autoTimers(h).length, 0, 'and no re-arm while hidden');
  h.doc.fire();
  assert.equal(h.calls.length, 1, 'a visibilitychange that stays hidden does not read');

  h.doc.hidden = false;
  h.doc.fire();
  assert.equal(h.calls.length, 2, 'the due read runs on becoming visible');
  h.doc.fire();
  assert.equal(h.calls.length, 2, 'only once');
  await h.settle(1, payload('/A', 20));
  assert.equal(autoTimers(h).length, 1, 'interval restarts from the catch-up read');

  // A manual read while hidden-and-due satisfies the due read.
  h.doc.hidden = true;
  fireTimer(autoTimers(h)[0]);
  h.button.click();
  assert.equal(h.calls.length, 3);
  await h.settle(2, payload('/A', 30));
  h.doc.hidden = false;
  h.doc.fire();
  assert.equal(h.calls.length, 3, 'a manual read clears the pending catch-up');

  sidebar.dispose();
  assert.equal(h.doc.listeners.size, 0, 'dispose removes the visibility listener');
});
