import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  hasBulkChanges, stagedBulkFields, stageBulkField, stageBulkAgent, stageBulkDesignMode, bulkPatchBody,
} from './bulk-changes.js';

// (TPT9159) The bulk bar's staged-edit record and the PATCH body Apply builds from it.

test('an empty record has nothing to apply', () => {
  assert.equal(hasBulkChanges({}), false);
  assert.equal(hasBulkChanges(null), false);
  assert.deepEqual(stagedBulkFields({}), []);
  assert.deepEqual(bulkPatchBody({}, {}), {});
});

test('stageBulkField stages a value and unstages it on an empty one', () => {
  let changes = stageBulkField({}, 'status', 'completed');
  assert.deepEqual(changes, { status: 'completed' });
  changes = stageBulkField(changes, 'assignee', 7, { assigneeName: 'Dana' });
  assert.deepEqual(stagedBulkFields(changes), ['status', 'assignee']);
  changes = stageBulkField(changes, 'status', '');
  changes = stageBulkField(changes, 'assignee', undefined, { assigneeName: '' });
  assert.deepEqual(changes, {});
});

test('Design mode lives only beside a staged Claude and is cleared by another agent', () => {
  let changes = stageBulkAgent({}, 'claude');
  assert.equal(changes.claudeDesignMode, false);
  changes = stageBulkDesignMode(changes, true);
  assert.equal(changes.claudeDesignMode, true);
  assert.equal(stageBulkAgent(changes, 'claude').claudeDesignMode, true, 'picking Claude again keeps it');
  changes = stageBulkAgent(changes, 'codex');
  assert.equal('claudeDesignMode' in changes, false);
  assert.deepEqual(stageBulkDesignMode(changes, true), changes, 'no Design mode without Claude');
  assert.equal(stageBulkAgent(changes, 'claude').claudeDesignMode, false);
  assert.deepEqual(stageBulkAgent(changes, ''), {});
});

test('a Pi row id rides with the Pi agent only', () => {
  assert.deepEqual(stageBulkAgent({}, 'pi', 'openrouter/qwen'), { agent: 'pi', piModel: 'openrouter/qwen' });
  assert.deepEqual(stageBulkAgent({ agent: 'pi', piModel: 'x' }, 'codex'), { agent: 'codex' });
  assert.deepEqual(bulkPatchBody({ agent: 'pi', piModel: 'x' }), { agent_assignee: 'pi', pi_model: 'x' });
  assert.deepEqual(bulkPatchBody({ agent: 'pi' }), { agent_assignee: 'pi' });
});

test('bulkPatchBody carries every staged field in one body', () => {
  const changes = { priority: '4', status: 'on_fire', agent: 'claude', claudeDesignMode: true, assignee: 7, assigneeName: 'Dana' };
  assert.deepEqual(bulkPatchBody(changes, { priority: 4 }), {
    priority: 4, status: 'on_fire', assignee: 7, agent_assignee: 'claude', claude_design_mode: true,
  });
  assert.deepEqual(bulkPatchBody({ agent: 'claude', claudeDesignMode: false }), { agent_assignee: 'claude', claude_design_mode: false });
  assert.deepEqual(bulkPatchBody({ agent: 'codex' }), { agent_assignee: 'codex' }, 'Design mode is never written for another agent');
});

test('a locked task keeps its agent and Design mode but takes the other fields', () => {
  const changes = { status: 'completed', agent: 'claude', claudeDesignMode: true };
  assert.deepEqual(bulkPatchBody(changes, { reassign: false }), { status: 'completed' });
  assert.deepEqual(bulkPatchBody({ agent: 'codex' }, { reassign: false }), {});
});

test('Backlog is sent as sprint_id:null, a sprint as its number', () => {
  assert.deepEqual(bulkPatchBody({ priority: 'null' }, { priority: 0 }), { sprint_id: null });
  assert.deepEqual(bulkPatchBody({ priority: '__new__' }, { priority: 9 }), { priority: 9 });
});
