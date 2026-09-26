@echo off
:: Finds a Node.js binary satisfying engines.node from package.json, then runs it.
:: Set TIPATASK_NODE env var to override candidate search.
setlocal EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "PKG_JSON=%SCRIPT_DIR%..\package.json"
set "REQ_MAJOR=22"

:: Parse engines.node major from package.json (simplistic grep via findstr)
for /f "tokens=*" %%L in ('findstr /r "\"node\"" "%PKG_JSON%" 2^>nul') do (
  set "LINE=%%L"
  :: Extract first run of digits after >=, ^>, or just digits
  for /f "tokens=1 delims=." %%V in ('echo !LINE! ^| powershell -NoProfile -Command ^
    "[regex]::Match('$input','(\d+)').Groups[1].Value" 2^>nul') do (
    if not "%%V"=="" set "REQ_MAJOR=%%V"
  )
  goto :parsed
)
:parsed

:: Helper: check if a node binary meets requirement
:: Usage: call :check_node <path> -> sets FOUND_NODE if OK
goto :main

:check_node
  set "_CAND=%~1"
  if "%_CAND%"=="" exit /b 1
  if not exist "%_CAND%" exit /b 1
  for /f "tokens=*" %%V in ('"%_CAND%" --version 2^>nul') do (
    set "_RAW=%%V"
  )
  if "%_RAW%"=="" exit /b 1
  :: Strip leading 'v', take major
  for /f "tokens=1 delims=." %%M in ("%_RAW:v=%") do set "_MAJ=%%M"
  if !_MAJ! GEQ %REQ_MAJOR% (
    set "FOUND_NODE=%_CAND%"
    exit /b 0
  )
  exit /b 1

:main
set "FOUND_NODE="

:: 1. Explicit override
if defined TIPATASK_NODE (
  call :check_node "%TIPATASK_NODE%"
  if defined FOUND_NODE goto :exec
  echo tipatask: TIPATASK_NODE=%TIPATASK_NODE% does not satisfy node ^>=%REQ_MAJOR% 1>&2
  exit /b 1
)

:: 2. PATH node
for /f "tokens=*" %%P in ('where node 2^>nul') do (
  call :check_node "%%P"
  if defined FOUND_NODE goto :exec
  goto :after_path
)
:after_path

:: 3. nvm-windows (%NVM_HOME% or %APPDATA%\nvm)
set "NVM_HOME_CANDIDATES=%NVM_HOME% %APPDATA%\nvm"
for %%D in (%NVM_HOME_CANDIDATES%) do (
  if exist "%%D" (
    for /d %%V in ("%%D\v*") do (
      call :check_node "%%V\node.exe"
      if defined FOUND_NODE goto :exec
    )
  )
)

:: 4. fnm (%LOCALAPPDATA%\fnm\node-versions)
set "FNM_DIR=%LOCALAPPDATA%\fnm\node-versions"
if exist "%FNM_DIR%" (
  for /d %%V in ("%FNM_DIR%\v*") do (
    call :check_node "%%V\installation\node.exe"
    if defined FOUND_NODE goto :exec
  )
)

:: 5. Volta
call :check_node "%USERPROFILE%\.volta\bin\node.exe"
if defined FOUND_NODE goto :exec

:: 6. Common program files locations
for %%D in (
  "%ProgramFiles%\nodejs\node.exe"
  "%ProgramFiles(x86)%\nodejs\node.exe"
) do (
  call :check_node %%D
  if defined FOUND_NODE goto :exec
)

echo tipatask: no node ^>=%REQ_MAJOR% found. Install via nvm/fnm/volta or set TIPATASK_NODE. 1>&2
exit /b 1

:exec
"%FOUND_NODE%" %*
