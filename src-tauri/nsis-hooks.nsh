; nsis-hooks.nsh — Tauri NSIS installer hook
; Registers `revenant` on the system PATH so `revenant <file.md>` works from any terminal.
; Runs on install and uninstall.
;
; Architecture decision: plan §0 / A4 / CLAUDE.md "Windows PATH" requirement.
; Users must open a new terminal after install to pick up the PATH change.

!macro NSIS_HOOK_INSTALL
  ; Add the install directory to the system PATH (requires perMachine install mode).
  EnVar::SetHKLM
  EnVar::AddValue "PATH" "$INSTDIR"
  Pop $0
  DetailPrint "PATH registration result: $0"
!macroend

!macro NSIS_HOOK_UNINSTALL
  ; Remove the install directory from the system PATH on uninstall.
  EnVar::SetHKLM
  EnVar::DeleteValue "PATH" "$INSTDIR"
  Pop $0
  DetailPrint "PATH unregistration result: $0"
!macroend
