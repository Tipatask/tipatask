'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { isImageModel, normalizeImageDefaults } = require('../pi-image-settings');
const { imageTaskCopy } = require('../image-task-copy.mjs');
const { readProjectConfig, piEntryForModel } = require('./project-config');
const { piTaskDefaultEntry } = require('./pi-custom-endpoint');
const { imageStore, safeFolder, MAX_ATTACHMENT_BASE64 } = require('./image-task-store');
const { generatePiImages, imageError } = require('./pi-image-provider');
const { prepareImageVcs, finishImageVcs } = require('./image-task-vcs');
const { completeVerifiedTask } = require('./git-merge/completion-guard');

function projectIdentity(backend) {
  const credentials = backend.getCredentials?.() || {};
  return `${credentials.baseUrl || ''}\0${credentials.projectId || ''}`;
}
function storeFor(userDataRoot, projectRoot, taskId, backend) {
  return imageStore(userDataRoot, projectRoot, taskId, projectIdentity(backend));
}

function publicImageState(state) {
  if (!state) return null;
  return { runId: state.runId, stage: state.stage, error: state.error || null, completed: state.stage === 'done',
    canRetry: !['preparing', 'requesting', 'saving', 'uploading', 'finalizing'].includes(state.stage),
    canResume: state.stage !== 'done' && state.files?.length > 0,
    files: (state.files || []).map((file, index) => ({ path: file.path || '', relativePath: file.relativePath || file.filename,
      url: `/api/image-task/result?task=${encodeURIComponent(state.taskId)}&run=${state.runId}&index=${index}`, mime: file.mime })) };
}

function send(session, frame) {
  if (session.ws && session.ws.readyState === session.ws.OPEN) session.ws.send(JSON.stringify({ tabId: session.tabId, ...frame }));
}

function resultReport(state, baseUrl = '') {
  return `Generated ${state.files.length} image(s) with ${state.model} from the task description. `
    + `The original files were saved locally and their formats and contents were verified.\n\n`
    + state.files.map(file => `Saved file: \`${file.path}\`\n${file.attachmentUrl ? `\n![Generated image](${new URL(file.attachmentUrl, baseUrl).href})\n` : ''}`).join('\n')
    + `\nVerification: generated image MIME signatures and saved-file SHA-256 digests match.`
    + `${state.commit ? ` Asset commit: ${state.commit}.` : ''}${state.prUrl ? ` Pull request: ${state.prUrl}.` : ''}\n\nFollow-ups: none.`;
}

// Starts background work owned by the session, without creating a CLI or PTY. The session
// registry and durable store are both single-flight gates. Only an explicit retry generates again.
async function startImageTask(session, { task, entry, backend, projectRoot, userDataRoot, mode = 'start', runId,
  generate = generatePiImages, prepareVcs = prepareImageVcs, finishVcs = finishImageVcs, complete = completeVerifiedTask } = {}) {
  if (session._imagePromise && session.alive) return;
  const store = storeFor(userDataRoot, projectRoot, task.id, backend);
  const release = await store.lock();
  let state;
  try {
    if (session._terminated) throw imageError('canceled');
    state = await store.read();
    if (mode !== 'start' && (!state || runId !== state.runId)) throw imageError('settings');
    if (state && mode === 'start') {
      if (['preparing', 'requesting', 'saving', 'uploading', 'finalizing'].includes(state.stage)) {
        state.stage = 'failed'; state.error = 'interrupted'; await store.write(state);
      }
    } else if (mode !== 'resume') {
      state = { taskId: task.id, model: entry.model, projectIdentity: projectIdentity(backend), runId: crypto.randomUUID(), stage: 'preparing', files: [], createdAt: Date.now() };
      await store.write(state);
    }
  } catch (err) { await release(); throw err; }

  if (session._terminated) { await release(); throw imageError('canceled'); }
  session._imageOperation = true;
  session._imageState = publicImageState(state);
  session.taskAgent = 'pi'; session.taskAgentModel = state.model;
  session.terminalPhase = 'executing'; session.planApprovalCommand = null;
  session.pending = false;
  session._resolutionPosted = true; // the guarded operation supplies its own report
  const locale = readProjectConfig(projectRoot)?.language || 'en';
  const announce = () => {
    session._imageState = publicImageState(state);
    send(session, { type: 'image-task-state', imageTask: session._imageState });
    const key = state.error ? `imageTask.error.${state.error}` : `imageTask.${state.stage}`;
    const line = `[Task App] ${imageTaskCopy(locale, key)}\r\n`;
    session.buffer = (session.buffer + line).slice(-200000);
    send(session, { type: 'data', data: line });
  };
  const persist = () => store.write(state);
  const assertProject = () => { if (state.projectIdentity && state.projectIdentity !== projectIdentity(backend)) throw imageError('completion'); };
  const stage = async name => { state.stage = name; state.error = null; await persist(); announce(); };
  // A retry re-reads the row's current credential server-side; no stored key reaches the client.
  session._imageRetry = async (retryMode, expectedRunId) => {
    if (session.alive) return;
    assertProject();
    const cfg = readProjectConfig(projectRoot);
    const current = piEntryForModel(cfg, state.model);
    if (!isImageModel(current)) throw imageError('settings');
    const fresh = await backend.getTask(task.id);
    if (!fresh) throw imageError('settings');
    const me = await backend.getCurrentUserId?.();
    if (fresh.assignee != null && me != null && Number(fresh.assignee) !== Number(me)) throw imageError('settings');
    return startImageTask(session, { task: fresh, entry: current, backend, projectRoot, userDataRoot,
      mode: retryMode, runId: expectedRunId, generate, prepareVcs, finishVcs, complete });
  };
  if (mode === 'start' && state.stage !== 'preparing') {
    announce(); session.alive = false; session.exitCode = state.stage === 'done' ? 0 : 1;
    await release();
    return;
  }
  if (mode === 'resume' && !state.files.length) { await release(); throw imageError('settings'); }
  session.alive = true;
  session._terminated = false;
  session.exitCode = null;
  const controller = new AbortController();
  session._imageAbort = () => controller.abort();
  const abortCheck = () => { if (controller.signal.aborted || session._terminated) throw imageError('canceled'); };
  announce();
  const promise = (async () => {
    try {
      assertProject();
      const statuses = await backend.getStatuses({ refresh: true, strict: true });
      const progress = statuses.find(s => s.is_in_progress);
      if (!progress) throw imageError('completion');
      abortCheck();
      assertProject();
      const updated = await backend.updateTask(task.id, { status: progress.name });
      require('./websocket').emitTaskUpdated(updated, null, projectRoot);
      abortCheck();
      if (mode === 'resume') {
        const defaults = normalizeImageDefaults(entry);
        const plan = await prepareVcs({ backend, projectRoot, folder: defaults.outputFolder, taskId: task.id });
        if (plan.root !== state.vcsPlan.root || plan.folder !== state.vcsPlan.folder) {
          delete state.commit; delete state.prUrl; delete state.merged; state.locationsPosted = false;
          for (const file of state.files) { delete file.path; delete file.relativePath; }
        }
        state.vcsPlan = plan;
        await persist();
        abortCheck();
      }
      if (mode !== 'resume') {
        const defaults = normalizeImageDefaults(entry);
        state.vcsPlan = await prepareVcs({ backend, projectRoot, folder: defaults.outputFolder, taskId: task.id });
        await safeFolder(state.vcsPlan.root, state.vcsPlan.folder);
        abortCheck();
        await stage('requesting');
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60 * 1000)]);
        const result = await generate(entry, task.description, { signal });
        // Cache returned bytes even if Cancel races with the final provider response.
        state.files = await store.cache(state.runId, result.output, task.id);
        state.usage = result.usage || null;
        if (!state.files.length) throw imageError('invalid');
        await persist();
        abortCheck();
        assertProject();
      }
      await stage('saving');
      for (const file of state.files) {
        abortCheck();
        file.path = await store.save(state, file, state.vcsPlan.root, state.vcsPlan.folder);
        file.relativePath = path.relative(projectRoot, file.path);
        await persist();
        const line = `${imageTaskCopy(locale, 'imageTask.saved', { path: file.path })}\r\n`;
        session.buffer += line; send(session, { type: 'data', data: line });
      }
      // Leave durable, usable locations in the task even when remote attachment upload fails.
      const marker = `Image run ${state.runId}`;
      if (!state.locationsPosted) {
        assertProject();
        const comments = await backend.getTaskComments(task.id);
        if (!comments.some(c => c.content?.includes(marker))) {
          await backend.createTaskComment(task.id, `${marker}\n\n${state.files.map(f => imageTaskCopy(locale, 'imageTask.saved', { path: f.path })).join('\n')}`, 'comment');
        }
        state.locationsPosted = true; await persist();
      }
      await stage('uploading');
      for (const file of state.files) {
        abortCheck();
        if (file.attachmentUrl) continue;
        const bytes = await store.bytes(state, file);
        const data = bytes.toString('base64');
        if (data.length > MAX_ATTACHMENT_BASE64) throw imageError('upload');
        try {
          assertProject();
          const uploaded = await backend.uploadImage(file.filename, file.mime, data, task.id);
          if (!uploaded?.url) throw imageError('upload');
          file.attachmentUrl = uploaded.url;
          await persist();
        } catch { throw imageError('upload'); }
      }
      abortCheck();
      await stage('finalizing');
      assertProject();
      await finishVcs({ backend, projectRoot, taskId: task.id, state, persist });
      abortCheck();
      // The final live settings read and workflow-role resolution happen inside this guard.
      const credentials = backend.getCredentials?.() || {};
      assertProject();
      if (backend.getConnectionState && backend.getConnectionState() !== 'connected') throw imageError('completion');
      const result = await complete({ backend, projectRoot, taskId: task.id, resolution: resultReport(state, credentials.baseUrl) });
      abortCheck();
      if (!result.completed) { state.blockers = result.verification?.blockers || []; throw imageError('completion'); }
      await stage('done');
      require('./websocket').emitTaskUpdated(result.task, null, projectRoot);
    } catch (err) {
      state.stage = controller.signal.aborted ? 'canceled' : 'failed';
      state.error = controller.signal.aborted ? 'canceled' : ['auth', 'payment', 'rate', 'provider', 'invalid', 'save', 'upload', 'completion', 'prompt', 'settings', 'runtime', 'timeout', 'canceled'].includes(err.code) ? err.code : 'completion';
      await persist().catch(() => {});
      try {
        assertProject();
        const statuses = await backend.getStatuses({ refresh: true, strict: true });
        const urgent = statuses.find(s => s.name === 'on_fire') || statuses.find(s => s.is_in_progress);
        if (urgent) {
          const updated = await backend.updateTask(task.id, { status: urgent.name });
          require('./websocket').emitTaskUpdated(updated, null, projectRoot);
        }
        const marker = `Image run ${state.runId}: ${state.error}`;
        const comments = await backend.getTaskComments(task.id);
        if (!comments.some(c => c.content?.includes(marker))) {
          await backend.createTaskComment(task.id, `${marker}\n\n${imageTaskCopy(locale, `imageTask.error.${state.error}`)}`, 'comment');
        }
      } catch { /* saved local state remains the recovery source */ }
      announce();
    } finally {
      session.alive = false;
      session.exitCode = state.stage === 'done' ? 0 : 1;
      session._imageAbort = null;
      await release();
      send(session, { type: 'exit', code: session.exitCode });
      session.onSlotFreed?.();
    }
  })();
  session._imagePromise = promise;
  // Keep rejection handling attached even if a client detaches or termination deletes the session.
  promise.catch(() => { session.alive = false; });
}

function resolveImageEntry(projectRoot, model, task) {
  const cfg = readProjectConfig(projectRoot);
  const requested = String(model || task?.piModel || '').trim().toLowerCase();
  const raw = requested && (Array.isArray(cfg?.PI_MODELS) ? cfg.PI_MODELS : []).find(row => String(row?.model || '').trim().toLowerCase() === requested);
  if (isImageModel(raw)) {
    const code = !raw.apiKey?.trim() ? 'auth' : 'settings';
    try {
      const valid = piEntryForModel(cfg, raw.model);
      if (valid) return valid;
    } catch { /* report invalid image settings rather than falling back to a text model */ }
    throw Object.assign(imageError(code), { message: imageTaskCopy(cfg.language, `imageTask.error.${code}`), reasonCode: `image_${code}`, reasonParams: { agent: 'pi' } });
  }
  const entry = model ? piEntryForModel(cfg, model) : task?.piModel ? piEntryForModel(cfg, task.piModel) : piTaskDefaultEntry(cfg);
  return isImageModel(entry) ? entry : null;
}

module.exports = { startImageTask, resolveImageEntry, storeFor, publicImageState, resultReport };
