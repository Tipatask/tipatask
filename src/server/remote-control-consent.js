'use strict';

// Local authority, never a project preference. No credentials are persisted here.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const accounts = require('./account-store');
const { MACHINE_ID_PATH } = require('./device-identity');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);

function createRemoteControlConsent(options = {}) {
  const dataRoot = () => path.resolve(options.userDataRoot || process.env.TIPATASK_USER_DATA
    || path.join(os.homedir(), '.tipatask', 'local-state'));
  const directory = () => path.join(dataRoot(), 'remote-control');
  const readConfig = options.readConfig || (root => require('./project-config').readProjectConfig(root));
  const readAccount = options.readAccount || (base => accounts.readAccount(base, options));

  function scope(projectRoot) {
    const checkout = fs.realpathSync(projectRoot);
    const installation = fs.realpathSync(dataRoot());
    // Development defaults must not put authority in a checkout or source export.
    if (inside(checkout, installation) || inside(fs.realpathSync(path.resolve(__dirname, '../..')), installation)) {
      throw new Error('Remote control requires app data outside the checkout');
    }
    const cfg = readConfig(checkout);
    const base = accounts.normalizeBaseUrl(cfg?.API_BASE_URL);
    const url = new URL(base);
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid server');
    const projectId = Number(cfg?.API_PROJECT_ID);
    const account = readAccount(base);
    const claims = accounts.decodeTokenPayload(account?.token);
    const userId = Number(claims?.id);
    if (!Number.isSafeInteger(projectId) || projectId <= 0 || !Number.isSafeInteger(userId) || userId <= 0
      || !Number.isFinite(claims?.exp) || claims.exp * 1000 <= Date.now()
      || (account.userId != null && Number(account.userId) !== userId)
      || (claims.project_id != null && Number(claims.project_id) !== projectId)) throw new Error('Sign in required');
    const machine = fs.readFileSync(options.machineIdPath || MACHINE_ID_PATH, 'utf8').trim();
    if (!machine) throw new Error('Device identity unavailable');
    const identity = root => {
      const stat = fs.statSync(root, { bigint: true });
      return [root, String(stat.dev), String(stat.ino), String(stat.birthtimeNs)];
    };
    const context = hash([identity(installation), machine, base, userId, account.consentEpoch || null,
      projectId, identity(checkout)]);
    return { context, cfg, file: path.join(directory(), hash(checkout) + '.json') };
  }

  function record(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  function read(projectRoot) {
    try {
      const current = scope(projectRoot);
      const saved = record(current.file);
      const matches = saved?.version === 1 && saved.context === current.context && typeof saved.revision === 'string';
      const enabled = matches && saved.enabled === true;
      return { available: true, enabled, context: hash([current.context, saved?.revision || null]),
        grant: enabled ? hash([current.context, saved.revision]) : null,
        migrationRequired: !matches && current.cfg.REMOTE_CONTROL_ENABLED === true };
    } catch {
      let legacy = false;
      try { legacy = readConfig(projectRoot)?.REMOTE_CONTROL_ENABLED === true; } catch { /* fail closed */ }
      return { available: false, enabled: false, context: null, grant: null,
        migrationRequired: legacy };
    }
  }

  // Called only by the bound Electron window's dedicated IPC handler. The context
  // comes from its last read, so an old account/project/window cannot approve a new one.
  function write(projectRoot, enabled, expectedContext) {
    if (typeof enabled !== 'boolean') throw new Error('Remote control must be a boolean');
    let current;
    try { current = scope(projectRoot); } catch { throw new Error('Remote control context changed; reopen Settings'); }
    fs.mkdirSync(directory(), { recursive: true, mode: 0o700 });
    const lock = current.file + '.lock';
    const owner = `${process.pid}-${randomUUID()}`;
    // Serialize comparison + write across app processes, not just windows. A stale
    // window cannot race a disable and overwrite it with its old confirmation.
    try { fs.mkdirSync(lock, { mode: 0o700 }); }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const owners = fs.readdirSync(lock);
      if (owners.length !== 1 || !/^\d+-[a-f0-9-]+$/.test(owners[0])) throw new Error('Remote control settings busy; try again');
      const pid = Number(owners[0].split('-')[0]);
      try { process.kill(pid, 0); throw new Error('Remote control settings busy; try again'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      fs.unlinkSync(path.join(lock, owners[0])); fs.rmdirSync(lock);
      fs.mkdirSync(lock, { mode: 0o700 });
    }
    const tmp = `${current.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(path.join(lock, owner), '', { mode: 0o600, flag: 'wx' });
      current = scope(projectRoot);
      if (!expectedContext || hash([current.context, record(current.file)?.revision || null]) !== expectedContext) {
        throw new Error('Remote control context changed; reopen Settings');
      }
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, context: current.context, enabled, revision: randomUUID() }) + '\n',
        { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, current.file);
    } finally {
      fs.rmSync(tmp, { force: true });
      fs.rmSync(path.join(lock, owner), { force: true }); fs.rmdirSync(lock);
    }
    return read(projectRoot);
  }

  // Other windows/processes share this directory. Gate reads remain synchronous:
  // a delayed filesystem/IPC notification cannot authorize another send or spawn.
  function watch(onChange) {
    try {
      if (inside(fs.realpathSync(path.resolve(__dirname, '../..')), dataRoot())) return () => {};
      fs.mkdirSync(directory(), { recursive: true, mode: 0o700 });
      const watcher = fs.watch(directory(), { persistent: false }, onChange);
      watcher.on('error', onChange);
      return () => watcher.close();
    } catch { return () => {}; }
  }

  return { read, write, watch };
}

module.exports = { createRemoteControlConsent, ...createRemoteControlConsent() };
