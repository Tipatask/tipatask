'use strict';

// C1051: BaseTaskAgent's image-paste hooks. injectPastedImage() (terminal-session.js) writes
// through injectImagePath() and verifies via getImageAttachMarkerRe() — both default to the
// bracketed-paste-bare-path convention confirmed against the installed claude/codex CLIs by
// scripts/probe-image-paste.js. Covering the defaults here catches an accidental format
// regression without needing a real CLI spawn.

const { test } = require('node:test');
const assert = require('node:assert');

const BaseTaskAgent = require('./base-agent');

class FakeAgent extends BaseTaskAgent {
  constructor() { super('fake', 'Fake'); }
}

test('injectImagePath default writes a bare path inside a bracketed-paste frame', () => {
  const agent = new FakeAgent();
  const writes = [];
  const session = { pty: { write: (s) => writes.push(s) } };

  agent.injectImagePath(session, '/tmp/example.png');

  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0], '\x1b[200~/tmp/example.png\x1b[201~');
  // No `@` prefix (that convention opens file-mention autocomplete, not attach — C1003),
  // no quotes, no trailing newline — an exact match on the frame above already covers this,
  // spelled out as separate assertions so a future edit that breaks one is easy to place.
  assert.doesNotMatch(writes[0], /^@/);
  assert.doesNotMatch(writes[0], /["']/);
  assert.doesNotMatch(writes[0], /[\r\n]$/);
});

test('getImageAttachMarkerRe default matches both spaced and unspaced "[Image #N]" renders', () => {
  const agent = new FakeAgent();
  const re = agent.getImageAttachMarkerRe();

  // Claude Code's actual terminal render has no space (confirmed via probe-image-paste.js —
  // the space visible in the CLI's own source strings is styling between two segments, not a
  // literal character); tolerate both so a future CLI version that does insert a real space
  // still matches.
  assert.match('[Image#1]', re);
  assert.match('[Image #1]', re);
  assert.doesNotMatch('[Image]', re);
});
