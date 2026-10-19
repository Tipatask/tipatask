'use strict';

// Run with standalone Node on Windows, against an unpacked or installed app:
// node scripts/probe-packaged-windows-pty.js "C:\path\to\TipATask"
// The actual PTYs run inside that app's Electron runtime, loading only its ASAR.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

async function smoke(resources) {
  const path = require('node:path');
  const assert = require('node:assert/strict');
  const pty = require(path.join(resources, 'app.asar', 'node_modules', 'node-pty'));
  require(path.join(resources, 'app.asar', 'node_modules', 'node-pty', 'build', 'Release', 'conpty_console_list.node'));
  for (const useConptyDll of [false, true]) {
    await new Promise((resolve, reject) => {
      let output = '';
      const marker = `TIPATASK_PTY_${useConptyDll ? 'DLL' : 'SYSTEM'}_OK`;
      const terminal = pty.spawn(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
        ['/d', '/q', '/c', `echo ${marker} & exit /b 0`], {
          cwd: require('node:os').tmpdir(), env: process.env, cols: 80, rows: 24,
          useConpty: true, useConptyDll,
        });
      const timer = setTimeout(() => {
        try { terminal.kill(); } catch { /* timed out child may already have exited */ }
        reject(new Error(`Windows PTY timed out (pid ${terminal.pid}, useConptyDll=${useConptyDll})`));
      }, 10000);
      terminal.onData(data => { output += data; });
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timer);
        try {
          assert.equal(exitCode, 0);
          assert.ok(output.includes(marker), `Missing PTY output: ${JSON.stringify(output)}`);
          console.log(`${marker} arch=${process.arch} electron=${process.versions.electron} pid=${terminal.pid} exit=${exitCode}`);
          resolve();
        } catch (error) { reject(error); }
      });
    });
  }
  // Pi must run with the packaged console Node executable, not the GUI Electron
  // executable merely passing a piped --version check. Exercise actual raw input.
  await new Promise((resolve, reject) => {
    const input = 'TIPATASK_NODE_INPUT';
    const ready = 'TIPATASK_NODE_TTY_READY';
    const marker = 'TIPATASK_NODE_TTY_OK';
    const code = `
      const assert = require('node:assert/strict');
      assert.equal(process.stdin.isTTY, true, 'Pi runtime stdin must be a TTY');
      assert.equal(process.stdout.isTTY, true, 'Pi runtime stdout must be a TTY');
      process.stdin.setRawMode(true);
      process.stdin.resume();
      let input = '';
      process.stdin.on('data', data => {
        input += data;
        if (input.includes(${JSON.stringify(input)})) {
          process.stdout.write(${JSON.stringify(marker + '\r\n')}, () => process.exit(0));
        }
      });
      console.log(${JSON.stringify(ready)});
    `;
    const terminal = pty.spawn(path.join(resources, 'pi', 'node_modules', 'tipatask-node', 'node.exe'),
      ['-e', code], { cwd: require('node:os').tmpdir(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, cols: 80, rows: 24 });
    let output = '', sent = false;
    const timer = setTimeout(() => {
      try { terminal.kill(); } catch { /* child may have exited */ }
      reject(new Error(`Pi console Node PTY timed out (pid ${terminal.pid}): ${JSON.stringify(output)}`));
    }, 10000);
    terminal.onData(data => {
      output += data;
      if (!sent && output.includes(ready)) { sent = true; terminal.write(input + '\r'); }
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      try {
        assert.equal(exitCode, 0, output);
        assert.ok(sent && output.includes(marker), `Missing console Node input/output: ${JSON.stringify(output)}`);
        console.log(`${marker} arch=${process.arch} electron=${process.versions.electron} pid=${terminal.pid} exit=${exitCode}`);
        resolve();
      } catch (error) { reject(error); }
    });
  });
}

function main(appDir = path.resolve(__dirname, '..', 'dist-electron', 'win-unpacked')) {
  if (process.platform !== 'win32') throw new Error('Packaged Windows PTY probe must run on Windows');
  // Absolute: the in-app code require()s under this path, and a relative one would be read
  // as a bare module specifier (MODULE_NOT_FOUND), not a path.
  appDir = path.resolve(appDir);
  const resources = path.join(appDir, 'resources');
  // Exit explicitly on both paths: the node-pty handles the smoke opened keep the event loop
  // alive after the terminals exit, and the outer spawnSync would then time out on a pass.
  const code = `(${smoke.toString()})(${JSON.stringify(resources)}).then(() => process.exit(0), error => { console.error(error); process.exit(1); })`;
  const result = spawnSync(path.join(appDir, 'TipATask.exe'), ['-e', code], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 45000, windowsHide: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0 || !['TIPATASK_PTY_SYSTEM_OK', 'TIPATASK_PTY_DLL_OK', 'TIPATASK_NODE_TTY_OK'].every(marker => result.stdout?.includes(marker))) {
    throw new Error(`Packaged Windows PTY probe failed (exit ${result.status})`);
  }
}

if (require.main === module) {
  try { main(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { main };
