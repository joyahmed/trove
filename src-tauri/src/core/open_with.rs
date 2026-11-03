//! "Open with ▸" on a file's right-click menu (plan 15 G.61): the apps this OS has registered
//! for the file's type, the default one first and marked, and a way to open the file in one.
//!
//! Each OS has its own source, and only that part is cfg'd:
//!   Windows — `SHAssocEnumHandlers` (the list Explorer's own "Open with" shows), `IAssocHandler::
//!             Invoke` to open, `SHOpenWithDialog` for "Choose another app…". Here.
//!   Mac     — `NSWorkspace` `URLsForApplicationsToOpenURL:`; `open -a <app> <files>` to open.
//!             `open_with_mac.rs`.
//!   Linux   — `mimeinfo.cache` + `mimeapps.list` read by hand, the `.desktop` file's `Exec` (or
//!             `gio launch`) to open. `open_with_linux.rs`.
//!
//! What every OS shares — the shape of a listed app and how a raw list becomes the menu's list —
//! is plain code below, tested on every OS. Nothing here runs a handler in a test.

use std::path::Path;

use serde::Serialize;

/// One app on the "Open with ▸" flyout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWithApp {
    /// What `open_with_app` is handed back: Windows' handler name (an exe path or an app id), a
    /// Mac `.app` path, a Linux `.desktop` file path.
    pub id: String,
    /// The name the menu shows.
    pub name: String,
    /// Windows: the handler's icon location (`C:\x\app.exe,0`). Elsewhere `None`: the frontend
    /// draws a Mac `.app` or a Linux `.desktop` from its path, as the app list does.
    pub icon: Option<String>,
    /// The app a double-click would use.
    pub is_default: bool,
}

/// An app as an OS source reports it, before `shape`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RawApp {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
}

/// The menu's list from an OS's raw one: nameless or id-less entries dropped, the same id (any
/// case) kept once, the first app `is_default` accepts moved to the top and marked, the rest by
/// name (any case). At most one app is marked; none when nothing matched — a guess would mark
/// the wrong app as the one a double-click uses.
pub fn shape(raw: Vec<RawApp>, is_default: impl Fn(&RawApp) -> bool) -> Vec<OpenWithApp> {
    let mut seen = std::collections::HashSet::new();
    let mut kept: Vec<RawApp> = raw
        .into_iter()
        .filter(|a| !a.id.trim().is_empty() && !a.name.trim().is_empty())
        .filter(|a| seen.insert(a.id.to_lowercase()))
        .collect();
    let default_at = kept.iter().position(&is_default);
    let default = default_at.map(|i| kept.remove(i));
    kept.sort_by_key(|a| a.name.to_lowercase());
    let to_app = |a: RawApp, is_default: bool| OpenWithApp {
        id: a.id,
        name: a.name.trim().to_string(),
        icon: a.icon,
        is_default,
    };
    default
        .map(|a| to_app(a, true))
        .into_iter()
        .chain(kept.into_iter().map(|a| to_app(a, false)))
        .collect()
}

/// `.txt` for `C:\a\notes.TXT` — the key Windows registers handlers under. `None` for a name with
/// no extension (`Makefile`, `.gitignore` counts as one: Windows registers `.gitignore`).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn dot_ext(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let dot = name.rfind('.')?;
    let ext = &name[dot..];
    (ext.len() > 1).then(|| ext.to_lowercase())
}

/// Whether a Windows handler is the type's default: its name is the exe `AssocQueryString` names
/// for the `open` verb (any case), or — a Store app has no exe — its display name is the friendly
/// app name the same query gives.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn windows_is_default(app: &RawApp, exe: Option<&str>, friendly: Option<&str>) -> bool {
    let same =
        |a: &str, b: Option<&str>| b.is_some_and(|b| !b.is_empty() && a.eq_ignore_ascii_case(b));
    same(&app.id, exe) || same(&app.name, friendly)
}

/// `HRESULT_FROM_WIN32(ERROR_CANCELLED)`: the person closed the Open With dialog. Not a failure.
#[cfg_attr(not(windows), allow(dead_code))]
pub const HRESULT_CANCELLED: i32 = 0x8007_04C7_u32 as i32;

#[cfg(windows)]
mod win {
    use super::{dot_ext, shape, windows_is_default, OpenWithApp, RawApp, HRESULT_CANCELLED};
    use std::path::Path;
    use windows::core::{HSTRING, PCWSTR, PWSTR};
    use windows::Win32::System::Com::{CoTaskMemFree, IDataObject};
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{
        AssocQueryStringW, BHID_DataObject, IAssocHandler, IEnumAssocHandlers, ILFree,
        SHAssocEnumHandlers, SHCreateShellItemArrayFromIDLists, SHOpenWithDialog,
        SHParseDisplayName, ASSOCF_INIT_IGNOREUNKNOWN, ASSOCSTR, ASSOCSTR_EXECUTABLE,
        ASSOCSTR_FRIENDLYAPPNAME, ASSOC_FILTER_RECOMMENDED, OAIF_EXEC, OPENASINFO,
    };

    /// A shell-allocated string as a `String`, freed either way.
    fn take(p: PWSTR) -> Option<String> {
        if p.is_null() {
            return None;
        }
        // SAFETY: `p` is a NUL-terminated string the shell allocated with CoTaskMemAlloc; it is
        // read once and freed once, here.
        let s = unsafe { p.to_string() }.ok();
        unsafe { CoTaskMemFree(Some(p.0 as *const _)) };
        s
    }

    /// The recommended handlers for `ext`, each with what the menu needs from it.
    fn handlers(ext: &str) -> Vec<(IAssocHandler, RawApp)> {
        crate::core::icons::ensure_com();
        // SAFETY: a NUL-terminated extension for the call's duration; the enumerator is ours.
        let list: IEnumAssocHandlers =
            match unsafe { SHAssocEnumHandlers(&HSTRING::from(ext), ASSOC_FILTER_RECOMMENDED) } {
                Ok(l) => l,
                Err(e) => {
                    log::warn!("open with: no handler list for {ext}: {e}");
                    return Vec::new();
                }
            };
        let mut out = Vec::new();
        loop {
            let mut slot: [Option<IAssocHandler>; 1] = [None];
            let mut got = 0u32;
            // SAFETY: a live enumerator filling a one-slot array it owns the writes to.
            if unsafe { list.Next(&mut slot, Some(&mut got)) }.is_err() || got == 0 {
                break;
            }
            let Some(h) = slot[0].take() else { break };
            // SAFETY: `h` is a live handler; each out string is freed by `take`.
            let id = unsafe { h.GetName() }.ok().and_then(take);
            let name = unsafe { h.GetUIName() }.ok().and_then(take);
            let mut icon_path = PWSTR::null();
            let mut index = 0i32;
            let icon = unsafe { h.GetIconLocation(&mut icon_path, &mut index) }
                .ok()
                .and_then(|_| take(icon_path))
                .filter(|p| !p.is_empty())
                .map(|p| format!("{p},{index}"));
            if let (Some(id), Some(name)) = (id, name) {
                out.push((h, RawApp { id, name, icon }));
            }
        }
        out
    }

    /// One `AssocQueryString` answer for `ext`'s `open` verb.
    fn assoc(ext: &str, what: ASSOCSTR) -> Option<String> {
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        // SAFETY: `buf` holds `len` u16s and outlives the call; both strings are NUL-terminated.
        let hr = unsafe {
            AssocQueryStringW(
                ASSOCF_INIT_IGNOREUNKNOWN,
                what,
                &HSTRING::from(ext),
                &HSTRING::from("open"),
                Some(PWSTR(buf.as_mut_ptr())),
                &mut len,
            )
        };
        if hr.is_err() {
            return None;
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..end])).filter(|s| !s.is_empty())
    }

    pub fn apps(path: &Path) -> Vec<OpenWithApp> {
        let Some(ext) = dot_ext(path) else {
            return Vec::new();
        };
        let exe = assoc(&ext, ASSOCSTR_EXECUTABLE);
        let friendly = assoc(&ext, ASSOCSTR_FRIENDLYAPPNAME);
        let raw = handlers(&ext).into_iter().map(|(_, r)| r).collect();
        shape(raw, |a| {
            windows_is_default(a, exe.as_deref(), friendly.as_deref())
        })
    }

    /// A data object for `paths`, the form `IAssocHandler::Invoke` takes the files in.
    fn data_object(paths: &[String]) -> windows::core::Result<IDataObject> {
        let mut pidls: Vec<*mut ITEMIDLIST> = Vec::new();
        let made = (|| {
            for p in paths {
                let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
                // SAFETY: a NUL-terminated path; the PIDL written is freed below.
                unsafe {
                    SHParseDisplayName(&HSTRING::from(p.as_str()), None, &mut pidl, 0, None)
                }?;
                pidls.push(pidl);
            }
            let list: Vec<*const ITEMIDLIST> = pidls.iter().map(|p| *p as *const _).collect();
            // SAFETY: every PIDL is live until the frees below, after the array copied them.
            let items = unsafe { SHCreateShellItemArrayFromIDLists(&list) }?;
            // SAFETY: a live item array; BHID_DataObject is a static handler GUID.
            unsafe { items.BindToHandler::<_, IDataObject>(None, &BHID_DataObject) }
        })();
        for p in pidls {
            // SAFETY: each PIDL came from SHParseDisplayName and is freed once.
            unsafe { ILFree(Some(p as *const _)) };
        }
        made
    }

    pub fn open(id: &str, paths: &[String]) -> Result<(), String> {
        let first = paths.first().ok_or("no file")?;
        let ext = dot_ext(Path::new(first)).ok_or("the file has no extension")?;
        let (handler, _) = handlers(&ext)
            .into_iter()
            .find(|(_, r)| r.id.eq_ignore_ascii_case(id))
            .ok_or_else(|| format!("{id} is no longer registered for {ext}"))?;
        let data = data_object(paths).map_err(|e| e.to_string())?;
        // SAFETY: a live handler and data object; Invoke starts the app and returns.
        unsafe { handler.Invoke(&data) }.map_err(|e| e.to_string())
    }

    pub fn dialog(path: &str) -> Result<(), String> {
        crate::core::icons::ensure_com();
        let file = HSTRING::from(path);
        let info = OPENASINFO {
            pcszFile: PCWSTR(file.as_ptr()),
            pcszClass: PCWSTR::null(),
            oaifInFlags: OAIF_EXEC,
        };
        // SAFETY: `info` and the string it points at live for the call; no owner window.
        match unsafe { SHOpenWithDialog(None, &info) } {
            Ok(()) => Ok(()),
            Err(e) if e.code().0 == HRESULT_CANCELLED => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// The apps registered for `path`'s type on this OS, default first. Empty when there are none or
/// the OS has no list (an unknown type, a read that failed — logged).
pub fn apps_for(path: &Path) -> Vec<OpenWithApp> {
    #[cfg(windows)]
    {
        win::apps(path)
    }
    #[cfg(target_os = "macos")]
    {
        crate::core::open_with_mac::apps(path)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        crate::core::open_with_linux::env_apps(path)
    }
}

/// Open `paths` in the app `id` named. The `Err` is the raw reason, for the log only.
pub fn open_in(id: &str, paths: &[String]) -> Result<(), String> {
    #[cfg(windows)]
    {
        win::open(id, paths)
    }
    #[cfg(target_os = "macos")]
    {
        crate::core::open_with_mac::open(id, paths)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        crate::core::open_with_linux::env_open(id, paths)
    }
}

/// The system's own app picker for `path` (Windows only; elsewhere there is none to call).
pub fn choose_dialog(path: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        win::dialog(path)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("this system has no Open With dialog".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(id: &str, name: &str) -> RawApp {
        RawApp {
            id: id.into(),
            name: name.into(),
            icon: None,
        }
    }

    #[test]
    fn the_default_comes_first_and_is_the_only_one_marked() {
        let list = shape(
            vec![raw("c", "Zed"), raw("a", "notepad"), raw("b", "Code")],
            |a| a.id == "c",
        );
        let names: Vec<_> = list
            .iter()
            .map(|a| (a.name.as_str(), a.is_default))
            .collect();
        assert_eq!(names, [("Zed", true), ("Code", false), ("notepad", false)]);
    }

    #[test]
    fn no_match_marks_nothing_and_keeps_name_order() {
        let list = shape(vec![raw("b", "beta"), raw("a", "Alpha")], |_| false);
        assert!(list.iter().all(|a| !a.is_default));
        assert_eq!(list[0].name, "Alpha");
    }

    #[test]
    fn duplicates_and_blank_entries_are_dropped() {
        let list = shape(
            vec![
                raw(r"C:\A.exe", "A"),
                raw(r"c:\a.exe", "A again"),
                raw("", "No id"),
                raw("x", "  "),
            ],
            |_| false,
        );
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "A");
    }

    #[test]
    fn only_the_first_default_match_is_marked() {
        let list = shape(vec![raw("a", "A"), raw("b", "A")], |a| a.name == "A");
        assert_eq!(list.iter().filter(|a| a.is_default).count(), 1);
        assert_eq!(list[0].id, "a");
    }

    #[test]
    fn dot_ext_is_lower_case_with_its_dot() {
        assert_eq!(dot_ext(Path::new("notes.TXT")).as_deref(), Some(".txt"));
        assert_eq!(dot_ext(Path::new("a.tar.gz")).as_deref(), Some(".gz"));
        assert_eq!(
            dot_ext(Path::new(".gitignore")).as_deref(),
            Some(".gitignore")
        );
        assert_eq!(dot_ext(Path::new("Makefile")), None);
        assert_eq!(dot_ext(Path::new("trailing.")), None);
    }

    #[test]
    fn a_windows_default_matches_by_exe_or_by_friendly_name() {
        let code = raw(r"C:\Apps\Code.exe", "Visual Studio Code");
        assert!(windows_is_default(&code, Some(r"c:\apps\code.exe"), None));
        assert!(windows_is_default(&code, None, Some("Visual Studio Code")));
        assert!(!windows_is_default(
            &code,
            Some(r"C:\Windows\notepad.exe"),
            Some("Notepad")
        ));
        assert!(!windows_is_default(&code, Some(""), Some("")));
        assert!(!windows_is_default(&code, None, None));
    }

    #[test]
    fn a_cancelled_dialog_code_is_error_cancelled() {
        assert_eq!(HRESULT_CANCELLED as u32, 0x800704C7);
    }

    #[test]
    fn the_app_serializes_in_camel_case() {
        let app = OpenWithApp {
            id: "x".into(),
            name: "X".into(),
            icon: None,
            is_default: true,
        };
        let json = serde_json::to_string(&app).unwrap();
        assert!(json.contains("\"isDefault\":true"), "{json}");
    }
}
