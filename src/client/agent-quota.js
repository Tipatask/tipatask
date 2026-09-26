import { t, getLocale } from './i18n.js';
import { escapeAttr, projectHeader } from './utils.js';

// Abort is an optimization; generation and scope checks also protect against late
// responses from transports that ignore cancellation, including A -> B -> A.
export function createQuotaLoader(getScope, fetchImpl = (...args) => fetch(...args)) {
  let generation = 0;
  let controller = null;
  function invalidate() {
    generation++;
    controller?.abort();
    controller = null;
  }
  async function read(headers) {
    invalidate();
    const version = generation;
    const scope = getScope();
    const request = controller = new AbortController();
    const timeout = setTimeout(() => request.abort(), 25000);
    const current = () => version === generation && scope === getScope();
    try {
      const response = await fetchImpl('/api/agent-quota', {
        headers, cache: 'no-store', signal: request.signal,
      });
      if (!response.ok) throw new Error('request_failed');
      const data = await response.json();
      if (!current()) return null;
      const expected = headers['x-tipatask-project'];
      if (!data || typeof data.projectRoot !== 'string' || !data.projectRoot
        || (expected && data.projectRoot !== expected) || !data.agents) throw new Error('invalid_response');
      for (const provider of ['claude', 'codex']) {
        const agent = data.agents[provider];
        if (agent && (agent.provider !== provider || agent.projectRoot !== data.projectRoot)) throw new Error('invalid_response');
      }
      return { data };
    } catch {
      return current() ? { error: 'request_failed' } : null;
    } finally {
      clearTimeout(timeout);
      if (controller === request) controller = null;
    }
  }
  return { read, invalidate };
}

export function quotaUsageState(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'unavailable';
  return value >= 100 ? 'exhausted' : value >= 80 ? 'near-limit' : 'normal';
}

const REASONS = new Set(['unsupported_provider', 'unsupported_auth', 'signed_out', 'cli_missing',
  'credentials_unavailable', 'credentials_expired', 'access_denied', 'rate_limited',
  'timeout', 'provider_error', 'invalid_response', 'quota_unavailable', 'request_failed']);
const CONNECTIONS = new Set(['connected', 'signed_out', 'unsupported', 'unknown']);
const PROVIDERS = ['claude', 'codex'];
// Tooltip / group name vs. the shorter prefix used in bar captions ("Claude 7-day").
const PROVIDER_NAMES = { claude: 'Claude Code', codex: 'Codex' };
const PROVIDER_LABELS = { claude: 'Claude', codex: 'Codex' };
// Per-model weekly windows of the Claude usage API (`seven_day_<model>`), by model. Product
// names, so not translated. The plan sells the `seven_day_opus` window as Fable — an explicit
// alias requested for the sidebar; the upstream key is still `seven_day_opus`.
const CLAUDE_MODEL_NAMES = { opus: 'Fable', fable: 'Fable', sonnet: 'Sonnet', cowork: 'Cowork' };
// How long the "Loaded" confirmation stays up after a successful refresh.
const LOADED_MS = 1600;

function humanize(key) {
  return String(key).split(/[_\s-]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
}

// Duration comes from the window itself: Codex's "primary" slot is a 7-day window on some
// plans, so the slot name says nothing. Falls back to the Claude ids, which encode it.
function windowMinutesOf(window) {
  if (Number.isFinite(window.windowMinutes) && window.windowMinutes > 0) return window.windowMinutes;
  if (/^five_hour/.test(window.id)) return 300;
  if (/^seven_day/.test(window.id)) return 10080;
  return null;
}

function windowName(provider, window) {
  const id = String(window.id || '');
  if (provider === 'claude') {
    const model = id.replace(/^(five_hour|seven_day)_?/, '');
    if (!model) return PROVIDER_LABELS.claude;
    return model === 'oauth_apps' ? t('agentQuotaSidebar.name.oauthApps') : (CLAUDE_MODEL_NAMES[model] || humanize(model));
  }
  // Codex ids are `${bucket}_${primary|secondary}`; the default bucket is plain "codex".
  const bucket = id.replace(/_(primary|secondary)$/, '');
  return !bucket || bucket === 'codex' ? PROVIDER_LABELS.codex : humanize(bucket);
}

// "Claude 5-hour", "Claude 7-day", "Fable 7-day", "Codex 7-day". A provider with no windows
// (signed out, unsupported) gets its bare name.
function windowCaption(provider, window) {
  if (!window) return PROVIDER_LABELS[provider];
  const name = windowName(provider, window);
  const minutes = windowMinutesOf(window);
  if (!minutes) return name;
  if (minutes % 1440 === 0) return t('agentQuotaSidebar.window.days', { name, n: minutes / 1440 });
  if (minutes % 60 === 0) return t('agentQuotaSidebar.window.hours', { name, n: minutes / 60 });
  return t('agentQuotaSidebar.window.minutes', { name, n: minutes });
}

function resetLabel(value) {
  const time = typeof value === 'string' && value ? new Date(value) : null;
  return time && Number.isFinite(time.getTime())
    ? t('quota.resets', { time: time.toLocaleString(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }) })
    : t('quota.resetUnknown');
}

// One thin bar per usage window, always in the provider colour. The caption (label left,
// percent right) lives INSIDE the bar and only shows while that bar is hovered/focused — the
// bar grows over its own row spacing, so nothing else moves. It is drawn twice: a base layer
// for the empty track and a dark-ink copy clipped to the fill, so it stays legible on both.
// Provider/plan, reset time and recovery guidance go in the row's tooltip.
//
// Four states must stay visually distinct at rest: still loading (neutral pulsing placeholder,
// emptyRow), a known value (`--known`: provider-tinted track, fill only when usage > 0 — so a true
// 0% is an empty tinted track, never confused with "nothing loaded yet"), unavailable (dashed
// outline) and a failed read (renderAgentQuotaSidebarBody's inert dashed row).
function renderRow(provider, agent, window, unavailable, hint) {
  const state = !window || unavailable ? 'unavailable' : quotaUsageState(window.usagePercent);
  const known = state !== 'unavailable';
  const label = windowCaption(provider, window);
  const percent = known ? new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }).format(window.usagePercent) : '';
  const used = known ? t('quota.used', { percent }) : t('quota.unavailable');
  const width = known ? Math.min(100, window.usagePercent) : 0;
  const filled = known && width > 0;
  const tip = [`${PROVIDER_NAMES[provider]}${agent?.plan ? ` · ${agent.plan}` : ''}`, known ? resetLabel(window.resetAt) : hint].filter(Boolean).join('\n');
  // Near-limit / exhausted are deliberately not colours — only announced to assistive tech.
  const valueText = known && state !== 'normal' ? `${used} · ${t(`quota.state.${state}`)}` : used;
  const text = `<span>${escapeAttr(label)}</span><strong>${known ? escapeAttr(`${percent}%`) : '—'}</strong>`;
  const semantics = known
    ? `role="progressbar" aria-label="${escapeAttr(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${width}" aria-valuetext="${escapeAttr(valueText)}"`
    : `role="img" aria-label="${escapeAttr(`${label}: ${used}`)}"`;
  return `<div class="agent-quota-sidebar-row agent-quota-sidebar-row--${provider}" tabindex="0" ${semantics} title="${escapeAttr(tip)}" style="--fill:${width}%">
    <div class="agent-quota-sidebar-bar${known ? ' agent-quota-sidebar-bar--known' : ' agent-quota-sidebar-bar--unavailable'}">${filled ? '<span class="agent-quota-sidebar-fill"></span>' : ''}<span class="agent-quota-sidebar-text">${text}</span>${known ? `<span class="agent-quota-sidebar-text agent-quota-sidebar-text--fill" aria-hidden="true">${text}</span>` : ''}</div>
  </div>`;
}

function renderProvider(provider, agent) {
  const name = PROVIDER_NAMES[provider];
  const connection = CONNECTIONS.has(agent?.connectionState) ? agent.connectionState : 'unknown';
  const windows = Array.isArray(agent?.windows) ? agent.windows.filter(w => w && typeof w === 'object') : [];
  const unavailable = !agent || agent.status === 'unavailable' || connection !== 'connected';
  const reason = REASONS.has(agent?.unavailableReason) ? agent.unavailableReason : 'quota_unavailable';
  const partial = unavailable || !windows.length || windows.some(w => quotaUsageState(w.usagePercent) === 'unavailable');
  const hint = partial ? t(`quota.reason.${reason}`, { provider: name }) : '';
  const rows = (windows.length ? windows : [null]).map(window => renderRow(provider, agent, window, unavailable, hint)).join('');
  return `<div class="agent-quota-sidebar-group" role="group" aria-label="${name}">${rows}</div>`;
}

// Non-interactive tracks (no caption, no hover growth) for the not-yet-loaded state. `--pending`
// pulses the neutral track, so "still loading" never looks like a loaded 0%.
const emptyRow = provider => `<div class="agent-quota-sidebar-row agent-quota-sidebar-row--${provider} agent-quota-sidebar-row--inert agent-quota-sidebar-row--pending"><div class="agent-quota-sidebar-bar"></div></div>`;

// Shaped like the common case (Claude 5-hour + 7-day, one Codex window) so the block doesn't jump
// when the first read lands.
const PLACEHOLDER_ROWS = { claude: 2, codex: 1 };

function renderPlaceholder() {
  return PROVIDERS.map(provider => `<div class="agent-quota-sidebar-group" aria-hidden="true">${emptyRow(provider).repeat(PLACEHOLDER_ROWS[provider])}</div>`).join('');
}

// Pure: `result` is a createQuotaLoader().read() result. `null` = nothing loaded yet.
export function renderAgentQuotaSidebarBody(result) {
  if (!result) return renderPlaceholder();
  if (result.error) {
    // Never keep the previous values on screen next to a failure.
    return `<div class="agent-quota-sidebar-failed" role="alert" title="${escapeAttr(t('quota.reason.request_failed'))}">
      <div class="agent-quota-sidebar-row agent-quota-sidebar-row--inert" aria-hidden="true"><div class="agent-quota-sidebar-bar agent-quota-sidebar-bar--unavailable"></div></div>
      <p>${escapeAttr(t('agentQuotaSidebar.failed'))}</p>
    </div>`;
  }
  const agents = result.data?.agents || {};
  return PROVIDERS.map(provider => renderProvider(provider, agents[provider])).join('');
}

// Left-nav plan-usage block lifecycle. Requests happen ONLY from mount() (startup), from a
// click on the refresh control, and when reset() is handed a *different* project — never
// from hover, render passes, focus or timers. The loader scope is the sidebar's own
// epoch:project, not location.search: onProjectChanged rewrites the URL after it resets us.
export function createAgentQuotaSidebar(root, opts = {}) {
  const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer || (id => clearTimeout(id));
  const now = opts.now || (() => Date.now());
  const els = {
    body: root.querySelector('.agent-quota-sidebar-body'),
    status: root.querySelector('.agent-quota-sidebar-status'),
    title: root.querySelector('.agent-quota-sidebar-title'),
    button: root.querySelector('.agent-quota-sidebar-refresh'),
  };
  let project = typeof opts.projectPath === 'string' ? opts.projectPath : (projectHeader()['x-tipatask-project'] || '');
  let epoch = 0;
  let loading = false;
  let loaded = false;
  let view = null;
  let checkedAt = null;
  let loadedTimer = null;
  let renderedLocale = null;
  let mounted = false;
  let disposed = false;
  const loader = createQuotaLoader(() => `${epoch}:${project}`, opts.fetchImpl);

  function paintState() {
    root.classList.toggle('agent-quota-sidebar--loading', loading);
    root.classList.toggle('agent-quota-sidebar--loaded', loaded && !loading);
    root.setAttribute('aria-busy', loading ? 'true' : 'false');
    els.button?.setAttribute('aria-disabled', loading ? 'true' : 'false');
    if (els.status) els.status.textContent = loading ? t('agentQuotaSidebar.loading') : loaded ? t('agentQuotaSidebar.loaded') : '';
  }

  function paintBody() {
    if (els.body) els.body.innerHTML = renderAgentQuotaSidebarBody(view);
  }

  // The refresh control's tooltip / accessible name also carries when the numbers were read.
  function paintButton() {
    if (!els.button) return;
    const at = view && !view.error && checkedAt != null ? new Date(checkedAt) : null;
    const time = at && Number.isFinite(at.getTime()) ? at.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' }) : '';
    const label = `${t('agentQuotaSidebar.refresh')}${time ? ` · ${t('agentQuotaSidebar.updatedAt', { time })}` : ''}`;
    els.button.setAttribute('aria-label', label);
    els.button.title = label;
  }

  async function refresh() {
    if (disposed || loading) return false;
    loading = true;
    loaded = false;
    clearTimer(loadedTimer);
    loadedTimer = null;
    paintState();
    const token = epoch;
    const result = await loader.read(project ? { 'x-tipatask-project': project } : {});
    // A reset()/dispose() during the read owns the state now; this response is stale.
    if (disposed || token !== epoch) return false;
    loading = false;
    if (result) {
      view = result;
      checkedAt = now();
      paintBody();
      paintButton();
      if (!result.error) {
        loaded = true;
        loadedTimer = setTimer(() => {
          loadedTimer = null;
          loaded = false;
          paintState();
        }, LOADED_MS);
      }
    }
    paintState();
    return Boolean(result && !result.error);
  }

  // Same project (Electron re-sends project:changed on every load and on rename) is a no-op.
  function reset(nextProject) {
    if (disposed || !nextProject || nextProject === project) return false;
    project = nextProject;
    epoch++;
    loader.invalidate();
    clearTimer(loadedTimer);
    loadedTimer = null;
    loading = false;
    loaded = false;
    view = null;
    checkedAt = null;
    paintBody();
    paintButton();
    void refresh();
    return true;
  }

  function syncLocale() {
    const locale = getLocale();
    if (locale === renderedLocale) return;
    renderedLocale = locale;
    if (els.title) els.title.textContent = t('agentQuotaSidebar.title');
    paintButton();
    paintState();
    paintBody();
  }

  function mount() {
    if (mounted || disposed) return;
    mounted = true;
    els.button?.addEventListener('click', event => {
      event?.preventDefault?.();
      void refresh();
    });
    syncLocale();
    void refresh();
  }

  function dispose() {
    disposed = true;
    epoch++;
    loader.invalidate();
    clearTimer(loadedTimer);
    loadedTimer = null;
  }

  return { root, mount, refresh, reset, syncLocale, dispose };
}

let sidebar = null;

// Idempotent per root: syncLeftNavPanel() only builds the panel once, so this is the single
// startup fetch. A different root (panel rebuilt) replaces and disposes the old instance.
export function initializeAgentQuotaSidebar(root, opts) {
  if (!root) return null;
  if (sidebar?.root === root) return sidebar;
  sidebar?.dispose();
  sidebar = createAgentQuotaSidebar(root, opts);
  sidebar.mount();
  return sidebar;
}

export function refreshAgentQuota() {
  return sidebar ? sidebar.refresh() : Promise.resolve(false);
}

export function resetAgentQuota(projectPath) {
  return sidebar ? sidebar.reset(projectPath) : false;
}

export function syncAgentQuotaSidebarLocale() {
  sidebar?.syncLocale();
}
