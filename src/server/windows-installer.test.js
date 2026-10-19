'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const powershell = process.env.TIPATASK_TEST_POWERSHELL || (process.platform === 'win32' ? 'powershell.exe' : null);

test('Windows installer process outcomes, path safety and retry bounds', { skip: !powershell }, () => {
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(ROOT, 'build/close-installed-app.test.ps1')], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PASS: 10 isolated installer process scenarios/);
});

test('Windows uninstaller deletes only the paths NSIS cannot handle', { skip: !powershell }, () => {
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(ROOT, 'build/remove-long-paths.test.ps1')], { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PASS: \d+ isolated long-path scenarios/);
});

// Static guards on the hook bodies: they need neither PowerShell nor NSIS.
function readBuildFile(file) {
  return fs.readFileSync(path.join(ROOT, 'build', file), 'utf8');
}

function macroBody(source, name) {
  const match = source.match(new RegExp(`^!macro ${name}(?: [^\\n]*)?\\n([\\s\\S]*?)^!macroend`, 'm'));
  assert.ok(match, `defines ${name}`);
  return match[1];
}

test('Windows upgrade removal failures log the exit code and name the real cause', () => {
  const nsh = readBuildFile('installer.nsh');
  const check = macroBody(nsh, 'customUnInstallCheck');
  assert.match(check, /!insertmacro TTLog '[^'\n]*exit=\$R0'/, 'the template result is always logged');
  assert.match(check, /\$\{if\} \$R0 != 0\s*\n\s*!insertmacro TTReportRemovalFailure \$R0/);
  const upgrade = macroBody(nsh, 'TTPrepareUpgrade');
  assert.match(upgrade, /!insertmacro TTLog '[^'\n]*exit=\$TTResult'/, 'the bundled uninstaller exit code is logged');
  assert.match(upgrade, /\$\{if\} \$TTResult != 0\s*\n\s*!insertmacro TTReportRemovalFailure \$TTResult/);
  const report = macroBody(nsh, 'TTReportRemovalFailure');
  assert.match(report, /!insertmacro TTProcessCheck Check/, 'a failed removal re-checks for running processes');
  assert.match(report, /!insertmacro TTLog '[^'\n]*exit=\$TTExitCode[^'\n]*re-check=\$TTResult'/);
  const [running, notRunning] = report.slice(report.indexOf('${if} $TTResult == 10')).split('${else}');
  assert.match(running, /still running from \$INSTDIR/);
  assert.match(notRunning, /The previous \$\{PRODUCT_NAME\} version could not be removed \(uninstaller exit code \$TTExitCode\)/);
  assert.doesNotMatch(notRunning, /still running/);
  assert.doesNotMatch(report, /appCannotBeClosed/, 'a removal failure is never reported as an app that cannot close');
});

test('Windows uninstaller clears paths NSIS cannot handle before it removes files', () => {
  const nsh = readBuildFile('installer.nsh');
  const remove = macroBody(nsh, 'customRemoveFiles');
  const cleanup = remove.indexOf('!insertmacro TTRemoveLongPaths');
  assert.ok(cleanup >= 0, 'customRemoveFiles inserts TTRemoveLongPaths');
  assert.ok(cleanup < remove.indexOf('Call un.atomicRMDir') && cleanup < remove.indexOf('RMDir /r'), 'before staging and deletion');
  assert.match(macroBody(nsh, 'TTRemoveLongPaths'), /-StagingDirectory "\$PLUGINSDIR\\old-install"/);
  const script = readBuildFile('remove-long-paths.ps1');
  assert.match(script, /Remove-Item -LiteralPath/);
  assert.ok(script.includes("'\\\\?\\'"), 'deletes through \\\\?\\ paths');
  assert.doesNotMatch(script, /-Recurse/, 'never deletes recursively, so links are not followed');
});

test('Windows setup extracts the app with 7-Zip instead of a MAX_PATH-bound copy', () => {
  const code = readBuildFile('extract-app-package.nsh').split('\n').filter((line) => !/^\s*;/.test(line)).join('\n');
  assert.match(code, /^!macroundef extractUsing7za$/m);
  assert.match(code, /^!macro extractUsing7za FILE$/m);
  assert.match(code, /Nsis7z::Extract "\$\{FILE\}"/);
  assert.doesNotMatch(code, /CopyFiles|7z-out/);
  assert.match(macroBody(readBuildFile('installer.nsh'), 'customCheckAppRunning'),
    /!ifndef BUILD_UNINSTALLER\n(?:(?!!endif)[\s\S])*!include "\$\{PROJECT_DIR\}\\build\\extract-app-package\.nsh"/, 'installer build only');
});

test('Windows app check spares upgrades from inconclusive checks and keeps Retry real', () => {
  const check = macroBody(readBuildFile('installer.nsh'), 'customCheckAppRunning');
  assert.match(check, /!ifdef BUILD_UNINSTALLER\n(?:\s*;[^\n]*\n)*\s*\$\{if\} \$\{isUpdated\}\n\s*\$\{andIf\} \$TTResult != 0\n\s*\$\{andIf\} \$TTResult != 10\n[^!]*!insertmacro TTLog [^\n]*\n\s*StrCpy \$TTResult 0/);
  assert.match(check, /MB_RETRYCANCEL\|MB_ICONEXCLAMATION "\$\(appCannotBeClosed\)[^"]*" \/SD IDCANCEL IDRETRY tipataskStopProcesses/);
});

test('Windows installer hooks avoid declaration-order and quoting traps', () => {
  for (const file of ['installer.nsh', 'extract-app-package.nsh']) {
    const source = readBuildFile(file);
    const code = source.split('\n').filter((line) => !/^\s*;/.test(line)).join('\n');
    // The template declares $PowerShellPath in the install section, after
    // installUtil.nsh has compiled customUnInstallCheck.
    assert.doesNotMatch(code, /\$PowerShellPath/, file);
    for (const line of source.split('\n').filter((text) => text.includes('!insertmacro TTLog '))) {
      assert.match(line, /^\s*!insertmacro TTLog '[^']*'\s*$/, `${file}: TTLog text must not contain a quote: ${line.trim()}`);
    }
  }
});

// Opt in with the electron-builder NSIS binary/resource directories. Compile the
// real assisted templates, not a reimplementation of the custom hook order.
const nsisRoot = process.env.TIPATASK_TEST_NSIS_DIR;
const plugins = process.env.TIPATASK_TEST_NSIS_PLUGINS;
test('Windows installer and uninstaller compile against electron-builder templates', { skip: !nsisRoot || !plugins }, async () => {
  const { NsisScriptGenerator } = require('app-builder-lib/out/targets/nsis/nsisScriptGenerator');
  const { LangConfigurator, createAddLangsMacro, addCustomMessageFileInclude } = require('app-builder-lib/out/targets/nsis/nsisLang');
  const templates = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-installer-compile-'));
  try {
    const common = new NsisScriptGenerator();
    common.include(path.join(templates, 'include/StdUtils.nsh'));
    common.addIncludeDir(path.join(templates, 'include'));
    common.addPluginDir('x86-unicode', plugins);
    common.flags(['updated', 'force-run', 'keep-shortcuts', 'no-desktop-shortcut', 'delete-app-data', 'allusers', 'currentuser']);
    const languages = new LangConfigurator({});
    createAddLangsMacro(common, languages);
    let n = 0;
    const packager = { getTempFile: async () => path.join(scratch, `messages-${n++}.nsh`) };
    await addCustomMessageFileInclude('messages.yml', packager, common, languages);
    await addCustomMessageFileInclude('assistedMessages.yml', packager, common, languages);
    common.include(path.join(ROOT, 'build/installer.nsh'));
    // These files are embedded, never executed. Runtime upgrade validation needs
    // a real app archive and the extracted/signed uninstaller from electron-builder.
    fs.writeFileSync(path.join(scratch, 'payload.7z'), 'compile-only payload');
    fs.writeFileSync(path.join(scratch, 'uninstaller.exe'), 'compile-only uninstaller');
    const defines = {
      APP_ID: 'com.tipatask.installer-probe', APP_GUID: 'tt-installer-probe', UNINSTALL_APP_KEY: 'tt-installer-probe',
      PRODUCT_NAME: 'TipATask Installer Probe', PRODUCT_FILENAME: 'TipATask', APP_FILENAME: 'TipATaskInstallerProbe',
      APP_DESCRIPTION: 'Installer probe', APP_PACKAGE_NAME: 'tipatask-installer-probe', VERSION: '0.9.15',
      PROJECT_DIR: ROOT, UNINSTALL_DISPLAY_NAME: 'TipATask Installer Probe', SHORTCUT_NAME: 'TipATask Installer Probe',
      APP_64: path.join(scratch, 'payload.7z'), APP_64_UNPACKED_SIZE: '1', COMPRESSION_METHOD: '7z',
      APP_INSTALLER_STORE_FILE: 'TipATaskInstallerProbe-setup.exe', UNINSTALLER_OUT_FILE: path.join(scratch, 'uninstaller.exe'),
    };
    const compiler = path.join(nsisRoot, process.platform === 'win32' ? 'Bin/makensis.exe' : `${process.platform === 'darwin' ? 'mac' : 'linux'}/makensis`);
    for (const mode of ['uninstaller', 'installer']) {
      const script = ['Unicode true', `OutFile "${path.join(scratch, `${mode}.exe`)}"`,
        '!define INSTALL_MODE_PER_ALL_USERS_REQUIRED', '!define MULTIUSER_INSTALLMODE_ALLOW_ELEVATION',
        ...Object.entries(defines).map(([key, value]) => `!define ${key} "${value}"`),
        ...(mode === 'uninstaller' ? ['!define BUILD_UNINSTALLER'] : []), common.build(),
        `!include "${path.join(templates, 'installer.nsi')}"`].join('\n');
      const result = spawnSync(compiler, ['-WX', '-V3', '-'], { input: script, cwd: templates, encoding: 'utf8',
        timeout: 60000, env: { ...process.env, NSISDIR: nsisRoot } });
      assert.equal(result.status, 0, `${mode}: ${result.error || ''}\n${result.stdout}\n${result.stderr}`);
      assert.ok(fs.statSync(path.join(scratch, `${mode}.exe`)).size > 0);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
