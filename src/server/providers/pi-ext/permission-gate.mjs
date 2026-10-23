// Loaded only by task terminals with an explicit permission policy.
export default function permissionGate(pi) {
  async function check(event) {
    const url = process.env.TIPATASK_PERMISSION_URL;
    if (!/^http:\/\/127\.0\.0\.1:\d+\/check$/.test(url || '')) throw new Error('Permission gate unavailable');
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TIPATASK_PERMISSION_TOKEN || ''}` },
      body: JSON.stringify(event), signal: AbortSignal.timeout(610000),
    });
    if (!response.ok) throw new Error('Permission gate unavailable');
    return response.json();
  }
  pi.on('session_start', async () => {
    await check({ hook_event_name: 'SessionStart' });
    pi.setActiveTools([...new Set([...pi.getActiveTools(), 'grep', 'find', 'ls'])]);
  });
  pi.on('tool_call', async event => {
    try {
      const result = await check({ hook_event_name: 'PreToolUse', tool_name: event.toolName, tool_input: event.input });
      if (result?.hookSpecificOutput?.permissionDecision === 'allow') return;
      return { block: true, reason: result?.hookSpecificOutput?.permissionDecisionReason || 'Permission denied.' };
    } catch {
      return { block: true, reason: 'Permission gate unavailable. Action blocked.' };
    }
  });
}
