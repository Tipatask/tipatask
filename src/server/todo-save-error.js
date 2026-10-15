'use strict';

// Maps an error thrown on the PUT /api/todo save path to the HTTP status and JSON body the
// route answers with. Pure — no I/O, no logging.
//
// The status is the save's retry contract with the client, so 500 is kept for the one case
// it describes: an unexpected failure inside this server. Everything with a known cause gets
// its own status — a payload the save rejects (4xx), the Tipatask API failing (502) or
// unreachable behind this server (503, including a reverse-proxy gateway status) — and the
// body always carries the real message, the step that threw, and a stable code where there
// is one.

const CODE_STATUS = {
  TODO_PAYLOAD_INVALID: 400,
  TAGS_UNREGISTERED: 422,
  NEW_TAG_DESCRIPTION_MISSING: 422,
  TAG_REGISTRY_UNREADABLE: 502,
  RESERVE_FAILED: 502,
};

// err: whatever the save path threw. step: the handler-level step that was running, used
// when the error carries no finer-grained `saveStep` of its own (api-backend.js tags those).
function classifySaveError(err, step = null) {
  const message = (err && err.message) || String(err);
  const upstream = Number(err && err.statusCode);
  let status = 500;
  let code = err && typeof err.code === 'string' ? err.code : null;
  let error = message;

  if (err && err.missingCredentials) {
    status = 401;
    code = 'MISSING_CREDENTIALS';
  } else if (Number.isInteger(upstream) && upstream >= 400 && upstream < 500) {
    // The API (or the local auth guard) rejected the request — its status is the answer.
    status = upstream;
  } else if (err && err.networkError) {
    // Unreachable wins over a 5xx status: a reverse-proxy 502/503/504 carries both
    // (api-backend.js flags gateway statuses as network failures) and is an outage, not
    // an API error. A bare 5xx below is the app itself failing.
    status = 503;
    code = 'API_UNREACHABLE';
  } else if (Number.isInteger(upstream) && upstream >= 500) {
    status = 502;
    code = 'API_ERROR';
    error = `Tipatask API error: ${message}`;
  } else if (code && CODE_STATUS[code]) {
    status = CODE_STATUS[code];
  }

  return { status, body: { error, step: (err && err.saveStep) || step || null, code } };
}

module.exports = { classifySaveError, CODE_STATUS };
