@echo off
:: (C1112) Launcher for the bundled Pi coding agent CLI (@earendil-works/pi-coding-agent).
:: Delegates interpreter selection to mcp-node.cmd (engines.node-aware) rather than relying on
:: npm's generated .cmd shim for node_modules/.bin/pi.cmd, which would just run whatever `node`
:: is first on PATH. See bin/pi for the POSIX rationale (C1041 stale-node PATH ordering).
setlocal

set "SCRIPT_DIR=%~dp0"
set "CLI=%SCRIPT_DIR%..\node_modules\@earendil-works\pi-coding-agent\dist\cli.js"

if not exist "%CLI%" (
  echo tipatask: bundled pi missing — run 'npm install' in the Task App checkout 1>&2
  exit /b 127
)

call "%SCRIPT_DIR%mcp-node.cmd" "%CLI%" %*
