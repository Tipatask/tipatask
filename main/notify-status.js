'use strict';

// Delivery status for Settings ▸ Notifications (main.js `notify:status`) and the health rule
// that decides when a native OS notification cannot reach the user. No `electron` import:
// main.js passes its bundle-health state in, so both are unit-testable.

// Why the OS would drop a native notification from this app, or null. macOS refuses a bundle
// whose code seal is broken and one it has not registered with Notification Center; health that
// was never read (null/undefined) is not a blocker. The reasons match the Settings hints in
// src/client/notifications.js (`lastError`).
function nativeDeliveryBlocker({ signature = null, registered = null } = {}) {
  if (signature?.signed === false) return 'unsigned';
  if (signature?.valid === false) return 'seal-broken';
  if (registered === false) return 'not-registered';
  return null;
}

// The `notify:status` result while "Show on Top" is off (`onTop: false`, the saved choice the
// Settings switch shows). `delivery` is what a send uses right now (the desktop controller's
// delivery()): 'native', or 'desktop' when the banner stands in because native delivery is
// blocked — `fallback` then names why. The bundle-health fields follow either way, so Settings
// can explain a blocked native path. `supported` is read only for native delivery: asking
// creates the OS notification presenter.
function offStatus({ delivery, fallback = null, supported = () => true, signature = null, registered = null,
  registration = null } = {}) {
  const desktop = delivery !== 'native';
  let available = true;
  if (!desktop) { try { available = !!supported(); } catch { available = false; } }
  return {
    delivery: desktop ? 'desktop' : 'native',
    ...(desktop && fallback ? { fallback } : {}),
    onTop: false,
    available,
    ...(signature || { valid: null, reason: 'not-checked', relaunchNeeded: false }),
    registered,
    conflicts: registration?.conflicts ?? null,
    installerVolumes: registration?.installerVolumes ?? [],
    registrationRepair: registration?.repair ?? null,
  };
}

module.exports = { nativeDeliveryBlocker, offStatus };
