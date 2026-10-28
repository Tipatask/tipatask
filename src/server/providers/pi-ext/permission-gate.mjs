// Loaded by every gated Pi task terminal, whatever its permission mode. Each tool call asks the
// Task App's per-run loopback gate, which answers from the session's confirmed live mode, so a
// live mode switch applies at the next tool call. The input hook reports a submitted mode-switch
// directive back to the gate: that report is the provider's confirmation of the switch.

// First sentence of BaseTaskAgent#buildModeSwitchDirective() (base-agent.js).
export const MODE_SWITCH_MARKER = /\bThe user selected (auto|bypass) for this session\./;

export function switchDirectiveMode(text) {
  const match = typeof text === 'string' ? text.match(MODE_SWITCH_MARKER) : null;
  return match ? match[1] : null;
}

// Fails closed: only an explicit allow runs the tool; an unknown or missing decision blocks.
// `hookSpecificOutput` is the older gate answer shape.
export function toolCallResult(result) {
  const decision = result?.decision
    ?? (result?.hookSpecificOutput?.permissionDecision === 'allow' ? 'allow' : 'deny');
  if (decision === 'allow') return undefined;
  return { block: true, reason: result?.reason || result?.hookSpecificOutput?.permissionDecisionReason || 'Permission denied.' };
}

export default function permissionGate(pi) {
  async function check(event, signal) {
    const url = process.env.TIPATASK_PERMISSION_URL;
    if (!/^http:\/\/127\.0\.0\.1:\d+\/check$/.test(url || '')) throw new Error('Permission gate unavailable');
    // An approval can wait up to the gate's own 10-minute expiry; Esc (the turn's signal) ends it sooner.
    const deadline = AbortSignal.timeout(610000);
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TIPATASK_PERMISSION_TOKEN || ''}` },
      body: JSON.stringify(event),
      signal: signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([deadline, signal]) : deadline,
    });
    if (!response.ok) throw new Error('Permission gate unavailable');
    return response.json();
  }
  pi.on('session_start', async () => {
    await check({ hook_event_name: 'SessionStart' });
    pi.setActiveTools([...new Set([...pi.getActiveTools(), 'grep', 'find', 'ls'])]);
  });
  pi.on('tool_call', async (event, ctx) => {
    try {
      return toolCallResult(await check({ hook_event_name: 'PreToolUse', tool_name: event.toolName, tool_input: event.input }, ctx?.signal));
    } catch {
      return { block: true, reason: ctx?.signal?.aborted ? 'Action canceled.' : 'Permission gate unavailable. Action blocked.' };
    }
  });
  pi.on('input', async event => {
    const mode = switchDirectiveMode(event?.text);
    if (!mode) return;
    // Never holds up the input: an unreported switch times out and keeps its last confirmed mode.
    try { await check({ hook_event_name: 'UserPromptSubmit', permission_mode: mode }, AbortSignal.timeout(5000)); } catch { /* see above */ }
  });
}
