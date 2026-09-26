'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { exec } = require('node:child_process');
const { request } = require('./http');

// C1249: authenticate() used to talk to Google directly (CLI credentials below,
// exchanged locally, then verified server-side via POST /auth/google/token).
// It now opens the web sign-in page instead — the page offers Google SSO *and*
// email+password, and the desktop app just waits on its loopback callback for
// whichever one the user finishes with. The Google credentials below are dead
// now that nothing in this file talks to Google directly; nothing else in the
// repo references them (grep-verified) — GOOGLE_CLI_CLIENT_ID/SECRET were only
// ever consumed by the code removed here.
const AUTH_TIMEOUT_MS = 300_000; // was 120s for "click one Google account"; a
// password + optional 2FA code takes longer to type, hence the raise.

/**
 * Open a URL in the default browser.
 * Tries the `open` npm package first, then platform-specific fallback.
 * @param {string} url
 */
async function openBrowser(url) {
  try {
    const open = (await import('open')).default;
    await open(url);
    return true;
  } catch {
    // Fallback: macOS `open` command
    return new Promise((resolve) => {
      exec(`open "${url}"`, (err) => resolve(!err));
    });
  }
}

/**
 * Start a temporary local server to capture the web sign-in handoff (C1249).
 * Bound to 127.0.0.1 only — not all interfaces — so nothing off-box can reach
 * it. A `nonce` is required on every request; a mismatch is rejected with 403
 * but the server keeps listening (killing it on a bad nonce would let anyone
 * on localhost abort a real in-flight sign-in).
 * @returns {Promise<{ server: http.Server, port: number, nonce: string, waitForToken: Promise<{ token: string }> }>}
 */
async function startCallbackServer() {
  const nonce = crypto.randomBytes(16).toString('hex');
  let resolveToken, rejectToken;
  const waitForToken = new Promise((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1`);

    if (url.pathname !== '/callback') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const token = url.searchParams.get('token');
    const gotNonce = url.searchParams.get('nonce');
    const error = url.searchParams.get('error');

    if (gotNonce !== nonce) {
      // Wrong/missing nonce — not necessarily the real flow (any local
      // process can hit this port). Reject this request only; keep waiting.
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end('<html><body>Forbidden</body></html>');
      return;
    }

    // Response headers scrub the token from history/cache the moment it's
    // been consumed once — belt-and-suspenders given the token also sat in
    // the address bar to get here.
    const noStoreHeaders = {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    };

    if (error || !token) {
      res.writeHead(400, noStoreHeaders);
      res.end(`
        <html><head><meta name="referrer" content="no-referrer"></head><body style="font-family:system-ui;text-align:center;padding:60px">
          <h2>Sign-in failed</h2>
          <p>${error || 'No token received.'}</p>
          <p>You can close this tab and try again.</p>
          <script>history.replaceState(null,'','/done');</script>
        </body></html>
      `);
      rejectToken(new Error(error || 'No token received'));
      return;
    }

    res.writeHead(200, noStoreHeaders);
    res.end(`
      <html><head><meta name="referrer" content="no-referrer"></head><body style="font-family:system-ui;text-align:center;padding:60px">
        <h2 style="color:#22c55e">Signed in!</h2>
        <p>You can close this tab and return to TipATask.</p>
        <script>history.replaceState(null,'','/done');</script>
      </body></html>
    `);

    resolveToken({ token });
  });

  // listen() returns before Node has bound the socket, so server.address() can
  // still be null here. Resolve only from the listening callback and validate
  // the address shape before handing a port to the browser handoff.
  const port = await new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onError = (error) => {
      cleanup();
      reject(new Error(`Could not start the desktop sign-in callback on 127.0.0.1: ${error.message}`, { cause: error }));
    };
    const onListening = () => {
      cleanup();
      try {
        resolve(resolveCallbackPort(server));
      } catch (error) {
        server.close();
        reject(error);
      }
    };

    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(0, '127.0.0.1');
    } catch (error) {
      onError(error);
    }
  });

  // Timeout
  const timer = setTimeout(() => {
    rejectToken(new Error('Sign-in timed out (5 min). Please try again.'));
    server.close();
  }, AUTH_TIMEOUT_MS);

  // Clear timeout once a token (or a fatal error) is received
  waitForToken.then(
    () => clearTimeout(timer),
    () => clearTimeout(timer),
  );

  return { server, port, nonce, waitForToken };
}

function resolveCallbackPort(server) {
  const address = server.address();
  if (
    !address
    || typeof address === 'string'
    || !Number.isInteger(address.port)
    || address.port < 1
    || address.port > 65_535
  ) {
    throw new Error('Could not determine the desktop sign-in callback port. Please try Sign in again.');
  }
  return address.port;
}

/**
 * Sign in via the web sign-in page (C1249). Opens the system browser at the
 * Tipatask sign-in page carrying this loopback server's port + a nonce; the
 * user signs in there by any method (email+password, 2FA, or Google SSO —
 * the page offers all of them). Whichever method they finish with redirects
 * the browser back to `http://127.0.0.1:<port>/callback?token=…&nonce=…`,
 * which is how the token gets back here without this process ever touching
 * Google (or any other provider) directly.
 *
 * `deps.chooseAccount` — the Project ▸ Re-authenticate / Change Account path. Appends
 * `choose_account=1` to the sign-in URL so the web page asks "continue as the account this
 * browser is already signed in as, or use a different one?" instead of silently handing the
 * existing browser session straight back (its default, which is right for a first sign-in).
 *
 * @param {string} apiBaseUrl - The Tipatask API base URL
 * @param {{ startServer?: typeof startCallbackServer, browser?: typeof openBrowser, requestImpl?: typeof request, chooseAccount?: boolean }} [deps]
 * @returns {Promise<{ token: string, user: object }>}
 */
async function authenticate(apiBaseUrl, deps = {}) {
  const startServer = deps.startServer || startCallbackServer;
  const browser = deps.browser || openBrowser;
  const requestImpl = deps.requestImpl || request;
  const { server, port, nonce, waitForToken } = await startServer();

  const desktopParam = Buffer.from(JSON.stringify({ port, nonce })).toString('base64url');
  const signinUrl = `${apiBaseUrl}/#/login?d=${desktopParam}${deps.chooseAccount ? '&choose_account=1' : ''}`;

  console.log('  Opening browser to sign in...\n');
  const opened = await browser(signinUrl);
  if (!opened) {
    console.log('  Could not open browser automatically.');
    console.log('  Please open this URL manually:\n');
    console.log(`  ${signinUrl}\n`);
  }

  let result;
  try {
    result = await waitForToken;
  } finally {
    server.close();
  }

  const token = result.token;

  // Hydrate the user profile the same way the old Google-direct flow did —
  // callers (setup.js, main.js) expect { token, user } back.
  const { status, data } = await requestImpl(`${apiBaseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (status >= 400) {
    const msg = typeof data === 'object' ? data.message || data.error || JSON.stringify(data) : data;
    throw new Error(`Sign-in succeeded but fetching the account failed: ${msg}`);
  }

  return { token, user: data.user || {} };
}

async function exchangeProjectToken(apiBaseUrl, userToken, projectId) {
  const { status, data } = await request(`${apiBaseUrl}/api/auth/project-token`, {
    headers: { Authorization: `Bearer ${userToken}` },
    body: { project_id: projectId },
  });
  if (status >= 400) {
    const msg = typeof data === 'object' ? data.message || data.error || JSON.stringify(data) : data;
    throw new Error(`Project token exchange failed: ${msg}`);
  }
  const token = data.token;
  if (!token) throw new Error('Project token exchange returned no token');
  return token;
}

module.exports = { authenticate, exchangeProjectToken, startCallbackServer, resolveCallbackPort };
