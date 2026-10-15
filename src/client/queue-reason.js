import { LOCALES, getLocale, t } from './i18n.js';

// Ramp admission: the cap a device-cap wait is measured against and when the shared ramp
// may raise it. Only well-formed integers render; anything else adds nothing.
function rampText({ rampCap, rampCeiling, rampNextStepAt, alarm, coordinationReason, detail }, now, coordination) {
  if (!Number.isSafeInteger(rampCap) || !Number.isSafeInteger(rampCeiling) || rampCap < 1 || rampCap > rampCeiling) return '';
  if (rampCap === rampCeiling) return '';
  const alarmKey = `queue.ramp.reason.${alarm}`;
  const reason = Object.hasOwn(LOCALES.en, alarmKey) ? t(alarmKey)
    : coordination || (alarm === 'coordination' || coordinationReason || detail ? t('queue.ramp.reason.coordination') : '');
  if (reason) return t('queue.ramp.held', { cap: rampCap, reason });
  if (alarm) return '';
  // Unknown or elapsed timing is not evidence that the limit will rise.
  if (!Number.isSafeInteger(rampNextStepAt) || rampNextStepAt <= now || !Number.isFinite(new Date(rampNextStepAt).getTime())) return '';
  const time = new Date(rampNextStepAt).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
  return t('queue.ramp.next', { next: rampCap + 1, time });
}

// Resolve only known translation keys. Transaction details can contain OS errors;
// never echo arbitrary server text into a terminal notice.
function coordinationText(diagnostic) {
  const detailKey = `queue.coordination.${diagnostic.detail}`;
  let key = Object.hasOwn(LOCALES.en, detailKey) ? detailKey : `queue.coordination.${diagnostic.coordinationReason}`;
  if (!Object.hasOwn(LOCALES.en, key)) return '';
  const pids = Array.isArray(diagnostic.unregisteredPids)
    ? diagnostic.unregisteredPids.filter(pid => Number.isSafeInteger(pid) && pid > 1) : [];
  if (diagnostic.coordinationReason === 'unregistered-server' && key.endsWith('.unregistered-server') && pids.length) {
    key += '-pids';
  }
  return t(key, { pids: pids.join(', '), count: pids.length });
}

export function queueReasonText(diagnostic = {}, now = Date.now()) {
  const reason = diagnostic.reason || 'device-cap';
  const reasonKey = `queue.reason.${reason}`;
  let base = t(Object.hasOwn(LOCALES.en, reasonKey) ? reasonKey : 'queue.reason.coordination');
  const coordination = coordinationText(diagnostic);
  if (reason === 'device-cap') {
    const cap = diagnostic.cap ?? diagnostic.rampCap;
    if (Number.isSafeInteger(diagnostic.running) && diagnostic.running >= 0 && Number.isSafeInteger(cap) && cap > 0) {
      base = t('queue.ramp.running', { running: diagnostic.running, cap });
    }
    const ramp = rampText(diagnostic, now, coordination);
    if (ramp) return `${base} ${ramp}`;
    if (Number.isSafeInteger(diagnostic.rampCap) && diagnostic.rampCap > 0 && diagnostic.rampCap === diagnostic.rampCeiling) return base;
  }
  return coordination ? (reason === 'coordination' ? coordination : `${base} ${coordination}`) : base;
}
