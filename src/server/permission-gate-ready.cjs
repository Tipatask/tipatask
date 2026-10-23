'use strict';

// Claude SessionStart only accepts command hooks. PreToolUse uses the blocking
// HTTP hook; this handshake prevents prompt delivery if hooks failed to load.
const [url, token] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+\/check$/.test(url || '') || !/^[a-f0-9]{64}$/.test(token || '')) process.exit(1);
fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ hook_event_name: 'SessionStart' }), signal: AbortSignal.timeout(10000),
}).then(response => { if (!response.ok) process.exitCode = 1; }).catch(() => { process.exitCode = 1; });
