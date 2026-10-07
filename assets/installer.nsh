; TipATask NSIS customisations. electron-builder includes this file automatically
; because it sits in the buildResources directory (assets/).
;
; Purpose: the assisted installer's details list names every stage of install and
; uninstall instead of showing a bare progress bar. Hook order and the template
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
; including these, but the default check called below still needs them.
!include "getProcessInfo.nsh"
Var pid

; Install section start (right after the template's `SetDetailsPrint none`) and the
; uninstall section start. Re-enables the details list, then runs the default check.
!macro customCheckAppRunning
  SetDetailsPrint both
  DetailPrint "Closing ${PRODUCT_NAME} if it is running..."
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
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
!macro customInstall
  DetailPrint "Registered uninstaller: $INSTDIR\${UNINSTALL_FILENAME}"
  ${If} ${FileExists} "$newStartMenuLink"
    DetailPrint "Start menu shortcut: $newStartMenuLink"
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
