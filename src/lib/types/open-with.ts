/** One app on the "Open with" flyout. Mirrors `OpenWithApp` in src-tauri/src/core/open_with.rs. */
export interface OpenWithApp {
  /** handed back to `open_with_app`: a handler name, a Mac `.app` path or a Linux `.desktop` path */
  id: string;
  name: string;
  /** Windows only: the handler's icon location (`C:\x\app.exe,0`) */
  icon: string | null;
  isDefault: boolean;
}
