; TipATask NSIS customisations. package.json build.nsis.include points electron-builder
; at this file (it is outside buildResources, so it is never picked up implicitly).
;
; Purpose: the assisted installer's details list names every stage of install and
; uninstall instead of showing a bare progress bar, and the running-app check closes
; every process started from the install directory, not just the main window process.
; Hook order and the template
; bodies mirrored below come from app-builder-lib's templates/nsis (installSection.nsh,
; uninstaller.nsh, include/installUtil.nsh, include/allowOnlyOneInstallerInstance.nsh,
; include/extractAppPackage.nsh); re-check them when bumping electron-builder.
;
; The template's .onInit (customInit) runs before any page exists, so a DetailPrint
; there is never visible; the stage lines below come from hooks that run inside the
; install/uninstall sections instead.
;
; NSIS file operations (FindFirst, CreateDirectory, Rename, Delete, RMDir, CopyFiles)
; stop at MAX_PATH, while 7-Zip extraction does not. The bundled Pi agent's nested
; node_modules (resources\pi) holds longer paths, so removal clears them first
; (TTRemoveLongPaths) and extraction skips the template's copy step
; (build/extract-app-package.nsh).

!macro customHeader
  ShowInstDetails show
  ShowUnInstDetails show
!macroend

; Always install for the current user: skip the assisted installer's
; "anyone who uses this computer / only for me" page.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

Var TTInstallerPid
Var TTLogPath
Var TTLogHandle
Var TTParameters
Var TTResult
Var TTPreviousOutDir
!ifndef BUILD_UNINSTALLER
  Var TTPreviousDirectory
  Var TTPreviousUninstaller
  Var TTPreserveShortcuts
  Var TTExitCode
!endif

; The value the template's CHECK_APP_RUNNING gives $PowerShellPath. That variable is
; declared inside the install section, after installUtil.nsh has compiled
; customUnInstallCheck, so these helpers cannot reference it.
!define TT_POWERSHELL "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"

; Silent uninstallers have no visible details window. Share a UTF-16 log with the
; parent setup so their exit code and any busy-file path remain available. The log
; exists once customCheckAppRunning has run; an elevated inner setup skips that hook.
!macro TTLog MESSAGE
  DetailPrint '${MESSAGE}'
  ${if} $TTLogPath != ""
    FileOpen $TTLogHandle "$TTLogPath" a
    FileWriteUTF16LE $TTLogHandle '${MESSAGE}$\r$\n'
    FileClose $TTLogHandle
  ${endif}
!macroend

!macro TTProcessCheck MODE
  nsExec::ExecToLog /TIMEOUT=20000 `"${TT_POWERSHELL}" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\tt-close-installed-app.ps1" -InstallDirectory "$INSTDIR" -InstallerProcessId $TTInstallerPid -LogPath "$TTLogPath" -AppExecutable "${APP_EXECUTABLE_FILENAME}" -Mode ${MODE}`
  Pop $TTResult
  !insertmacro TTLog 'TTCloseInstalledApp: ${MODE} exit=$TTResult'
!macroend

; Uninstaller only, before NSIS stages or deletes $INSTDIR. un.atomicRMDir reports a
; path it cannot rename as a busy file, and would on every attempt. The helper deletes
; only the entries NSIS cannot handle, sized against both $INSTDIR and the
; $PLUGINSDIR\old-install staging base, through \\?\ paths. Deleted entries are not
; restored if a later removal step fails; the rest of the install still is.
!macro TTRemoveLongPaths
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=tt-remove-long-paths.ps1 "${PROJECT_DIR}\build\remove-long-paths.ps1"
  nsExec::ExecToLog /TIMEOUT=120000 `"${TT_POWERSHELL}" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\tt-remove-long-paths.ps1" -InstallDirectory "$INSTDIR" -StagingDirectory "$PLUGINSDIR\old-install" -LogPath "$TTLogPath"`
  Pop $TTResult
  !insertmacro TTLog 'TTRemoveLongPaths: exit=$TTResult'
!macroend

; Setup only: the previous version's uninstaller failed. Log its exit code, re-check
; for processes still running from $INSTDIR, and name the actual cause, so a removal
; failure with nothing running is never reported as "cannot be closed". The detail
; line is English: a new LangString would need every bundled installer language.
!macro TTReportRemovalFailure EXIT_CODE
  StrCpy $TTExitCode "${EXIT_CODE}"
  ${if} $TTLogPath == ""
    StrCpy $TTResult "unavailable"
  ${else}
    !insertmacro TTProcessCheck Check
  ${endif}
  !insertmacro TTLog 'Upgrade: previous version could not be removed: uninstaller exit=$TTExitCode, running-process re-check=$TTResult'
  ${if} $TTResult == 10
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed)$\r$\n$\r$\n${PRODUCT_NAME} is still running from $INSTDIR, so the previous version could not be removed (uninstaller exit code $TTExitCode). Close ${PRODUCT_NAME}, then run setup again.$\r$\n$TTLogPath" /SD IDOK
  ${else}
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed)$\r$\n$\r$\nThe previous ${PRODUCT_NAME} version could not be removed (uninstaller exit code $TTExitCode).$\r$\n$TTLogPath" /SD IDOK
  ${endif}
  SetErrorLevel 2
  Quit
!macroend

; Upgrade with this build's uninstaller, not the installed one: fixes to a newly
; generated uninstaller cannot repair an already-installed legacy check. The stock
; template subsequently finds no old registration and does not enter its retry loop.
!macro TTPrepareUpgrade
  StrCpy $TTPreserveShortcuts "false"
  ReadRegStr $TTPreviousUninstaller SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
  !ifdef UNINSTALL_REGISTRY_KEY_2
    ${if} $TTPreviousUninstaller == ""
      ReadRegStr $TTPreviousUninstaller SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    ${endif}
  !endif
  ${if} $TTPreviousUninstaller != ""
    ReadRegStr $TTPreviousDirectory SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $TTPreviousDirectory == ""
      Push $TTPreviousUninstaller
      Call GetInQuotes
      Call GetFileParent
      Pop $TTPreviousDirectory
    ${endif}
    ${if} $TTPreviousDirectory == ""
      !insertmacro TTLog 'Upgrade: registered installation directory could not be resolved. Removal stopped.'
      SetErrorLevel 2
      Quit
    ${endif}
    GetFullPathName $TTPreviousDirectory "$TTPreviousDirectory"
    GetFullPathName $TTPreviousOutDir "$INSTDIR"
    ${if} $TTPreviousDirectory != $TTPreviousOutDir
      !insertmacro TTLog 'Upgrade directory mismatch: registered=$TTPreviousDirectory selected=$INSTDIR. Removal stopped.'
      SetErrorLevel 2
      Quit
    ${endif}
    ReadRegStr $TTPreserveShortcuts SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" KeepShortcuts
    ${ifNot} ${FileExists} "$appExe"
      StrCpy $TTPreserveShortcuts "false"
    ${endif}
    SetOutPath "$PLUGINSDIR"
    File /oname=tt-upgrade-uninstaller.exe "${UNINSTALLER_OUT_FILE}"
    ; Release setup's current-directory handle before the uninstaller removes it.
    SetOutPath "$TEMP"
    !insertmacro TTLog 'Upgrade: replacing legacy removal ($TTPreviousUninstaller) with bundled uninstaller; preserving app data and shortcuts.'
    ClearErrors
    ${if} $installMode == "all"
      ExecWait '"$PLUGINSDIR\tt-upgrade-uninstaller.exe" /S /KEEP_APP_DATA /allusers --keep-shortcuts --updated /TTLOG="$TTLogPath" _?=$INSTDIR' $TTResult
    ${else}
      ExecWait '"$PLUGINSDIR\tt-upgrade-uninstaller.exe" /S /KEEP_APP_DATA /currentuser --keep-shortcuts --updated /TTLOG="$TTLogPath" _?=$INSTDIR' $TTResult
    ${endif}
    ${if} ${Errors}
      !insertmacro TTLog 'Upgrade: could not launch bundled uninstaller. Removal stopped.'
      SetErrorLevel 2
      Quit
    ${endif}
    ; One attempt per setup run; the uninstaller logs its own steps to the same file.
    !insertmacro TTLog 'Upgrade: bundled uninstaller exit=$TTResult'
    ${if} $TTResult != 0
      !insertmacro TTReportRemovalFailure $TTResult
    ${endif}
    ; Refuse to fall back into the template's misleading legacy-uninstaller loop.
    ReadRegStr $TTPreviousUninstaller SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ${if} $TTPreviousUninstaller == ""
        ReadRegStr $TTPreviousUninstaller SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
      ${endif}
    !endif
    ${if} $TTPreviousUninstaller != ""
      !insertmacro TTLog 'Upgrade: old uninstall registration remains. Removal stopped.'
      SetErrorLevel 2
      Quit
    ${endif}
  ${endif}
!macroend

!macro customCheckAppRunning
  SetDetailsPrint both
  System::Call 'kernel32::GetCurrentProcessId() i.s'
  Pop $TTInstallerPid
  ${GetParameters} $TTParameters
  ClearErrors
  ${GetOptions} $TTParameters "/TTLOG=" $TTLogPath
  ${if} ${Errors}
    StrCpy $TTLogPath "$TEMP\TipATask-installer-$TTInstallerPid.log"
    FileOpen $TTLogHandle "$TTLogPath" w
    FileWriteUTF16LE /BOM $TTLogHandle "TipATask ${VERSION}$\r$\n"
    FileClose $TTLogHandle
  ${endif}
  !insertmacro TTLog 'TTCloseInstalledApp: installerPid=$TTInstallerPid installDir=$INSTDIR log=$TTLogPath'
  DetailPrint "Closing ${PRODUCT_NAME} if it is running..."
  InitPluginsDir
  StrCpy $TTPreviousOutDir "$OUTDIR"
  SetOutPath "$PLUGINSDIR"
  File /oname=tt-close-installed-app.ps1 "${PROJECT_DIR}\build\close-installed-app.ps1"
  SetOutPath "$TTPreviousOutDir"
  !insertmacro TTProcessCheck Check
  !ifdef BUILD_UNINSTALLER
    ; Setup checked and closed the app just before it launched this upgrade
    ; uninstaller, whose removal restores the install on a busy file: a check that
    ; could not run here must not fail the upgrade.
    ${if} ${isUpdated}
    ${andIf} $TTResult != 0
    ${andIf} $TTResult != 10
      !insertmacro TTLog 'TTCloseInstalledApp: inconclusive check result $TTResult in the upgrade uninstaller, continuing because setup closed the app first'
      StrCpy $TTResult 0
    ${endif}
  !endif
  ${if} $TTResult == 10
    ${ifNot} ${isUpdated}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK tipataskStopProcesses
      SetErrorLevel 1
      Quit
    ${endif}
    tipataskStopProcesses:
    DetailPrint "$(appClosing)"
    !insertmacro TTProcessCheck Close
  ${endif}
  ${if} $TTResult != 0
    ${if} $TTResult == 10
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)$\r$\n$TTLogPath" /SD IDCANCEL IDRETRY tipataskStopProcesses
    ${else}
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): TTCloseInstalledApp=$TTResult$\r$\n$TTLogPath" /SD IDOK
    ${endif}
    SetErrorLevel 2
    Quit
  ${endif}
  !ifndef BUILD_UNINSTALLER
    ; This hook expands after the template defines extractUsing7za and before
    ; installApplicationFiles expands it: the right point to replace it.
    !include "${PROJECT_DIR}\build\extract-app-package.nsh"
    DetailPrint "Removing the previous ${PRODUCT_NAME} version, if one is installed..."
    !insertmacro TTPrepareUpgrade
  !endif
!macroend

; Runs after the template's previous-version removal and just before the app archive
; is extracted. Defining it replaces the template's default result handling in
; handleUninstallResult. A launch error must stop extraction as well. The result is
; 0 when TTPrepareUpgrade already removed the previous version: the template then
; finds no registration and runs nothing.
!macro customUnInstallCheck
  ${if} ${Errors}
    !insertmacro TTLog 'Uninstall was not successful. Not able to launch uninstaller!'
    SetErrorLevel 2
    Quit
  ${endif}

  !insertmacro TTLog 'Previous version uninstaller result: exit=$R0'
  ${if} $R0 != 0
    !insertmacro TTReportRemovalFailure $R0
  ${endif}

  DetailPrint "Extracting ${PRODUCT_NAME} application files..."
!macroend

; Runs right after the app archive is extracted into $INSTDIR. The bundled Pi agent
; and the voice runtime ship inside that archive; report each one that landed.
!macro tipataskReportUnpackedRuntimes
  ; The replacement uninstaller removed the old registry before the template read
  ; KeepShortcuts. Restore the captured choice before add*Link runs.
  ${if} $TTPreserveShortcuts == "true"
    StrCpy $keepShortcuts "true"
  ${endif}
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

; Preserve the template's atomic move/restore behavior, but log the exact busy file
; and return a failure instead of letting a silent Abort look like success. Paths NSIS
; cannot handle go first, for upgrades and plain uninstalls alike.
!macro customRemoveFiles
  !insertmacro TTRemoveLongPaths
  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"
    Push ""
    Call un.atomicRMDir
    Pop $R0
    ${if} $R0 != 0
      !insertmacro TTLog 'Upgrade removal blocked by busy file: $R0'
      Push ""
      Call un.restoreFiles
      Pop $R0
      SetErrorLevel 2
      Quit
    ${endif}
  ${endif}
  SetOutPath "$TEMP"
  ClearErrors
  RMDir /r "$INSTDIR"
  ${if} ${Errors}
    !insertmacro TTLog 'Removal failed: $INSTDIR'
    ${if} ${isUpdated}
      CreateDirectory "$INSTDIR"
      Push ""
      Call un.restoreFiles
      Pop $R0
    ${else}
      ; A plain uninstall stops before its registry and shortcut cleanup: say so.
      MessageBox MB_OK|MB_ICONEXCLAMATION "${PRODUCT_NAME} could not be fully removed from $INSTDIR.$\r$\n$TTLogPath" /SD IDOK
    ${endif}
    SetErrorLevel 2
    Quit
  ${endif}
  !insertmacro TTLog 'Application files removed: $INSTDIR'
!macroend
