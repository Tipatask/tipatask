'use strict';

// Delivery status for Settings ▸ Notifications (main.js `notify:status`) while "Show on Top" is
// off. No `electron` import: main.js passes its bundle-health state in, so it is unit-testable.

// The `notify:status` result while "Show on Top" is off (`onTop: false`, the saved choice the
// Settings switch shows). Sends are then native OS notifications only — the desktop banner is
// never used while the setting is off — so the bundle-health fields follow, letting Settings
// explain a blocked native path (an unsigned or broken seal, no Notification Center
// registration, duplicate registrations). `supported` is asked once: asking creates the OS
// notification presenter.
function offStatus({ supported = () => true, signature = null, registered = null, registration = null } = {}) {
  let available = true;
  try { available = !!supported(); } catch { available = false; }
  return {
    delivery: 'native',
    onTop: false,
    available,
    ...(signature || { valid: null, reason: 'not-checked', relaunchNeeded: false }),
    registered,
    conflicts: registration?.conflicts ?? null,
    installerVolumes: registration?.installerVolumes ?? [],
    registrationRepair: registration?.repair ?? null,
  };
}

module.exports = { offStatus };
