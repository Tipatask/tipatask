'use strict';

// Puts the Pi task-chat extension (providers/pi-ext/) where the Pi CLI can load it. In a
// packaged build the sources live inside app.asar, which a separately spawned CLI cannot be
// relied on to read, so both files are copied to USER_DATA_ROOT/pi-ext/ and Pi is pointed at
// the copy. Same idea as mcp-spawn-config.js: derived, app-owned, never inside the project.
// The MCP bridge extension (pi-ext/mcp-bridge.mjs) is staged next to them from its esbuild
// bundle (build.js bundlePiExt()), which carries the MCP SDK inline.

const fs = require('node:fs');
const path = require('node:path');

const SOURCE_DIR = path.join(__dirname, 'pi-ext');
const FILES = ['task-tools.mjs', 'tipatask-request.cjs', 'live-credentials.cjs'];
const ENTRY = 'task-tools.mjs';
const BRIDGE_FILE = 'mcp-bridge.mjs';
const BRIDGE_SOURCE = path.join(__dirname, '..', '..', '..', 'dist', 'pi-ext', BRIDGE_FILE);

function stageFile(source, target) {
  const content = fs.readFileSync(source, 'utf8');
  try { if (fs.readFileSync(target, 'utf8') === content) return; } catch { /* absent */ }
  const tmp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}

let warnedMissingBridge = false;

// Best-effort: an unbuilt checkout has no bundle, and task chat must not depend on the bridge.
function stageMcpBridge(dir, bridgeSource) {
  if (!fs.existsSync(bridgeSource)) {
    if (!warnedMissingBridge) console.warn(`[pi-task-tools] MCP bridge bundle missing at ${bridgeSource} — run the build`);
    warnedMissingBridge = true;
    return;
  }
  try {
    stageFile(bridgeSource, path.join(dir, BRIDGE_FILE));
  } catch (err) {
    console.warn(`[pi-task-tools] could not stage the MCP bridge extension: ${err.message}`);
  }
}

// Returns the absolute path of the copied extension entry, or null when it cannot be written —
// the caller must then refuse the turn rather than run Pi without its only task tool.
function materializePiTaskTools(userDataRoot, { bridgeSource = BRIDGE_SOURCE } = {}) {
  if (!userDataRoot) return null;
  const dir = path.join(userDataRoot, 'pi-ext');
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of FILES) stageFile(path.join(SOURCE_DIR, name), path.join(dir, name));
  } catch (err) {
    console.warn(`[pi-task-tools] could not stage the task-chat extension: ${err.message}`);
    return null;
  }
  stageMcpBridge(dir, bridgeSource);
  return path.join(dir, ENTRY);
}

// Stages only the MCP bridge (Pi task terminals load it without the task-chat extension) and
// returns its path, or null when the bundle is missing or cannot be written.
function stagePiMcpBridge(userDataRoot, { bridgeSource = BRIDGE_SOURCE } = {}) {
  if (!userDataRoot) return null;
  const dir = path.join(userDataRoot, 'pi-ext');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.warn(`[pi-task-tools] could not create ${dir}: ${err.message}`);
    return null;
  }
  stageMcpBridge(dir, bridgeSource);
  return piMcpBridgePath(userDataRoot);
}

// Derived Pi `.mcp.json` first (mcp-spawn-config.js writeScopedMcpConfig, caller 'pi': null when
// the project has none, no API target, or an unbound `tipatask` auth header), then the staged
// bridge bundle. Returns { extensionPath, configPath }, or null when either is missing — the
// caller then falls back to the REST tool / prompt recipe. Shared by the Pi task terminal and
// the headless Pi objective and task-chat turns, so all three agree on bridge availability.
function resolvePiMcpBridge({ projectRoot, userDataRoot, bridgeSource = BRIDGE_SOURCE } = {}) {
  if (!projectRoot || !userDataRoot) return null;
  const { writeScopedMcpConfig } = require('../mcp-spawn-config');
  const configPath = writeScopedMcpConfig({ projectRoot, userDataRoot, caller: 'pi' });
  if (!configPath) return null;
  const extensionPath = stagePiMcpBridge(userDataRoot, { bridgeSource });
  return extensionPath ? { extensionPath, configPath } : null;
}

// Absolute path of the staged MCP bridge extension, or null when it has not been staged.
function piMcpBridgePath(userDataRoot) {
  if (!userDataRoot) return null;
  const target = path.join(userDataRoot, 'pi-ext', BRIDGE_FILE);
  return fs.existsSync(target) ? target : null;
}

module.exports = {
  materializePiTaskTools, stagePiMcpBridge, piMcpBridgePath, resolvePiMcpBridge, SOURCE_DIR, FILES, ENTRY, BRIDGE_FILE, BRIDGE_SOURCE,
};
