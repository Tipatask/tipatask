'use strict';

function decodeRequestComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch (err) {
    if (!(err instanceof URIError)) throw err;
    const badRequest = new Error('Malformed URL encoding');
    badRequest.code = 'INVALID_URL_ENCODING';
    throw badRequest;
  }
}

function logHttpError(label, err) {
  try { console.error(label, err && err.stack || err); } catch {}
}

function closeRejectedResponse(res) {
  try { res.destroy(); }
  catch (err) { logHttpError('[http] failed to close rejected response:', err); }
}

function wrapHttpHandler(handler) {
  return (req, res) => {
    let pending;
    try {
      // Enter the route immediately so it captures request scope before another
      // request can switch the active project.
      pending = handler(req, res);
    } catch (err) {
      pending = Promise.reject(err);
    }
    return Promise.resolve(pending).catch((err) => {
      logHttpError('[http] request handler failed:', err);
      if (res.destroyed || res.writableEnded) return;

      try {
        if (res.headersSent) {
          closeRejectedResponse(res);
          return;
        }
        const badUrl = err && err.code === 'INVALID_URL_ENCODING';
        res.writeHead(badUrl ? 400 : 500, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(badUrl ? 'Bad request' : 'Internal server error');
      } catch (responseErr) {
        logHttpError('[http] failed to finish rejected response:', responseErr);
        closeRejectedResponse(res);
      }
    });
  };
}

module.exports = { decodeRequestComponent, wrapHttpHandler };
