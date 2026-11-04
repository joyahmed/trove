fn main() {
    // Our own manifest replaces tauri-build's default: the same comctl32 v6 dependency plus
    // `longPathAware`, so Win32 calls the app makes accept paths over 260 characters.
    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app-manifest.xml"));
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run tauri-build");
}
