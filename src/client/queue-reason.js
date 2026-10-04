import { LOCALES, t } from './i18n.js';

// Resolve only known translation keys. Transaction details can contain OS errors;
// never echo arbitrary server text into a terminal notice.
export function queueReasonText(diagnostic = {}) {
  const reasonKey = `queue.reason.${diagnostic.reason || 'device-cap'}`;
  const base = t(Object.hasOwn(LOCALES.en, reasonKey) ? reasonKey : 'queue.reason.coordination');
  const detailKey = `queue.coordination.${diagnostic.detail}`;
  let key = Object.hasOwn(LOCALES.en, detailKey) ? detailKey : `queue.coordination.${diagnostic.coordinationReason}`;
  if (!Object.hasOwn(LOCALES.en, key)) return base;
  const pids = Array.isArray(diagnostic.unregisteredPids)
    ? diagnostic.unregisteredPids.filter(pid => Number.isSafeInteger(pid) && pid > 1) : [];
  if (diagnostic.coordinationReason === 'unregistered-server' && key.endsWith('.unregistered-server') && pids.length) {
    key += '-pids';
  }
  const specific = t(key, { pids: pids.join(', '), count: pids.length });
  return diagnostic.reason === 'coordination' ? specific : `${base} ${specific}`;
}
