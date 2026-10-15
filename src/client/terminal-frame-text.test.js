import assert from 'node:assert/strict';
import { test } from 'node:test';

// (TPT9002) Coded server frames render their terminal.error.* / terminal.pasteError.* keys in the
// project language; anything uncoded or unknown keeps the server's English text.
const { LOCALES, setLocale } = await import('./i18n.js');
const { errorFrameText, pasteErrorText, startFailureText, isRefusedStart, refusedStartTasks } = await import('./terminal-frame-text.js');

const sub = (text, params) => Object.entries(params).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);

for (const lang of ['en', 'uk']) {
  test(`errorFrameText renders known codes from the ${lang} table and keeps unknown text verbatim`, () => {
    setLocale(lang);
    const table = LOCALES[lang];
    assert.equal(errorFrameText({ type: 'error', code: 'EASSIGNEE', message: 'Cannot start a task assigned to another member.' }), table['terminal.error.EASSIGNEE']);
    assert.equal(errorFrameText({ code: 'ECLAIM', message: 'x' }), table['terminal.error.ECLAIM']);
    assert.equal(
      errorFrameText({ code: 'ESTART', params: { label: 'Codex', message: 'Codex CLI not found' }, message: 'Failed to start Codex: Codex CLI not found' }),
      sub(table['terminal.error.ESTART'], { label: 'Codex', message: 'Codex CLI not found' }),
    );
    assert.equal(errorFrameText({ code: 'ESTARTING', params: { taskId: 'TPT1' }, message: 'x' }), sub(table['terminal.error.ESTARTING'], { taskId: 'TPT1' }));
    assert.equal(errorFrameText({ code: 'ENOSESSION', params: { taskId: 'TPT1' }, message: 'x' }), sub(table['terminal.error.ENOSESSION'], { taskId: 'TPT1' }));
    assert.equal(errorFrameText({ code: 'EBADREQUEST', message: 'Missing taskId parameter' }), table['terminal.error.EBADREQUEST']);
    assert.equal(errorFrameText({ code: 'ESETUP', params: { message: 'boom' }, message: 'x' }), sub(table['terminal.error.ESETUP'], { message: 'boom' }));
    assert.equal(errorFrameText({ code: 'EAGENT', params: { agent: 'zork' }, message: 'x' }), sub(table['terminal.error.EAGENT'], { agent: 'zork' }));
    // Uncoded, unknown or malformed frames: the server text, or nothing.
    assert.equal(errorFrameText({ message: 'boom' }), 'boom');
    assert.equal(errorFrameText({ code: 'ENOTAKEY', message: 'raw server text' }), 'raw server text');
    assert.equal(errorFrameText({ code: 'ENOTAKEY' }), '');
    assert.equal(errorFrameText(null), '');
    assert.equal(errorFrameText({ message: 42 }), '');
    // A coded frame missing a param its template needs keeps the server text, never an empty slot.
    assert.equal(errorFrameText({ code: 'ESTART', message: 'Failed to start Codex: boom' }), 'Failed to start Codex: boom');
    assert.equal(errorFrameText({ code: 'ESTART', params: { label: 'Codex' }, message: 'Failed to start Codex: boom' }), 'Failed to start Codex: boom');
  });

  test(`errorFrameText EAUTH: reason sub-keys and the refresh-failure variant (${lang})`, () => {
    setLocale(lang);
    const table = LOCALES[lang];
    assert.equal(errorFrameText({ code: 'EAUTH', message: 'Authentication expired or invalid — sign in again.' }), table['terminal.error.EAUTH']);
    assert.equal(errorFrameText({ code: 'EAUTH', reason: 'unauthorized', message: 'x' }), table['terminal.error.EAUTH']);
    assert.equal(
      errorFrameText({ code: 'EAUTH', reason: 'expired', params: { when: '09:05', expiresAt: 1 }, message: 'x' }),
      sub(table['terminal.error.EAUTH.expired'], { when: '09:05' }),
    );
    assert.equal(
      errorFrameText({ code: 'EAUTH', reason: 'expiring', params: { when: '09:05', refreshError: null }, message: 'x' }),
      sub(table['terminal.error.EAUTH.expiring'], { when: '09:05' }),
    );
    assert.equal(
      errorFrameText({ code: 'EAUTH', reason: 'expiring', params: { when: '09:05', refreshError: 'token refresh rejected (HTTP 503)' }, message: 'x' }),
      sub(table['terminal.error.EAUTH.expiringNotRefreshed'], { when: '09:05', error: 'token refresh rejected (HTTP 503)' }),
    );
    // An expired reason without `when`: the English message stays rather than an empty slot.
    assert.equal(errorFrameText({ code: 'EAUTH', reason: 'expired', message: 'API token expired at 09:05 — sign in again.' }), 'API token expired at 09:05 — sign in again.');
  });

  // (TPT9008) A coded ESTART renders its reason: the agent's own sub-key when the sentence names its
  // CLI, else the shared one; a reason with neither keeps the plain ESTART text.
  test(`errorFrameText ESTART: the agent's reason sub-key, then the shared one, then the plain text (${lang})`, () => {
    setLocale(lang);
    const table = LOCALES[lang];
    const frame = (reason, params) => ({ code: 'ESTART', reason, params: { message: 'raw detection text', ...params }, message: 'server text' });
    assert.equal(errorFrameText(frame('cli_not_found', { label: 'Claude Code', agent: 'claude' })),
      sub(table['terminal.error.ESTART.cli_not_found.claude'], { label: 'Claude Code' }));
    assert.equal(errorFrameText(frame('not_logged_in', { label: 'Codex', agent: 'codex' })),
      sub(table['terminal.error.ESTART.not_logged_in.codex'], { label: 'Codex' }));
    assert.equal(errorFrameText(frame('probe_failed_output', { label: 'Other Model', agent: 'pi', output: 'Error: boom' })),
      sub(table['terminal.error.ESTART.probe_failed_output.pi'], { label: 'Other Model', output: 'Error: boom' }));
    assert.equal(errorFrameText(frame('no_tool_calls', { label: 'Other Model', agent: 'pi', model: 'recraft-v3', host: 'openrouter.ai' })),
      sub(table['terminal.error.ESTART.no_tool_calls.pi'], { label: 'Other Model', model: 'recraft-v3', host: 'openrouter.ai' }));
    // The shared sub-key serves every agent.
    assert.equal(errorFrameText(frame('detection_failed', { label: 'Codex', agent: 'codex' })),
      sub(table['terminal.error.ESTART.detection_failed'], { label: 'Codex' }));
    // No sub-key for this reason and agent (an unknown reason, a sentence another agent owns, no
    // agent at all): the plain ESTART text around the raw message.
    const plain = (label) => sub(table['terminal.error.ESTART'], { label, message: 'raw detection text' });
    assert.equal(errorFrameText(frame('project-scope', { label: 'Codex', agent: 'codex' })), plain('Codex'));
    assert.equal(errorFrameText(frame('probe_failed', { label: 'Codex', agent: 'codex' })), plain('Codex'));
    assert.equal(errorFrameText(frame('cli_not_found', { label: 'Codex' })), plain('Codex'));
    // A sub-key missing a param it needs keeps the server's own sentence.
    assert.equal(errorFrameText(frame('probe_failed_output', { label: 'Other Model', agent: 'pi' })), 'server text');
    assert.equal(errorFrameText({ code: 'ESTART', reason: 'cli_not_found', params: { agent: 'claude' }, message: 'server text' }), 'server text');
  });

  test(`errorFrameText EAUTH: a coded refresh failure is named from the ${lang} table`, () => {
    setLocale(lang);
    const table = LOCALES[lang];
    const expiring = (params) => errorFrameText({ code: 'EAUTH', reason: 'expiring', params: { when: '09:05', ...params }, message: 'server text' });
    const line = (error) => sub(table['terminal.error.EAUTH.expiringNotRefreshed'], { when: '09:05', error });
    assert.equal(
      expiring({ refreshError: 'token refresh rejected (HTTP 503)', refreshCode: 'rejected', refreshParams: { status: 503 } }),
      line(sub(table['terminal.error.EAUTH.refresh.rejected'], { status: 503 })),
    );
    assert.equal(
      expiring({ refreshError: 'token refresh request failed (timeout)', refreshCode: 'request_timeout' }),
      line(table['terminal.error.EAUTH.refresh.request_timeout']),
    );
    // An unknown code, or a code missing the params its sentence needs, keeps the English refresh text.
    for (const extra of [{ refreshCode: 'from_a_newer_server' }, { refreshCode: 'rejected' }]) {
      assert.equal(expiring({ refreshError: 'token refresh rejected (HTTP 503)', ...extra }), line('token refresh rejected (HTTP 503)'));
    }
  });

  test(`pasteErrorText renders paste codes from the ${lang} table and keeps unknown text verbatim`, () => {
    setLocale(lang);
    const table = LOCALES[lang];
    assert.equal(
      pasteErrorText({ type: 'paste-image-error', code: 'EIMAGE_TYPE', params: { type: 'image/bmp' }, error: 'Unsupported image type: image/bmp' }),
      sub(table['terminal.pasteError.EIMAGE_TYPE'], { type: 'image/bmp' }),
    );
    assert.equal(pasteErrorText({ code: 'EIMAGE_TOO_LARGE', params: { maxMb: 12 }, error: 'x' }), sub(table['terminal.pasteError.EIMAGE_TOO_LARGE'], { maxMb: 12 }));
    for (const code of ['EIMAGE_NOT_RUNNING', 'EIMAGE_MISSING', 'EIMAGE_EMPTY']) {
      assert.equal(pasteErrorText({ code, error: 'x' }), table[`terminal.pasteError.${code}`]);
    }
    assert.equal(pasteErrorText({ error: 'upload rejected' }), 'upload rejected');
    assert.equal(pasteErrorText({ code: 'EACCES', error: 'EACCES: permission denied' }), 'EACCES: permission denied');
    assert.equal(pasteErrorText({ code: 'EIMAGE_TYPE', error: 'Unsupported image type: undefined' }), 'Unsupported image type: undefined');
    assert.equal(pasteErrorText({}), '');
  });

  // (TPT9010) The error toast of a batch start made with no terminal on screen.
  test(`startFailureText lists the refused keys with the ${lang} frame text, one line per reason`, () => {
    setLocale(lang);
    const table = LOCALES[lang];
    const refused = message => ({ ok: false, message });
    const eassignee = { type: 'error', code: 'EASSIGNEE', message: 'Cannot start a task assigned to another member.' };
    const estart = { type: 'error', code: 'ESTART', params: { label: 'Codex', message: 'Codex CLI not found' }, message: 'Failed to start Codex: Codex CLI not found' };
    assert.equal(startFailureText([{ id: 'TPT1', result: refused(eassignee) }]), `TPT1: ${table['terminal.error.EASSIGNEE']}`);
    // One line per distinct text, listing its keys in task order.
    assert.equal(
      startFailureText([
        { id: 'TPT1', result: refused(eassignee) },
        { id: 'TPT2', result: refused(estart) },
        { id: 'TPT3', result: refused(eassignee) },
      ]),
      `TPT1, TPT3: ${table['terminal.error.EASSIGNEE']}\nTPT2: ${sub(table['terminal.error.ESTART'], { label: 'Codex', message: 'Codex CLI not found' })}`,
    );
    // An uncoded frame keeps the server text; a frame with no text still names the task.
    assert.equal(startFailureText([{ id: 'TPT4', result: refused({ type: 'error', message: 'boom' }) }]), 'TPT4: boom');
    assert.equal(startFailureText([{ id: 'TPT5', result: refused({ type: 'error' }) }]), `TPT5: ${table['terminal.status.error']}`);
    // Only a server refusal is reported: accepted, queued, timed-out, dropped, session-ended and
    // thrown starts carry no server text.
    assert.equal(startFailureText([
      { id: 'A', result: { ok: true, message: { type: 'terminal-state' } } },
      { id: 'B', result: { ok: true, message: { type: 'session-queued' } } },
      { id: 'C', result: { ok: false, message: null } },
      { id: 'D', result: { ok: false } },
      { id: 'E', result: refused({ type: 'session-ended', taskId: 'E' }) },
      { id: 'F', result: undefined },
    ]), '');
    assert.equal(startFailureText([]), '');
    assert.equal(startFailureText(null), '');
  });
}

test('the English tables are the server wording, so an English project renders exactly what the server sends', () => {
  setLocale('en');
  assert.equal(errorFrameText({ code: 'EASSIGNEE', message: 'Cannot start a task assigned to another member.' }), 'Cannot start a task assigned to another member.');
  assert.equal(errorFrameText({ code: 'ESTART', params: { label: 'Codex', message: 'Codex CLI not found' }, message: 'Failed to start Codex: Codex CLI not found' }), 'Failed to start Codex: Codex CLI not found');
  assert.equal(errorFrameText({ code: 'EAUTH', reason: 'expiring', params: { when: '09:05', refreshError: 'offline' }, message: 'API token expires at 09:05 and could not be refreshed (offline) — sign in again.' }), 'API token expires at 09:05 and could not be refreshed (offline) — sign in again.');
  assert.equal(pasteErrorText({ code: 'EIMAGE_TOO_LARGE', params: { maxMb: 12 }, error: 'Image too large (>12 MB)' }), 'Image too large (>12 MB)');
});

test('rendered text never leaks a placeholder, a key, or "undefined"', () => {
  setLocale('uk');
  const outputs = [
    errorFrameText({ code: 'ESTART', params: { label: 'Codex', message: 'boom' }, message: 'x' }),
    errorFrameText({ code: 'EAUTH', reason: 'expiring', params: { when: '09:05', refreshError: 'offline' }, message: 'x' }),
    pasteErrorText({ code: 'EIMAGE_TYPE', params: { type: 'image/bmp' }, error: 'x' }),
    startFailureText([{ id: 'TPT1', result: { ok: false, message: { type: 'error', code: 'ESTART', params: { label: 'Codex', message: 'boom' }, message: 'x' } } }]),
  ];
  for (const out of outputs) assert.doesNotMatch(out, /\{\w+\}|terminal\.|undefined/);
});

// (TPT9013) The refused starts a batch puts back to their previous status — the same ones
// startFailureText() reports; a start the server may still be running is never among them.
test('refusedStartTasks keeps only the starts the server refused with an error frame', () => {
  const refused = { ok: false, message: { type: 'error', code: 'EASSIGNEE' } };
  assert.equal(isRefusedStart(refused), true);
  for (const result of [
    { ok: true, message: { type: 'terminal-state' } },
    { ok: true, message: { type: 'session-queued' } },
    { ok: false, message: null },
    { ok: false },
    { ok: false, message: { type: 'session-ended' } },
    undefined,
    null,
  ]) assert.equal(isRefusedStart(result), false, JSON.stringify(result));
  const tasks = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }];
  const settled = [
    { status: 'fulfilled', value: refused },
    { status: 'fulfilled', value: { ok: true, message: { type: 'session-queued' } } },
    { status: 'rejected', reason: new Error('PATCH failed') },
    { status: 'fulfilled', value: { ok: false, message: { type: 'error', code: 'ESTART' } } },
  ];
  assert.deepEqual(refusedStartTasks(tasks, settled).map(t => t.id), ['A', 'D']);
  assert.deepEqual(refusedStartTasks(tasks, []), []);
  assert.deepEqual(refusedStartTasks(null, settled), []);
});
