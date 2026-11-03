; NSIS installer hooks for Trove.
;
; Wired up via bundle.windows.nsis.installerHooks in tauri.conf.json. The Tauri
; NSIS template !includes this file near the top of the generated installer.nsi
; and then guards every call site with !ifmacrodef, so only the macros defined
; here run -- the four supported names are NSIS_HOOK_PREINSTALL,
; NSIS_HOOK_POSTINSTALL, NSIS_HOOK_PREUNINSTALL and NSIS_HOOK_POSTUNINSTALL.
; A macro with any other name is silently never called.
;
; SHCTX follows SetShellVarContext, which the template sets from
; bundle.windows.nsis.installMode ("currentUser" -> current) in both .onInit
; and un.onInit. With the current config that makes SHCTX = HKCU on both sides.

; Registers App Paths\trove.exe so Windows itself can resolve "trove" from the
; Run dialog, ShellExecute and the search box. The stock template never writes
; this key.
!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Registering App Paths for ${MAINBINARYNAME}.exe"
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\${MAINBINARYNAME}.exe" "Path" "$INSTDIR"
!macroend

; Drops one "default file manager" override written by core/default_handler.rs, only when it
; still holds THIS exe's command. Deleting the HKCU override hands the verb back to Explorer
; (its real definition lives in HKLM/HKCR, never touched here). Parents go only while empty.
; Args: the `command` key exactly as in HANDLER_KEYS, its parent, its grandparent (all under
; Software\Classes). A Rust test keeps the first argument of each call equal to HANDLER_KEYS.
!macro TROVE_DROP_HANDLER KEY PARENT GRANDPARENT
  ReadRegStr $0 HKCU "Software\Classes\${KEY}" ""
  StrCmp $0 '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"' 0 +5
    DetailPrint "Removing default file manager override ${KEY}"
    DeleteRegKey HKCU "Software\Classes\${KEY}"
    DeleteRegKey /ifempty HKCU "Software\Classes\${PARENT}"
    DeleteRegKey /ifempty HKCU "Software\Classes\${GRANDPARENT}"
!macroend

; Mandatory counterpart. Without it an uninstall leaves the key pointing at a
; deleted exe, which is worse than never having written it. Unconditional on
; purpose: during an update the old uninstaller runs before the new Section
; Install, so POSTINSTALL above rewrites the key immediately afterwards, and an
; update that aborts in between leaves no dangling key.
!macro NSIS_HOOK_POSTUNINSTALL
  DetailPrint "Removing App Paths for ${MAINBINARYNAME}.exe"
  DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\${MAINBINARYNAME}.exe"

  ; "Use as default file manager" and "Start with Windows" are per-user settings written by
  ; the app itself. Left behind they point at the deleted exe: Win+E and every folder
  ; double-click break. An update runs this uninstaller too, so skip it then ($UpdateMode)
  ; and let the setting survive the upgrade.
  ${If} $UpdateMode <> 1
    ; The saved search index (commands/index_settings.rs INDEX_DIR): a list of every file name
    ; on the PC, so it goes with the app, always (not only when "delete app data" is ticked).
    ; An update keeps it. Tauri's app_data_dir is $APPDATA\<bundle identifier>.
    DetailPrint "Removing the saved search index"
    RMDir /r "$APPDATA\${BUNDLEID}\index"

    !insertmacro TROVE_DROP_HANDLER "CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}\shell\opennewwindow\command" "CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}\shell\opennewwindow" "CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}\shell"
    !insertmacro TROVE_DROP_HANDLER "Directory\shell\open\command" "Directory\shell\open" "Directory\shell"
    !insertmacro TROVE_DROP_HANDLER "Folder\shell\open\command" "Folder\shell\open" "Folder\shell"
    !insertmacro TROVE_DROP_HANDLER "Drive\shell\open\command" "Drive\shell\open" "Drive\shell"

    ; The Run value (core/startup.rs RUN_KEY / RUN_VALUE), only if it is this exe's.
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Trove"
    StrCmp $0 '"$INSTDIR\${MAINBINARYNAME}.exe" --hidden' 0 +3
      DetailPrint "Removing Start with Windows entry"
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Trove"
  ${EndIf}
!macroend
