// Client-side API wrapper.
// Electron mode: routes through IPC (window.electronAPI.api) → per-window backend, safe for multi-project.
// Browser mode: falls back to fetch against the singleton HTTP server.

import { projectHeader } from './utils.js';
import { floatTo16LE } from './pcm.js';

const ipc = (typeof window !== 'undefined') ? window.electronAPI?.api : null;

// (C1186) POST /api/transcribe answers 415 NEEDS_PCM16 when the project's Voice preset is
// 'local' — that branch decodes raw PCM16LE mono 16kHz directly (sherpa-onnx has no container
// demuxer), not a multipart MediaRecorder blob (webm/opus). Converting client-side avoids a
// server-side ffmpeg/opus-decoder dependency; done here (not eagerly before every recording) so
// the request/response cycle self-heals off the server's own answer instead of the client having
// to know the current preset in advance and keep a cache in sync with Settings > Voice.
//
// (C1203 fix) NEEDS_RAW_AUDIO (direct-AssemblyAI branch) used to retry through this same
// function — wrong. AssemblyAI's batch API wants a real container (webm/opus/wav/…) and
// transcodes to 16kHz itself; headerless PCM16 has no container for it to detect, so every
// upload failed with a generic upstream error. See transcribeAudio() below: NEEDS_RAW_AUDIO now
// resends the original blob untouched instead of calling this.
async function _blobToPcm16Mono16k(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try {
    decoded = await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    audioCtx.close();
  }
  const targetRate = 16000;
  const offlineCtx = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetRate), targetRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start();
  const rendered = await offlineCtx.startRendering();
  return floatTo16LE(rendered.getChannelData(0));
}

async function _http(method, path, body) {
  // (C1392) Was headers: {} — this is the root cause of the C1391 browser-mode task-open
  // freeze: a header-less request against a multi-project server resolves the unbound
  // default backend instead of this window's project, so GET /api/tasks/:id 500s and the
  // (now non-blocking, see task-board.js) error path fires. See
  // ai/architecture/tt-task-board.md § Browser-mode task open (C1391).
  const opts = { method, headers: { ...projectHeader() } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch (err) {
    // (TPT9001) fetch() rejects only when no response arrived (server down, connection
    // refused/reset) — the one transport failure here. Same marker api-backend.js's
    // apiRequest() puts on its own; isTransportError() below reads it.
    err.networkError = true;
    throw err;
  }
  if (!res.ok) {
    let payload;
    try { payload = await res.json(); } catch { payload = null; }
    const err = new Error(payload?.error || `HTTP ${res.status}`);
    err.code = payload?.code;
    err.details = payload?.details;
    err.statusCode = res.status;
    throw err;
  }
  return res.json();
}

// (TPT9001) api:tasks.update called with { errorAsValue: true } answers a failure with
// { _ipcError: { message, code, statusCode, networkError } } — Electron's invoke bridge would
// keep only the message of a thrown Error (main/ipc/api-router.js). Rethrown here with the same
// fields _http() puts on its errors, so callers see one error shape on both transports.
function _rethrowIpcError(result) {
  const info = result && result._ipcError;
  if (!info) return result;
  const err = new Error(info.message || 'Request failed');
  if (info.code) err.code = info.code;
  if (info.statusCode != null) err.statusCode = info.statusCode;
  if (info.networkError) err.networkError = true;
  throw err;
}

// (TPT9001) Statuses a reverse proxy answers with when the server behind it is down or
// unreachable — no answer from the app itself.
const GATEWAY_STATUSES = new Set([502, 503, 504]);

// (TPT9001) True when a request got no answer from the server: fetch() rejected (_http above),
// api-backend.js could not reach the API (`networkError`), or a gateway status. Everything
// else — a validation rejection like the TAGS_UNREGISTERED tag gate, an auth failure, a 500 —
// is the server answering, not the network failing.
export function isTransportError(err) {
  if (!err) return false;
  if (err.networkError === true) return true;
  return GATEWAY_STATUSES.has(Number(err.statusCode));
}

// (TPT9001) An error's message for display, without the "Error invoking remote method
// '<channel>': Error: " wrapper Electron puts on a rejected IPC call that did not return its
// failure as a value (another channel, or a main process older than the renderer).
export function errorDetail(err) {
  const raw = typeof err?.message === 'string' ? err.message : String(err ?? '');
  return raw.replace(/^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/, '').trim() || raw;
}

// (C1197) Shared error-builder for POST /api/transcribe's two response points (multipart attempt
// + the PCM16 retry) — was duplicated inline, byte-identical, in both. Reads `code`/`reasonCode`/
// `reasonDetail` off the JSON body so audio-recorder.js/voice-errors.js can show which of the
// local-ASR sub-causes applies instead of one generic message. Unlike `_http` above, this deliberately
// keeps `.code` on the thrown Error — every other `_http` caller only ever needed the message.
async function _transcribeError(res) {
  let body; try { body = await res.json(); } catch { body = null; }
  const err = new Error((body && body.error) || `HTTP ${res.status}`);
  if (body && body.code) err.code = body.code;
  if (body && body.reasonCode) err.reasonCode = body.reasonCode;
  if (body && body.reasonDetail) err.reasonDetail = body.reasonDetail;
  return err;
}

export const api = {
  tasks: {
    async get(id) {
      if (ipc) {
        // (TPT665) Failures as a value, like the task writes below; the 403 keeps its own marker.
        const task = _rethrowIpcError(await ipc.tasks.get(id, { errorAsValue: true }));
        if (task?._taskAccessDenied) {
          const err = new Error('Task unavailable');
          err.statusCode = 403;
          throw err;
        }
        return task;
      }
      return _http('GET', `/api/tasks/${encodeURIComponent(id)}`);
    },
    async update(id, patch) {
      if (ipc) return _rethrowIpcError(await ipc.tasks.update(id, patch, { errorAsValue: true }));
      return _http('PATCH', `/api/tasks/${encodeURIComponent(id)}`, patch);
    },
    async delete(id) {
      if (ipc) return _rethrowIpcError(await ipc.tasks.delete(id, { errorAsValue: true }));
      return _http('DELETE', `/api/tasks/${encodeURIComponent(id)}`);
    },
    async listAll() {
      if (ipc) {
        const result = await ipc.tasks.listAll();
        return Array.isArray(result) ? result : (result?.tasks || []);
      }
      const data = await _http('GET', '/api/project/tasks');
      return data.tasks || [];
    },
    comments: {
      async list(id) {
        if (ipc) {
          const result = await ipc.comments.list(id);
          return Array.isArray(result) ? result : (result?.comments || []);
        }
        const data = await _http('GET', `/api/tasks/${encodeURIComponent(id)}/comments`);
        return data.comments || [];
      },
      // (TPT660) Both comment writes ask for failures as a value, like update() above.
      async create(id, content, type) {
        if (ipc) {
          const result = _rethrowIpcError(await ipc.comments.create(id, content, type, { errorAsValue: true }));
          return result?.comment ?? result;
        }
        const data = await _http('POST', `/api/tasks/${encodeURIComponent(id)}/comments`, { content, type });
        return data.comment;
      },
      // TPT34 — author-only edit; a mismatched-author 403 reaches the caller as a thrown
      // Error with statusCode 403 (both transports — see api-backend.js's updateTaskComment /
      // _http above, and the (TPT660) envelope in main/ipc/api-router.js).
      async update(id, commentId, content) {
        if (ipc) {
          const result = _rethrowIpcError(await ipc.comments.update(id, commentId, content, { errorAsValue: true }));
          return result?.comment ?? result;
        }
        const data = await _http('PATCH', `/api/tasks/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`, { content });
        return data.comment;
      },
    },
    // (TPT614) Finish card action: the server-built finalize kickoff for a task the exit backstop
    // flagged. Always a direct fetch, never IPC — same reasoning as `merge` below: the server's own
    // git reads resolve the project from the x-tipatask-project header, so no IPC twin is needed.
    // `_http()` keeps the 409 `code` (TASK_COMMITTED / TASK_CLOSED / COMMITS_OFF /
    // VCS_UNVERIFIED / GIT_STATE_UNKNOWN) on the thrown Error for task-finish.js.
    async finishPrompt(id) {
      return _http('GET', `/api/tasks/${encodeURIComponent(id)}/finish-prompt`);
    },
    events: {
      // TPT17 — Notifications tab: task-wide event log + subscription toggle
      async list(id) {
        if (ipc) return (await ipc.events.list(id)) || { events: [], total: 0, subscribed: true };
        return _http('GET', `/api/tasks/${encodeURIComponent(id)}/events`);
      },
      async setSubscription(id, subscribed) {
        if (ipc) return _rethrowIpcError(await ipc.events.setSubscription(id, subscribed, { errorAsValue: true })) || { subscribed };
        return _http('PUT', `/api/tasks/${encodeURIComponent(id)}/subscription`, { subscribed });
      },
    },
  },
  tags: {
    async listProject() {
      if (ipc) {
        const result = await ipc.tags.listProject();
        return Array.isArray(result) ? result : (result?.tags || []);
      }
      const data = await _http('GET', '/api/project/tags');
      return data.tags || [];
    },
  },
  // (C1520) Deliberately un-memoized — task-board.js's member cache (member-cache.js)
  // owns the single-flight in-flight slot and re-invokes this on every assignee-picker
  // focus / task-edit-modal open, not just once per browser session. The route is
  // no-store on both hops (ws-handlers.js GET /api/project/members, api-backend.js's
  // getProjectMembers() → live GET /members), so a re-call genuinely re-reads.
  members: {
    async list() {
      if (ipc) {
        const result = await ipc.members.list();
        return Array.isArray(result) ? result : (result?.members || []);
      }
      const data = await _http('GET', '/api/project/members');
      return data.members || [];
    },
  },
  // (C1235) Project scalars from the remote API row — today just taskGroupLabel. Same
  // IPC-first/HTTP-fallback idiom as statuses.list() below; consumed by group-label.js.
  project: {
    async settings() {
      if (ipc) return ipc.project.settings();
      return _http('GET', '/api/project/settings');
    },
    // (TPT659) The key the API would allocate for the next keyless create of `category`
    // (CODING|HUMAN) — { taskKey: string|null }, null whenever the server could not tell.
    // Same IPC-first/HTTP-fallback idiom as settings() above; consumed by group-label.js's
    // fetchNextTaskKey() for the New Task Preview badge.
    async nextTaskKey(category) {
      if (ipc) return ipc.project.nextTaskKey(category);
      return _http('GET', `/api/project/next-task-key?category=${encodeURIComponent(category || 'CODING')}`);
    },
    // (C1271) Write project scalars (language/task_group_label/…/vcs_* since TPT61) —
    // PATCH /api/project, same-origin proxy → backend.updateProject(). Throws on failure
    // (`.message` carries the API's validation text via _http()'s `{ error }` unwrap / IPC
    // rejection) — callers (writeProjectLanguage/writeProjectGroupLabel in task-board.js)
    // roll their control back.
    async update(fields) {
      if (ipc) {
        const result = await ipc.project.update(fields);
        return result?.project ?? null;
      }
      const data = await _http('PATCH', '/api/project', fields);
      return data.project ?? null;
    },
    // (TPT12) The caller's per-project `notifications` inbox rows — drives the board's
    // activity chip + OS push. Distinct from `tasks.events` above (TPT17's task-wide
    // task_events audit log backing the Notifications tab).
    notifications: {
      async list(params = {}) {
        if (ipc) return ipc.project.notifications.list(params);
        const qs = new URLSearchParams();
        if (params.unreadOnly) qs.set('unread_only', 'true');
        if (params.limit != null) qs.set('limit', String(params.limit));
        if (params.offset != null) qs.set('offset', String(params.offset));
        if (params.taskKey) qs.set('task_key', params.taskKey);
        const q = qs.toString();
        return _http('GET', `/api/project/notifications${q ? `?${q}` : ''}`);
      },
      // Batched — never call this once per id from a scroll/open handler.
      async markRead(ids) {
        if (ipc) return ipc.project.notifications.markRead(ids);
        return _http('POST', '/api/project/notifications/read', { ids });
      },
    },
  },
  // (C1184) Project status registry — role flags + task_count, same shape as the API's
  // GET /statuses. Used to resolve workflow-role names client-side (console-modal.js's
  // session-start gate) instead of hardcoded literal status names.
  statuses: {
    async list() {
      if (ipc) {
        const result = await ipc.statuses.list();
        return Array.isArray(result) ? result : (result?.statuses || []);
      }
      const data = await _http('GET', '/api/project/statuses');
      return data.statuses || [];
    },
    // (C1182) Workflow tab CRUD — Settings modal only, API backend only (caller hides
    // the tab in file mode; see task-board.js's Workflow tab).
    async create(fields) {
      if (ipc) return ipc.statuses.create(fields);
      const data = await _http('POST', '/api/project/statuses', fields);
      return data.status;
    },
    async update(id, fields) {
      if (ipc) return ipc.statuses.update(id, fields);
      const data = await _http('PATCH', `/api/project/statuses/${encodeURIComponent(id)}`, fields);
      return data.status;
    },
    async remove(id) {
      if (ipc) return ipc.statuses.remove(id);
      return _http('DELETE', `/api/project/statuses/${encodeURIComponent(id)}`);
    },
    async reorder(ids) {
      if (ipc) {
        const result = await ipc.statuses.reorder(ids);
        return Array.isArray(result) ? result : (result?.statuses || []);
      }
      const data = await _http('PUT', '/api/project/statuses/reorder', { ids });
      return data.statuses || [];
    },
  },
  images: {
    async upload(filename, mimeType, dataB64, taskKey = null) {
      if (ipc) return ipc.images.upload(filename, mimeType, dataB64, taskKey);
      return _http('POST', '/api/images', { filename, mimeType, data: dataB64, taskKey });
    },
  },
  // C1246 — task_files generic (non-image) attachment upload
  files: {
    async upload(filename, mimeType, dataB64, taskKey = null) {
      if (ipc) return ipc.files.upload(filename, mimeType, dataB64, taskKey);
      return _http('POST', '/api/files', { filename, mimeType, data: dataB64, taskKey });
    },
  },
  // (C1178) Voice-model downloader (C1176) — always a direct fetch, never routed through
  // `ipc`, matching transcribeAudio below: the store is machine-wide (voice-model-manager.js
  // keys off config.USER_DATA_ROOT, not any per-window project), so there is no per-project
  // backend to dispatch through.
  voiceModels: {
    async list() {
      return _http('GET', '/api/voice-models');
    },
    async download(modelId) {
      return _http('POST', `/api/voice-models/${encodeURIComponent(modelId)}/download`);
    },
    async abort(modelId) {
      return _http('POST', `/api/voice-models/${encodeURIComponent(modelId)}/abort`);
    },
    // (C1198) Frees disk for a ready/partial/stale model that isn't the active engine.
    async remove(modelId) {
      return _http('DELETE', `/api/voice-models/${encodeURIComponent(modelId)}`);
    },
  },
  // (TPT345) "Merge task branches" panel (merge-branches-modal.js). Always a direct fetch, never
  // routed through `ipc`, like voiceModels above: every route resolves the project root from the
  // x-tipatask-project header (stamped by Electron main / projectHeader()), so no IPC twin is
  // needed. Git runs in the Task App server (src/server/git-merge/), never in the renderer.
  merge: {
    async task(taskKey) {
      return _http('POST', '/api/project/merge/task', { taskKey });
    },
    async status(targets) {
      const qs = [];
      for (const [repoId, tgt] of Object.entries(targets || {})) {
        const branch = tgt && typeof tgt === 'object' ? tgt.branch : tgt;
        if (branch) qs.push(`target[${encodeURIComponent(repoId)}]=${encodeURIComponent(branch)}`);
      }
      return _http('GET', `/api/project/merge/status${qs.length ? '?' + qs.join('&') : ''}`);
    },
    async dryRun(selections, targets) {
      return _http('POST', '/api/project/merge/dry-run', { selections, targets });
    },
    async commitWorktree(repoId, branch) {
      return _http('POST', '/api/project/merge/commit-worktree', { repoId, branch });
    },
    async run(selections, targets, checks) {
      return _http('POST', '/api/project/merge/run', { selections, targets, checks });
    },
    async job() {
      return _http('GET', '/api/project/merge/job');
    },
    async resume() {
      return _http('POST', '/api/project/merge/resume');
    },
    async abort() {
      return _http('POST', '/api/project/merge/abort');
    },
    async publish(repoIds, pr = true) {
      return _http('POST', '/api/project/merge/publish', { repoIds, pr });
    },
    async cleanup(selections) {
      return _http('POST', '/api/project/merge/cleanup', { selections });
    },
  },
  async transcribeAudio(blob) {
    const fd = new FormData();
    fd.append('audio', blob, 'recording.webm');
    const res = await fetch('/api/transcribe', { method: 'POST', headers: projectHeader(), body: fd });
    if (res.status === 415) {
      let body; try { body = await res.json(); } catch { body = null; }
      const code = body && body.code;
      // (C1203) NEEDS_PCM16 (local sherpa) really needs headerless PCM16LE — decode+resample.
      // NEEDS_RAW_AUDIO (direct AssemblyAI) only means "not multipart" — resend the blob AS-IS.
      // Retrying it through _blobToPcm16Mono16k() was the C1203 bug: AssemblyAI's batch API
      // transcodes from a real container (webm/opus/wav/…) itself, it can't demux headerless
      // PCM, so every recording failed with a generic upstream error.
      if (code === 'NEEDS_PCM16' || code === 'NEEDS_RAW_AUDIO') {
        const retryBody = code === 'NEEDS_PCM16' ? await _blobToPcm16Mono16k(blob) : blob;
        const res2 = await fetch('/api/transcribe', {
          method: 'POST',
          headers: { ...projectHeader(), 'Content-Type': 'application/octet-stream' },
          body: retryBody,
        });
        if (!res2.ok) throw await _transcribeError(res2);
        return res2.json();
      }
      // Any other 415: `body` above already consumed res.json(), so _transcribeError(res) would
      // re-read a spent stream and lose code+message. Build the error from what we already parsed.
      const err = new Error((body && body.error) || `HTTP ${res.status}`);
      if (body && body.code) err.code = body.code;
      throw err;
    }
    if (!res.ok) throw await _transcribeError(res);
    return res.json();
  },
};
