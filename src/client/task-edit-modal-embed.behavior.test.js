import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// (TPT9346) The Task Edit description takes attachments through the composer's own Embed control
// (embed-menu.js): picked, dropped and pasted images and files go into the draft description at the
// caret, linked to the task, and Save never stores a `blob:` placeholder. The DOM half runs the
// real modal with the real shared upload helpers in its own process
// (task-edit-modal-embed-dom-runner.mjs).
test('Task Edit description: Embed, drop and paste insert at the caret, link to the task and save', () => {
  const runner = new URL('./task-edit-modal-embed-dom-runner.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(runner)], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /TPT9346_DESCRIPTION_EMBED_PASS/);
  // (TPT9361) Several images and files in one pick: one reference per line, all linked to the task.
  assert.match(result.stdout, /TPT9361_MULTI_PICK_PASS/);
});

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('the modal reuses the shared Embed control and upload helpers — no upload code of its own', () => {
  const modal = read('./task-edit-modal.js');
  assert.match(modal, /import \{[^}]*\bembedMenuHtml\b[^}]*\battachEmbedMenu\b[^}]*\battachFileDrop\b[^}]*\} from '\.\/embed-menu\.js'/);
  assert.equal(modal.match(/embedMenuHtml\(/g).length, 1, 'one Embed control');
  // Images through the board's attachImagePaste() / uploadImageFile(), files through file-attach.js —
  // both reached via embed-menu.js; the description editor no longer uploads dropped images itself.
  const editDescription = modal.slice(modal.indexOf('const editDescription = ('), modal.indexOf('formState._openDescEditor = editDescription;'));
  assert.match(editDescription, /commands\.attachImagePaste\(ta, null, descUploads\.imageOpts\)/);
  assert.match(editDescription, /attachFileDrop\(ta, descTarget, descUploads\)/);
  assert.ok(!editDescription.includes('_attachImageHandlers('), 'no second, direct image upload path');
  for (const own of ['api.files.upload', "'upload-image'", 'createObjectURL']) {
    assert.ok(!modal.includes(own), `task-edit-modal.js does not implement ${own} itself`);
  }
});

test('styles.css: the description Embed row is compact, and the portaled menu stacks above the modal', () => {
  const styles = read('./styles.css');
  const rule = selector => {
    const at = styles.indexOf(`${selector} {`);
    assert.ok(at >= 0, `styled: ${selector}`);
    return styles.slice(at, styles.indexOf('}', at));
  };
  assert.match(rule('.modal-desc-embed'), /justify-content: flex-end/);
  assert.match(rule('.modal-desc-embed .embed-menu-trigger'), /width: auto/);
  assert.match(rule('.modal-desc-embed .embed-menu-wrap'), /flex: 0 0 auto/);
  // Above .task-edit-overlay (3000, 3150 over the task chat window), with the modal's other body dropdowns.
  assert.match(rule('.import-submenu--portal'), /position: fixed/);
  assert.match(rule('.import-submenu--portal'), /z-index: 3200/);
});
