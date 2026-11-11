'use strict';

// (TPT9223) The claim registry every Task App server of one OS user shares: it keeps a live run's
// claim from being released by another server, holds back a run's claim while another server
// releases the task's abandoned one, and fails closed when it cannot be read.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createDeviceClaimRegistry, claimKey, RELEASE_MARK_MS } = require('./device-claim-registry');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-claim-registry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// One machine: servers made by `server(pid)` share `directory`; `running` holds the live pids.
function machine(t, { sleep = async () => {} } = {}) {
  const directory = scratch(t);
  const running = new Set();
  const clock = { now: Date.now() };
  const warnings = [];
  const server = (pid) => {
    running.add(pid);
    return createDeviceClaimRegistry({
      directory, pid, alive: candidate => running.has(candidate), now: () => clock.now,
      sleep, log: { warn: line => warnings.push(line) },
    });
  };
  return { directory, running, clock, warnings, server, file: path.join(directory, 'device-claims.json'), lock: path.join(directory, 'device-claims.lock') };
}

const scope = task => JSON.stringify(['https://api.test', '2', task]);
const TPT1 = claimKey(scope('TPT1'), 7);
const TPT2 = claimKey(scope('TPT2'), 7);

test('claim keys tell tasks and devices apart', () => {
  assert.match(TPT1, /^[a-f0-9]{64}$/);
  assert.notEqual(TPT1, TPT2);
  assert.notEqual(TPT1, claimKey(scope('TPT1'), 8));
  assert.equal(TPT1, claimKey(scope('TPT1'), 7));
});

test("a claim a live run of any server on this machine holds is never released; a dropped one may be", async t => {
  const m = machine(t);
  const a = m.server(101);
  const b = m.server(202);
  const hold = await a.hold(TPT1);
  assert.equal(hold.releasing, false);
  assert.equal(await b.beginRelease(TPT1), 'held', "another server's live run holds it");
  assert.equal(await a.beginRelease(TPT1), 'held', "this server's own live run holds it");
  assert.equal(await b.beginRelease(TPT2), 'marked', 'nothing holds the other task');
  await b.endRelease(TPT2);
  await a.drop(hold.id);
  assert.equal(await b.beginRelease(TPT1), 'marked', 'the run released its claim');
  await b.endRelease(TPT1);
});

test('a server that exited, or whose pid another server now has, holds nothing', async t => {
  const m = machine(t);
  const a = m.server(101);
  await a.hold(TPT1);
  m.running.delete(101); // quit or crashed mid-run
  const b = m.server(202);
  assert.equal(await b.beginRelease(TPT1), 'marked');
  await b.endRelease(TPT1);
  const state = JSON.parse(fs.readFileSync(m.file, 'utf8'));
  assert.deepEqual(Object.keys(state.instances), [], "the exited server's entry is gone");

  const before = m.server(303);
  await before.hold(TPT1);
  const after = m.server(303); // a later server that was given the same pid
  assert.equal(await after.beginRelease(TPT1), 'marked', 'the pid is not proof the old server lives');
});

test('a run that starts while another server releases its task waits for that release only', async t => {
  const m = machine(t);
  const a = m.server(101);
  const b = m.server(202);
  const c = m.server(303);
  assert.equal(await b.beginRelease(TPT1), 'marked');
  assert.equal(await c.beginRelease(TPT1), 'held', 'one server releases a claim at a time');
  assert.equal(b.releasing(TPT1), false, "a server's own release never holds back its own runs");
  const hold = await a.hold(TPT1);
  assert.equal(hold.releasing, true);
  assert.equal(a.releasing(TPT1), true);
  assert.equal((await a.hold(TPT2)).releasing, false, 'another task is not held back');
  await b.endRelease(TPT1);
  assert.equal(a.releasing(TPT1), false);

  assert.equal(await b.beginRelease(TPT2), 'held', "a's run of TPT2 holds it");
  m.clock.now += 1;
  const d = m.server(404);
  assert.equal(await d.beginRelease(claimKey(scope('TPT3'), 7)), 'marked');
  assert.equal(a.releasing(claimKey(scope('TPT3'), 7)), true);
  m.clock.now += RELEASE_MARK_MS;
  assert.equal(a.releasing(claimKey(scope('TPT3'), 7)), false, 'a release mark expires');
  assert.equal(await d.beginRelease(claimKey(scope('TPT4'), 7)), 'marked');
  m.running.delete(404);
  assert.equal(a.releasing(claimKey(scope('TPT4'), 7)), false, "an exited server's mark is ignored");
});

test('an unreadable registry keeps every claim, never holds back a run, and is logged once per server', async t => {
  const m = machine(t);
  const a = m.server(101);
  const b = m.server(202);
  const warning = "[device-session] this machine's claim registry is unavailable (state-invalid); open claims of this machine's device are kept";
  fs.writeFileSync(m.file, '{"version":1,"instances":{"x":');
  assert.equal(await b.beginRelease(TPT1), 'unavailable');
  assert.equal(await b.beginRelease(TPT2), 'unavailable');
  assert.deepEqual(m.warnings, [warning], 'the same failure is not logged again');
  const hold = await a.hold(TPT1);
  assert.equal(hold.releasing, false);
  assert.equal(a.releasing(TPT1), false);
  assert.deepEqual(m.warnings, [warning, warning], 'each server logs its own');
  fs.writeFileSync(m.file, JSON.stringify({ version: 1, instances: { [randomUUID()]: { pid: 101, claims: {} } } }));
  assert.equal(await b.beginRelease(TPT1), 'unavailable', 'a well-formed file of the wrong shape is invalid too');
  fs.writeFileSync(m.file, JSON.stringify({ version: 2, instances: { [randomUUID()]: { pid: 202, claims: {}, releases: { [TPT1]: m.clock.now } } } }));
  assert.equal(a.releasing(TPT1), false, 'nor does a file of another version');
  fs.rmSync(m.file);
  await a.drop(hold.id);
  assert.equal(await b.beginRelease(TPT1), 'marked', 'usable again once the file is');
});

test("a live server's lock is waited out; a dead server's lock is taken over", async t => {
  const m = machine(t);
  const b = m.server(202);
  fs.mkdirSync(m.lock);
  const ownerFile = path.join(m.lock, `999-${randomUUID()}`);
  fs.writeFileSync(ownerFile, '');
  m.running.add(999);
  assert.equal(await b.beginRelease(TPT1), 'unavailable');
  assert.match(m.warnings.at(-1), /unavailable \(lock-busy\)/);
  m.running.delete(999);
  assert.equal(await b.beginRelease(TPT1), 'marked');
  assert.equal(fs.existsSync(ownerFile), false);
  assert.equal(fs.existsSync(m.lock), false, 'the lock is released after each transaction');

  fs.mkdirSync(m.lock); // its owner died before naming itself
  assert.equal(await b.beginRelease(TPT2), 'unavailable', 'a fresh empty lock may still be named');
  const old = new Date(m.clock.now - 60_000);
  fs.utimesSync(m.lock, old, old);
  assert.equal(await b.beginRelease(TPT2), 'marked');
});

test('close() removes this server\'s entry; a server that never wrote touches nothing', async t => {
  const m = machine(t);
  m.server(101).close();
  assert.equal(fs.existsSync(m.file), false);
  const a = m.server(202);
  await a.hold(TPT1);
  await a.beginRelease(TPT2);
  a.close();
  assert.deepEqual(JSON.parse(fs.readFileSync(m.file, 'utf8')).instances, {});
  assert.equal(await m.server(303).beginRelease(TPT1), 'marked');
});

test('the file names claims by hash only', async t => {
  const m = machine(t);
  const a = m.server(101);
  await a.hold(TPT1);
  const text = fs.readFileSync(m.file, 'utf8');
  assert.ok(text.includes(TPT1));
  assert.ok(!text.includes('TPT1') && !text.includes('api.test'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(m.file).mode & 0o777, 0o600);
});

test('a lock its owner lets go of while this server retries is taken', async t => {
  let lockPath = null;
  const m = machine(t, { sleep: async () => { if (lockPath) fs.rmSync(lockPath, { recursive: true, force: true }); } });
  lockPath = m.lock;
  const b = m.server(202);
  fs.mkdirSync(m.lock);
  fs.writeFileSync(path.join(m.lock, `999-${randomUUID()}`), '');
  m.running.add(999);
  assert.equal(await b.beginRelease(TPT1), 'marked');
  assert.deepEqual(m.warnings, []);
});
