'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// config.js snapshots these before ws-handlers.js is loaded. Keep test writes out
// of the checked-out project, even when a developer has no configured API account.
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-static-project-'));
process.env.TIPATASK_PROJECT_ROOT = projectRoot;
process.env.TASK_BACKEND = 'api';

const config = require('./config');
const { createHttpHandler } = require('./ws-handlers');
const handler = createHttpHandler(new Map(), () => ({}));

function request(url, method = 'GET') {
  const res = {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
  return handler({ method, url, headers: {} }, res).then(() => res);
}

function write(root, name, content) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

test('static handler serves only named build assets in checkout and packaged layouts', async (t) => {
  const originalDist = config.DIST;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-static-assets-'));
  t.after(() => {
    config.DIST = originalDist;
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  for (const layout of ['checkout', 'packaged']) {
    // A directory named app.asar models the path that Electron's patched fs
    // exposes from the archive; the same real handler resolves both layouts.
    const serverRoot = path.join(scratch, layout, layout === 'packaged' ? 'Resources/app.asar' : 'ai/todo/server');
    const dist = path.join(serverRoot, 'dist');
    config.DIST = dist;
    write(dist, 'todo.html', '<html>Task App</html>');
    write(dist, 'bundle.js', 'window.board = true;');
    write(dist, 'bundle.css', 'body { color: teal }');
    write(dist, 'marked.min.js', 'window.marked = {};');
    write(dist, 'favicon.svg', '<svg/>');
    write(dist, 'favicon.ico', 'ico');

    for (const [url, name] of [
      ['/', 'todo.html'], ['/todo.html', 'todo.html'], ['/bundle.js', 'bundle.js'],
      ['/bundle.css', 'bundle.css'], ['/marked.min.js', 'marked.min.js'],
      ['/favicon.svg', 'favicon.svg'], ['/favicon.ico', 'favicon.ico'],
    ]) {
      const res = await request(url);
      assert.equal(res.status, 200, `${layout}: ${url}`);
      assert.deepEqual(res.body, fs.readFileSync(path.join(dist, name)), `${layout}: ${url}`);
    }
    assert.equal((await request('/bundle.js?cache=1')).status, 200, `${layout}: query string`);
    const head = await request('/marked.min.js', 'HEAD');
    assert.equal(head.status, 200, `${layout}: HEAD`);
    assert.equal(head.body, undefined, `${layout}: HEAD has no body`);

    for (const name of [
      '.env', '.chat-draft.json', 'chat-state.json', 'src/server/config.js',
      '.git/config', 'package.json', 'logs/server.log', 'node_modules/marked/marked.min.js',
    ]) write(serverRoot, name, `private ${name}`);
    for (const url of [
      '/.env', '/.chat-draft.json', '/chat-state.json', '/src/server/config.js',
      '/.git/config', '/package.json', '/logs/server.log',
      '/node_modules/marked/marked.min.js', '/dist/bundle.js',
      '/%2eenv', '/%2Egit/config', '/src%2Fserver%2Fconfig.js',
      '/node_modules%2fmarked%2fmarked.min.js', '/bundle%2ejs',
      '/..%2f.env', '/%252eenv',
    ]) {
      assert.equal((await request(url)).status, 404, `${layout}: ${url}`);
    }
    assert.equal((await request('/bundle.js', 'POST')).status, 404, `${layout}: POST`);

    const outside = path.join(scratch, `${layout}-outside.js`);
    fs.writeFileSync(outside, 'private outside file');
    fs.rmSync(path.join(dist, 'marked.min.js'));
    fs.symlinkSync(outside, path.join(dist, 'marked.min.js'));
    assert.equal((await request('/marked.min.js')).status, 404, `${layout}: asset symlink`);

    const linkedDist = path.join(scratch, `${layout}-linked-dist`);
    fs.symlinkSync(dist, linkedDist, 'dir');
    config.DIST = linkedDist;
    assert.equal((await request('/bundle.js')).status, 404, `${layout}: dist symlink`);
  }
});
