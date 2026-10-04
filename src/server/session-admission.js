'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { MiB, resolveAdmissionPolicy, resolveWorkload, estimatePeak, decideAdmission } = require('./admission-policy');
const { createAdmissionCoordinator, parseServerCensus } = require('./admission-coordinator');
const { createCommandRunner } = require('./host-memory');
const { readProjectConfig } = require('./project-config');

function createSessionAdmission({ getSessions, getTelemetry, isRunning, resolvePolicy = resolveAdmissionPolicy,
  coordinator = createAdmissionCoordinator(), now = Date.now, runner = createCommandRunner(),
  readProject = readProjectConfig, env = process.env,
  onChange = () => {}, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  const records = new Map();
  const waiting = new Map();
  let timer = null, stopped = false, inFlight = null, census = null, censusAt = null, diagnostic = null;
  const projectKey = project => createHash('sha256').update(project || '').digest('hex');
  function localSlots(telemetry, policy) {
    const live = new Set(getSessions().values());
    const rows = new Map((telemetry?.processes?.rows || []).map(row => [row.id, row]));
    for (const session of live) {
      if (!records.has(session) && (isRunning(session) || (session.alive && session.ptyPid))) {
        records.set(session, { id: randomUUID(), estimate: estimatePeak(policy, session, telemetry?.history).bytes });
      }
    }
    const slots = [];
    for (const [session, record] of records) {
      if (!live.has(session) || (!isRunning(session) && !session.alive && !session._starting)) { records.delete(session); continue; }
      record.estimate = Math.max(record.estimate, estimatePeak(policy, session, telemetry?.history).bytes);
      const row = rows.get(session._memoryRunId);
      const valid = telemetry?.processes?.fresh && row?.currentRssBytes != null;
      const observable = valid ? row.observableRssBytes : null;
      if (observable == null || (record.observedAt != null && now() - record.observedAt > policy.staleMs)) {
        record.coveredBytes = 0; record.observedAt = null;
      }
      // Credit only a prior process observation covered by this host sample. A
      // later smaller measurement limits credit immediately; a later larger one
      // waits for the next host sample. Unknown attribution keeps full reservation.
      if (observable != null && record.observedAt != null && telemetry?.host?.sampledAt >= record.observedAt) {
        record.coveredBytes = record.observedBytes;
      }
      const credit = observable != null ? Math.min(record.coveredBytes || 0, observable) : 0;
      if (observable != null) { record.observedBytes = observable; record.observedAt = telemetry.processes.sampledAt; }
      const running = isRunning(session);
      const remainder = running ? Math.max(0, record.estimate - credit) : 0;
      if (valid) record.lastPeak = row.peakRssBytes || row.currentRssBytes;
      const gap = valid ? (row.peakMinusCurrentBytes || 0) : Math.max(record.estimate, record.lastPeak || 0);
      slots.push({ id: record.id, project: projectKey(session.projectPath), running,
        pid: session.alive ? session.ptyPid || null : null,
        reservedBytes: remainder, gapBytes: Math.max(0, gap - remainder) });
    }
    return slots;
  }
  function transact(session, projectCap, reserve) {
    if (session && !records.has(session)) {
      let config;
      try { config = readProject(session.projectPath); } catch { /* unknown */ }
      Object.assign(session, resolveWorkload(config, env));
    }
    const time = now(), policy = resolvePolicy(), telemetry = getTelemetry();
    const live = new Set(getSessions().values());
    for (const s of waiting.keys()) if (!live.has(s) || !s._queued || s._terminated) waiting.delete(s);
    if (session && !waiting.has(session)) waiting.set(session, { id: randomUUID(), projectCap });
    if (session) waiting.get(session).projectCap = projectCap;
    const local = localSlots(telemetry, policy);
    const estimate = estimatePeak(policy, session || {}, telemetry?.history);
    const tx = coordinator.transaction((state, instance) => {
      const previousQueue = state.instances[instance]?.queued || [];
      const queued = [...waiting].map(([s, entry]) => {
        entry.ticket = previousQueue.find(e => e.id === entry.id)?.ticket || (state.nextTicket = (state.nextTicket || 0) + 1);
        return { id: entry.id, ticket: entry.ticket, project: projectKey(s.projectPath), projectCap: entry.projectCap,
          estimateBytes: estimatePeak(policy, s, telemetry?.history).bytes };
      });
      const ownIds = new Set([...records.keys()].map(s => s._memoryRunId));
      const extraGapBytes = (telemetry?.processes?.rows || []).filter(r => !ownIds.has(r.id))
        .reduce((sum, r) => sum + (r.peakMinusCurrentBytes ?? policy.unknownMiB * MiB), 0);
      state.instances[instance] = { pid: coordinator.pid, at: time, fingerprint: policy.fingerprint,
        mode: policy.mode, staticCap: policy.staticCap, fallbackCap: policy.fallbackCap, slots: local, queued, extraGapBytes };
      const owners = Object.values(state.instances);
      const registered = new Set(owners.map(o => o.pid));
      const censusFresh = censusAt !== null && time >= censusAt && time - censusAt <= policy.staleMs;
      const unregisteredPids = censusFresh && census ? census.filter(pid => !registered.has(pid)) : null;
      const unregisteredCount = unregisteredPids?.length || 0;
      const unregistered = unregisteredCount > 0;
      const doubtful = o => o.orphaned || o.stopped || time < o.at || time - o.at > policy.staleMs;
      const uncertain = owners.some(doubtful);
      const coordinated = censusFresh && census?.includes(coordinator.pid) && !unregistered && !uncertain
        && owners.every(o => o.fingerprint === policy.fingerprint);
      const slots = owners.flatMap(o => o.slots);
      // Conservative count: every slot of a stopped/orphaned/stale owner and one
      // slot per unregistered server count as running, whatever their flags say.
      const running = owners.reduce((sum, o) => sum + (doubtful(o) ? o.slots.length
        : o.slots.filter(s => s.running).length), 0) + unregisteredCount;
      const sameProject = slots.filter(s => s.running && s.project === projectKey(session?.projectPath)).length;
      const effective = { ...policy,
        mode: owners.some(o => o.mode === 'pressure') ? 'pressure' : policy.mode,
        fallbackCap: Math.min(policy.fallbackCap, ...owners.map(o => o.fallbackCap)) };
      // Static mode under coordination doubt caps the conservative count at the
      // shared fallback instead of refusing outright.
      if ((unregistered || uncertain) && effective.mode !== 'pressure') {
        effective.staticCap = Math.min(effective.staticCap, effective.fallbackCap);
      }
      let decision = decideAdmission({ policy: effective, state: state.pressure, telemetry, now: time,
        running, coordinated, projectBlocked: Number.isInteger(projectCap) && sameProject >= projectCap,
        reservedBytes: slots.reduce((sum, s) => sum + s.reservedBytes, 0),
        peakGapBytes: slots.reduce((sum, s) => sum + s.gapBytes, 0) + owners.reduce((sum, o) => sum + (o.extraGapBytes || 0), 0),
        estimateBytes: estimate.bytes });
      // Pressure mode cannot size dynamic expansion against unregistered/stale owners;
      // never give each instance an independent allowance there. Static mode already
      // counted them conservatively above.
      if ((unregistered || uncertain) && effective.mode === 'pressure') {
        decision = { ...decision, allowed: false, reason: 'coordination' };
      }
      if (session && decision.allowed) {
        const earlier = owners.flatMap(o => o.queued || []).filter(e => e.ticket < waiting.get(session).ticket);
        const eligible = earlier.some(e => {
          const count = slots.filter(s => s.running && s.project === e.project).length;
          if (Number.isInteger(e.projectCap) && count >= e.projectCap) return false;
          return decision.mode !== 'pressure' || decision.headroomBytes >= decision.requiredBytes - estimate.bytes + e.estimateBytes;
        });
        if (eligible) decision = { ...decision, allowed: false, reason: 'fifo' };
      }
      if (reserve && decision.allowed) {
        const record = { id: randomUUID(), estimate: estimate.bytes };
        records.set(session, record);
        state.instances[instance].slots.push({ id: record.id, project: projectKey(session.projectPath),
          running: true, pid: null, reservedBytes: estimate.bytes, gapBytes: 0 });
        state.pressure.lastStartAt = time;
        state.instances[instance].queued = queued.filter(e => e.id !== waiting.get(session).id);
        waiting.delete(session);
      }
      return { ...decision, running: running + (reserve && decision.allowed ? 1 : 0), coordinated: !!coordinated, estimate,
        coordinationReason: unregistered ? 'unregistered-server' : uncertain ? 'stale-or-orphaned-owner'
          : !censusFresh || !census?.includes(coordinator.pid) ? 'census-unavailable'
            : !coordinated ? 'mismatched-policy' : null,
        reservedBytes: slots.reduce((sum, s) => sum + s.reservedBytes, 0) + (reserve && decision.allowed ? estimate.bytes : 0), policy,
        alarm: state.pressure.alarm, instances: owners.length, detail: null,
        censusPidCount: censusFresh && census ? census.length : null,
        unregisteredPids, unregisteredCount: unregisteredPids?.length ?? null };
    });
    // Failed transactions cannot establish ownership; never reuse a previous owner
    // count or report unknown unregistered servers as zero.
    const censusFresh = censusAt !== null && time >= censusAt && time - censusAt <= policy.staleMs;
    diagnostic = tx.ok ? tx.result : { allowed: false, reason: 'coordination', detail: tx.detail,
      coordinationReason: null, instances: null, unregisteredPids: null, unregisteredCount: null,
      censusPidCount: censusFresh && census ? census.length : null, policy, cap: policy.fallbackCap };
    return diagnostic;
  }
  async function poll() {
    if (stopped || inFlight) return inFlight;
    inFlight = (async () => {
      const due = censusAt === null || now() - censusAt >= 5000 || now() < censusAt;
      const output = due ? await runner.run('/bin/ps', ['-Ao', 'pid=,args=']) : null;
      const comm = due && output !== null && !stopped ? await runner.run('/bin/ps', ['-Ao', 'pid=,comm=']) : null;
      if (stopped) return;
      if (due) { census = comm === null ? null : parseServerCensus(output, comm); censusAt = now(); }
      transact(null, null, false);
      onChange();
    })().catch(() => { census = null; }).finally(() => { inFlight = null; });
    return inFlight;
  }
  return {
    tryReserve: (session, projectCap) => transact(session, projectCap, true),
    inspect: (session, projectCap) => transact(session, projectCap, false),
    snapshot: () => diagnostic,
    poll,
    start() { if (timer !== null || stopped) return; timer = setIntervalFn(poll, 1000); timer.unref?.(); void poll(); },
    stop() { if (stopped) return; stopped = true; if (timer !== null) clearIntervalFn(timer); timer = null; runner.stop(); coordinator.stop(); },
  };
}

module.exports = { createSessionAdmission };
