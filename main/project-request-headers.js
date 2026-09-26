'use strict';

const { stampElectronRequest } = require('../src/server/local-access');

// Registers the single default-session header callback. stampElectronRequest() strips
// every casing of the capability and project headers, then re-adds them only for the
// local Task App HTTP/WS listener and only for windows main has bound (a welcome window
// is bound with a null project and still gets a capability). Redirect targets are
// evaluated by their own URL, so external hops never inherit them.
function installProjectRequestHeaders(defaultSession, { projectDirs, port, secret,
  getProjectPath = (id) => projectDirs.get(id) || '', log = console.log }) {
  defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const knownWindow = projectDirs.has(details.webContentsId);
    const projectPath = knownWindow ? getProjectPath(details.webContentsId) || '' : '';
    const headers = stampElectronRequest(details.requestHeaders || {}, {
      requestUrl: details.url, port, secret, projectPath, knownWindow,
    });
    if (details.url.includes('/api/trello/')) {
      log('[main] trello req wcId=%s projectPath=%s url=%s', details.webContentsId, projectPath || '<none>', details.url);
    }
    callback({ requestHeaders: headers });
  });
}

module.exports = { installProjectRequestHeaders };
