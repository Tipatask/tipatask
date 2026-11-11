'use strict';

const { accountIdentity } = require('./device-relay');

const refused = code => Object.assign(new Error(code), { code });
const positiveId = id => Number.isSafeInteger(Number(id)) && Number(id) > 0;

// `project` is the device relay's connection-bound account snapshot, never a browser
// payload. Decoding that snapshot only binds the fresh API /me proof to the account
// whose relay connection delivered the command; it is not signature verification.
function createRemoteStartGuard({ backend, project, taskId, isCurrent }) {
  const account = accountIdentity(project);
  const userId = account && JSON.parse(account)[1];
  if (!account || !positiveId(userId) || !positiveId(project.projectId)) throw refused('EAUTH');

  function assertCurrent() {
    isCurrent();
    let credentials;
    try { credentials = backend.getCredentials(); } catch { throw refused('EAUTH'); }
    if (credentials.baseUrl !== project.baseUrl || accountIdentity(credentials) !== account
      || Number(credentials.projectId) !== Number(project.projectId)) {
      throw refused('EAUTH');
    }
    return credentials;
  }

  // An objective is startable like any coding task: spawnTerminal() reads isObjective from the
  // same fresh task row and runs it in parent-objective preparation mode, as a local Start does.
  // Device-relay hellos announce this as the `objective` task kind (OBJECTIVE_TASK_KIND).
  function assertTask(task) {
    if (!task || task.id !== taskId || task.isReservation || task.category !== 'CODING') {
      throw refused('task_not_startable');
    }
    if (task.assignee != null && (!positiveId(task.assignee) || Number(task.assignee) !== Number(userId))) {
      throw refused('EASSIGNEE');
    }
    return task;
  }

  async function check({ claim = false, spawnEnv } = {}) {
    const credentials = assertCurrent();
    // Provider preparation can read credentials asynchronously. Do not start a
    // spec prepared under another account even if the user has since switched back.
    if (spawnEnv?.API_TOKEN && accountIdentity({ baseUrl: spawnEnv.API_BASE_URL || credentials.baseUrl,
      token: spawnEnv.API_TOKEN }) !== account) throw refused('EAUTH');
    if (spawnEnv?.API_PROJECT_ID && Number(spawnEnv.API_PROJECT_ID) !== Number(project.projectId)) throw refused('EAUTH');
    if (spawnEnv?.API_BASE_URL && spawnEnv.API_BASE_URL !== project.baseUrl) throw refused('EAUTH');
    const unchanged = () => {
      const current = assertCurrent();
      // Renewal between checks is safe; a credential change DURING a check needs a
      // retry, so no response authenticated by a previous token authorizes a spawn.
      if (current.token !== credentials.token || current.baseUrl !== credentials.baseUrl) throw refused('EAUTH');
    };
    let me;
    try { me = await backend.getCurrentUserId({ strict: true }); } catch { throw refused('EAUTH'); }
    unchanged();
    if (!positiveId(me) || Number(me) !== Number(userId)) throw refused('EAUTH');
    const task = assertTask(await backend.getTask(taskId));
    unchanged();
    if (!claim) return task;

    // Even an already-owned task uses the authenticated, atomic API gate. It never
    // trusts a browser assignee or queues an optimistic write for later replay.
    let claimed;
    try { claimed = await backend.claimTaskForStart(taskId, { credentials }); }
    catch (err) {
      unchanged();
      if (err.code === 'EAUTH') throw err;
      if (err.body?.code === 'task_assigned_to_other_member') throw refused('EASSIGNEE');
      if (err.body?.code === 'task_not_startable') throw refused('task_not_startable');
      throw refused('ECLAIM');
    }
    unchanged();
    assertTask(claimed);
    if (claimed._pendingSync || Number(claimed.assignee) !== Number(me)) throw refused('ECLAIM');
    return claimed;
  }

  return { assertCurrent, check };
}

module.exports = { createRemoteStartGuard };
