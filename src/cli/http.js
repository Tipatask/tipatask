'use strict';

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
// Sent unless the caller sets its own Accept-Encoding: the API's front end compresses a response
// only when the request asks for it.
const ACCEPT_ENCODING = 'gzip, deflate';

// A request destroy()ed before any response arrived (deadline, caller abort) makes Node emit a
// deferred "socket hang up" (ECONNRESET) 'error' on it from the socket's close handler — on a
// later tick, after the call already settled. With no 'error' listener left, EventEmitter throws
// it as an uncaught exception and the whole process exits. The call's outcome is already decided
// by then, so the settle path leaves this no-op behind to absorb the late event.
function ignoreLateRequestError() {}

// A zlib decoder reports a bad body by destroying itself with the error and emitting it on a later
// tick. A call that already settled (deadline, caller abort, wire error) leaves this no-op on the
// decoder, so that late event cannot become an uncaught exception — zlib codes are not
// network-class, so the server's crash guard would treat one as fatal.
function ignoreLateDecoderError() {}

// The content coding of a response body this helper decodes, or null when the body is used as
// received (no Content-Encoding, identity, or a coding it never asked for). HTTP's "deflate" is
// the zlib-wrapped format, which is what createInflate() expects.
function responseCoding(headers) {
  const value = String((headers && headers['content-encoding']) || '').trim().toLowerCase();
  if (value === 'gzip' || value === 'x-gzip') return 'gzip';
  if (value === 'deflate') return 'deflate';
  return null;
}

/**
 * Make an HTTP/HTTPS request with JSON support.
 * timeoutMs is a deadline for the whole operation, including the response body.
 * Asks for a gzip or deflate response unless opts.headers sets Accept-Encoding, and decodes one;
 * the response size limit applies to the decoded body.
 * @param {string} url
 * @param {{ method?: string, headers?: object, body?: object, timeoutMs?: number, signal?: AbortSignal }} opts
 * @returns {Promise<{ status: number, data: any }>}
 */
function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const payload = opts.body ? JSON.stringify(opts.body) : null;
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

    const headers = { ...opts.headers };
    if (!Object.keys(headers).some((name) => name.toLowerCase() === 'accept-encoding')) {
      headers['Accept-Encoding'] = ACCEPT_ENCODING;
    }
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    if (opts.signal && opts.signal.aborted) {
      const err = new Error('Request aborted');
      err.code = 'EABORT';
      return reject(err);
    }

    let req;
    let res;
    let coding = null;
    let decoder;
    let timer;
    let settled = false;
    let responseBytes = 0;
    const chunks = [];

    const onRequestError = (err) => {
      const wrapped = new Error(`Request to ${url} failed: ${err.message}`, { cause: err });
      if (err.code) wrapped.code = err.code;
      finish(wrapped, undefined, true);
    };
    const onResponseError = (err) => {
      const wrapped = new Error(`Response from ${url} failed: ${err.message}`, { cause: err });
      wrapped.code = err.code || 'ECONNRESET';
      finish(wrapped, undefined, true);
    };
    const onResponseAborted = () => {
      const err = new Error(`Response from ${url} was aborted`);
      err.code = 'ECONNRESET';
      finish(err, undefined, true);
    };
    const onResponseClose = () => {
      const err = new Error(`Response from ${url} closed before completion`);
      err.code = 'ECONNRESET';
      finish(err, undefined, true);
    };
    const onResponseData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      responseBytes += buffer.length;
      if (responseBytes > MAX_RESPONSE_BYTES) {
        const err = new Error(`Response from ${url} exceeded ${MAX_RESPONSE_BYTES} bytes`);
        err.code = 'ERR_RESPONSE_TOO_LARGE';
        finish(err, undefined, true);
        return;
      }
      chunks.push(buffer);
    };
    // Compressed body bytes. The decoder starts on the first of them, so a bodyless reply that
    // still names a coding (HEAD, 204, 304) never reaches zlib, which rejects empty input as a
    // truncated stream.
    const onEncodedData = (chunk) => {
      if (!decoder) {
        decoder = coding === 'gzip' ? zlib.createGunzip() : zlib.createInflate();
        decoder.on('data', onResponseData);
        decoder.on('end', onBodyEnd);
        decoder.on('error', onResponseError);
      }
      decoder.write(chunk);
    };
    const onResponseEnd = () => {
      if (res.complete === false) {
        const err = new Error(`Response from ${url} ended before completion`);
        err.code = 'ECONNRESET';
        finish(err, undefined, true);
        return;
      }
      if (decoder) {
        // The wire body is complete; from here the decoder's 'end' or 'error' settles the call.
        // Node closes the response right after this 'end', before the decoder has flushed, so
        // that close no longer means a cut-off reply.
        res.off('close', onResponseClose);
        decoder.end();
        return;
      }
      onBodyEnd();
    };
    const onBodyEnd = () => {
      const raw = Buffer.concat(chunks, responseBytes).toString();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw;
      }
      finish(null, { status: res.statusCode, data });
    };
    const onAbort = () => {
      const err = new Error(`Request to ${url} aborted`);
      err.code = 'EABORT';
      finish(err, undefined, true);
    };

    function finish(err, value, destroy = false) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (destroy) {
        if (req) req.destroy();
        if (res) res.destroy();
      }
      if (req) {
        req.off('error', onRequestError);
        req.on('error', ignoreLateRequestError);
      }
      if (res) {
        res.off('data', onResponseData);
        res.off('data', onEncodedData);
        res.off('end', onResponseEnd);
        res.off('error', onResponseError);
        res.off('aborted', onResponseAborted);
        res.off('close', onResponseClose);
      }
      if (decoder) {
        decoder.off('data', onResponseData);
        decoder.off('end', onBodyEnd);
        decoder.off('error', onResponseError);
        decoder.on('error', ignoreLateDecoderError);
        decoder.destroy();
      }
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(value);
    }

    req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: opts.method || (payload ? 'POST' : 'GET'),
        headers,
      },
      (response) => {
        if (settled) {
          response.destroy();
          return;
        }
        res = response;
        coding = responseCoding(res.headers);
        res.on('data', coding ? onEncodedData : onResponseData);
        res.on('end', onResponseEnd);
        res.on('error', onResponseError);
        res.on('aborted', onResponseAborted);
        res.on('close', onResponseClose);
      },
    );
    if (settled) return;
    req.on('error', onRequestError);
    timer = setTimeout(() => {
      const err = new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      finish(err, undefined, true);
    }, timeoutMs);

    if (opts.signal) {
      opts.signal.addEventListener('abort', onAbort, { once: true });
      if (opts.signal.aborted) onAbort();
    }
    if (settled) return;
    try {
      if (payload) req.write(payload);
      req.end();
    } catch (err) {
      finish(err, undefined, true);
    }
  });
}

module.exports = { request, DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES };
