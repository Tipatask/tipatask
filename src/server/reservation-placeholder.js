'use strict';

// ── Reservation placeholder detection (C980 / C1017) ──
//
// Shared by api-backend.js and id-remap.js so both agree on what "still just an
// unfinalized reserve_task_keys row" means. Kept dependency-free (no require of
// api-backend.js, which pulls in HTTP/credentials machinery id-remap.js has no
// business touching).
//
// Primary signal is the `isReservation` flag (C1017, mapped from the API's
// `is_reservation` column by api-backend.js's fromApi()). The legacy
// status+description sentinel check is kept as a fallback for rows created
// before the flag existed, or read from an API deployment that predates it.
const RESERVED_PLACEHOLDER_DESCRIPTION = 'Reserved key — pending finalization.';

function isReservationPlaceholder(task) {
  if (!task) return false;
  if (task.isReservation === true) return true;
  if (task.isReservation === false) return false;
  // Fallback for pre-flag rows/deployments where isReservation is absent.
  //
  // C1187 note: the 'pending' literal here is deliberately NOT resolved via this
  // project's workflow-start role name. `tasks.status` (api/src/migrations/041_task_
  // statuses.js) keeps a literal `DEFAULT 'pending'` at the DB column level — a bare
  // reservation INSERT relies on that schema default, not on project_task_statuses —
  // so an old (pre-isReservation-flag) placeholder row is 'pending' at the DB layer
  // regardless of what this project's configured start status is named. Matching the
  // resolved start-role name here instead would make the fallback stop recognizing
  // exactly the rows it exists to catch.
  return task.status === 'pending' && task.description === RESERVED_PLACEHOLDER_DESCRIPTION;
}

module.exports = { isReservationPlaceholder, RESERVED_PLACEHOLDER_DESCRIPTION };
