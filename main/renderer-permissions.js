'use strict';

// Chromium permissions the app's renderer windows may use. Electron hands every renderer
// permission to the session's request handler (asked when a page requests one) and its check
// handler (asked for the synchronous status reads, e.g. `Notification.permission`); once a
// handler is installed, anything it does not allow is denied, with no prompt.
//
// - `media`: the microphone for voice input (getUserMedia).
// - `notifications`: the Web Notifications fallback path (C1057). The check handler matters
//   here: without it the renderer kept reading `Notification.permission === 'denied'`.
// - `clipboard-sanitized-write`: navigator.clipboard.writeText() / write(). Chromium asks the
//   request handler for it on every call, even inside a click, and a denial rejects the write
//   with "NotAllowedError: ... Write permission denied." — which broke every Copy button.
//
// Reading the clipboard (`clipboard-read`, navigator.clipboard.readText()) stays denied: paste
// goes through the paste event's own clipboardData, which needs no permission.
const ALLOWED_RENDERER_PERMISSIONS = Object.freeze(['media', 'notifications', 'clipboard-sanitized-write']);

function isRendererPermissionAllowed(permission) {
  return ALLOWED_RENDERER_PERMISSIONS.includes(permission);
}

// Installs the request and check handlers on an Electron session (session.defaultSession).
function installRendererPermissions(ses) {
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(isRendererPermissionAllowed(permission));
  });
  ses.setPermissionCheckHandler((_webContents, permission) => isRendererPermissionAllowed(permission));
}

module.exports = { ALLOWED_RENDERER_PERMISSIONS, isRendererPermissionAllowed, installRendererPermissions };
