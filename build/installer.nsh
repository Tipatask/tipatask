; TipATask NSIS customisations. package.json build.nsis.include points electron-builder
; at this file (it is outside buildResources, so it is never picked up implicitly).
;
; Purpose: the assisted installer's details list names every stage of install and
; uninstall instead of showing a bare progress bar, and the running-app check closes
; every process started from the install directory, not just the main window process.
; Hook order and the template
; bodies mirrored below come from app-builder-lib's templates/nsis (installSection.nsh,
; uninstaller.nsh, include/installUtil.nsh, include/allowOnlyOneInstallerInstance.nsh);
; re-check them when bumping electron-builder.
;
; The template's .onInit (customInit) runs before any page exists, so a DetailPrint
; there is never visible; the stage lines below come from hooks that run inside the
; install/uninstall sections instead.

!macro customHeader
  ShowInstDetails show
  ShowUnInstDetails show
!macroend

; Always install for the current user: skip the assisted installer's
; "anyone who uses this computer / only for me" page.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; Defining customCheckAppRunning stops allowOnlyOneInstallerInstance.nsh from
; including these, but the check below still needs them.
!include "getProcessInfo.nsh"
Var pid

; The app is a process tree, not one process: the main window process forks the task
; server, which spawns agent CLIs under ConPTY, and agents launch MCP servers and the
; Pi CLI as more ${APP_EXECUTABLE_FILENAME} processes (ELECTRON_RUN_AS_NODE). Any of
; them left running keeps files under $INSTDIR locked, so the previous version's
; uninstaller cannot remove the old install. The template check kills processes one at
; a time and gives up after two rounds; these helpers match every process whose image
; lives under $INSTDIR (except this installer/uninstaller) and kill each one's whole
; tree, which also takes out descendants started from elsewhere (claude.exe, node.exe).

; _RETURN = 0 when at least one such process is still running.
!macro tipataskFindRunning _RETURN
  ${if} $IsPowerShellAvailable == 0
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -C "$$d = '$INSTDIR\'; if (@(Get-CimInstance -ClassName Win32_Process | ? { $$_.ExecutablePath -and $$_.ProcessId -ne $pid -and $$_.ExecutablePath.StartsWith($$d, [System.StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) { exit 0 } else { exit 1 }"`
    Pop ${_RETURN}
  ${else}
    ; No usable PowerShell: fall back to the template's image-name match.
    nsExec::Exec `"$CmdPath" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FI "PID ne $pid" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop ${_RETURN}
  ${endIf}
!macroend

; Force-kills every matching process together with its descendants (taskkill /T /F).
!macro tipataskKillRunning
  ${if} $IsPowerShellAvailable == 0
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -C "$$d = '$INSTDIR\'; Get-CimInstance -ClassName Win32_Process | ? { $$_.ExecutablePath -and $$_.ProcessId -ne $pid -and $$_.ExecutablePath.StartsWith($$d, [System.StringComparison]::OrdinalIgnoreCase) } | % { & '$SYSDIR\taskkill.exe' /T /F /PID $$_.ProcessId 2>&1 | Out-Null }; exit 0"`
  ${else}
    nsExec::Exec `"$SYSDIR\taskkill.exe" /T /F /IM "${APP_EXECUTABLE_FILENAME}" /FI "PID ne $pid" /FI "USERNAME eq %USERNAME%"`
  ${endIf}
  Pop $R2
!macroend

; Install section start (right after the template's `SetDetailsPrint none`) and the
; uninstall section start. Re-enables the details list, then closes every process
; started from $INSTDIR: one confirmation (skipped on --updated and in silent mode),
; then up to five tree-kill rounds before asking the user to retry or cancel.
!macro customCheckAppRunning
  SetDetailsPrint both
  DetailPrint "Closing ${PRODUCT_NAME} if it is running..."
  !insertmacro IS_POWERSHELL_AVAILABLE

  ${GetProcessInfo} 0 $pid $1 $2 $3 $4
  ${if} $3 != "${APP_EXECUTABLE_FILENAME}"
    !insertmacro tipataskFindRunning $R0
    ${if} $R0 == 0
      ${ifNot} ${isUpdated}
        MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK tipataskStopProcesses
        Quit
      ${endIf}

      tipataskStopProcesses:
      DetailPrint "$(appClosing)"
      StrCpy $R1 0

      tipataskKillLoop:
        IntOp $R1 $R1 + 1
        !insertmacro tipataskKillRunning
        ; let Windows release file handles held by the killed processes
        Sleep 1000
        !insertmacro tipataskFindRunning $R0
        ${if} $R0 == 0
          ${if} $R1 < 5
            DetailPrint `Waiting for "${PRODUCT_NAME}" processes to close (attempt $R1 of 5)...`
            Sleep 1000
            Goto tipataskKillLoop
          ${endIf}
          ; Something under $INSTDIR survived five forced tree kills (most likely a
          ; process running elevated). Ask the user to close it manually.
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY tipataskRetryKill
          Quit
          tipataskRetryKill:
          StrCpy $R1 0
          Goto tipataskKillLoop
        ${endIf}
    ${endIf}
  ${endIf}

  !ifndef BUILD_UNINSTALLER
    DetailPrint "Removing the previous ${PRODUCT_NAME} version, if one is installed..."
  !endif
!macroend

; Runs after the previous version's uninstaller, just before the app archive is
; extracted. Defining it replaces the template's default result handling in
; handleUninstallResult, so that body is reproduced first, unchanged.
!macro customUnInstallCheck
  IfErrors 0 +3
  DetailPrint `Uninstall was not successful. Not able to launch uninstaller!`
  Return

  ${if} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
    DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
    SetErrorLevel 2
    Quit
  ${endif}

  DetailPrint "Extracting ${PRODUCT_NAME} application files..."
!macroend

; Runs right after the app archive is extracted into $INSTDIR. The bundled Pi agent
; and the voice runtime ship inside that archive; report each one that landed.
!macro tipataskReportUnpackedRuntimes
  ${If} ${FileExists} "$INSTDIR\resources\pi\node_modules\*.*"
    DetailPrint "Unpacked bundled Pi coding agent (resources\pi)"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\resources\app.asar.unpacked\node_modules\sherpa-onnx-win-*"
    DetailPrint "Unpacked voice runtime (sherpa-onnx)"
  ${EndIf}
  DetailPrint "Registering uninstaller and creating shortcuts..."
!macroend

!macro customFiles_x64
  !insertmacro tipataskReportUnpackedRuntimes
!macroend

!macro customFiles_arm64
  !insertmacro tipataskReportUnpackedRuntimes
!macroend

; End of the install section: the uninstaller, registry entries and shortcuts exist.
;
; The Start menu shortcut is not guaranteed by the template. With
; allowToChangeInstallationDirectory off, setIsTryToKeepShortcuts is always "true", so
; any install over an existing one (registry KeepShortcuts + $appExe present) sets
; $keepShortcuts and addStartMenuLink only renames an existing $oldStartMenuLink that
; differs from $newStartMenuLink. When the two paths match and the link is gone (deleted
; by the user, or by an earlier aborted install or uninstall), nothing recreates it, so
; the fallback below creates it the same way the template's fresh-install branch does.
!macro customInstall
  DetailPrint "Registered uninstaller: $INSTDIR\${UNINSTALL_FILENAME}"
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${IfNot} ${FileExists} "$newStartMenuLink"
      SetShellVarContext current
      !ifdef MENU_FILENAME
        CreateDirectory "$SMPROGRAMS\${MENU_FILENAME}"
      !endif
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
      StrCpy $launchLink "$newStartMenuLink"
      DetailPrint "Start menu shortcut was missing — created"
      DetailPrint "Start menu folder: $SMPROGRAMS"
    ${EndIf}
  !endif
  ${If} ${FileExists} "$newStartMenuLink"
    DetailPrint "Start menu shortcut: $newStartMenuLink"
  ${Else}
    DetailPrint "Start menu shortcut could not be created: $newStartMenuLink"
  ${EndIf}
  ${If} ${FileExists} "$newDesktopLink"
    DetailPrint "Desktop shortcut: $newDesktopLink"
  ${EndIf}
  DetailPrint "${PRODUCT_NAME} ${VERSION} installed."
!macroend

; Uninstall section, after the running-app check and before files are removed.
!macro customUnInstall
  DetailPrint "Removing ${PRODUCT_NAME} files (app, bundled Pi agent, voice runtime), shortcuts and registry entries..."
!macroend
