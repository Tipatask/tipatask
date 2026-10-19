; Included from customCheckAppRunning in the installer build only. That hook expands
; inside the install section after the template's include/extractAppPackage.nsh has
; defined extractUsing7za and before installApplicationFiles expands it, so the
; definition below replaces the template's one for this setup.
;
; The template unpacks into $PLUGINSDIR\7z-out and then copies with CopyFiles
; (SHFileOperation), which stops at MAX_PATH. The bundled Pi agent's nested
; node_modules holds longer paths, so that copy fails on every attempt and setup asks
; to close a TipATask that is not running. Setup has already removed the previous
; version (TTPrepareUpgrade), so the copy protects nothing: extract straight into
; $OUTDIR ($INSTDIR) with 7-Zip, which handles long paths, as the template's own
; last-resort branch does. A renamed template macro fails !macroundef and the build.
!macroundef extractUsing7za
!macro extractUsing7za FILE
  Nsis7z::Extract "${FILE}"
  ${ifNot} ${FileExists} "$OUTDIR\${APP_EXECUTABLE_FILENAME}"
    !insertmacro TTLog 'Extraction failed: $OUTDIR\${APP_EXECUTABLE_FILENAME} is missing'
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(decompressionFailed)$\r$\n$TTLogPath" /SD IDOK
    SetErrorLevel 2
    Quit
  ${endif}
!macroend
