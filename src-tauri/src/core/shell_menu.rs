//! Windows' own right-click menu for a selection or a folder background (plan 05 5.1, plan 08
//! D.1): `IContextMenu` asked on a dedicated STA thread, its `HMENU` walked into a tree the
//! frontend can render inside Trove's one menu, and a chosen item run by its id.
//!
//! ⛔ Nothing here blocks the IPC thread for long. Every call goes to the worker over a channel
//! and is awaited with a deadline; a worker that misses it is retired (a fresh thread takes the
//! next call), so one hung shell extension costs one leaked thread, never a frozen window.
//!
//! The tree walk is generic over [`MenuSource`] so it is tested with a fake menu on every OS;
//! only the COM half is Windows-only.
#![cfg_attr(not(windows), allow(dead_code))] // the walk and icon store run only on Windows; tested everywhere
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// One row of the shell's menu, as the frontend renders it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellMenuItem {
    /// The command id to hand back to [`invoke`]; 0 for a separator or a submenu row.
    pub id: u32,
    pub label: String,
    /// The canonical verb (`open`, `copy`, `properties` …) when the handler names one.
    pub verb: Option<String>,
    pub enabled: bool,
    pub separator: bool,
    pub children: Vec<ShellMenuItem>,
    /// `menu/<hash>`: the item's bitmap, served by the icon protocol (`core/icons.rs`).
    pub icon_key: Option<String>,
}

/// One query's answer. `token` names the live `IContextMenu` an [`invoke`] must target; the
/// next query replaces it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellMenu {
    pub token: u64,
    pub items: Vec<ShellMenuItem>,
}

/// What one `HMENU` row reads as, before cleaning — the seam the fake menu in the tests fills.
#[derive(Debug, Clone)]
pub struct RawItem<H> {
    pub id: u32,
    pub label: String,
    pub separator: bool,
    pub disabled: bool,
    pub submenu: Option<H>,
    pub icon_key: Option<String>,
}

/// A menu the walk can read: the real `HMENU` + `IContextMenu`, or a fake.
pub trait MenuSource {
    type Handle: Copy;
    /// Called before a submenu is read: the shell fills "Send to" / "Open with" on
    /// `WM_INITMENUPOPUP`, so an unopened one reads empty.
    fn prepare(&self, _sub: Self::Handle, _index: u32) {}
    fn items(&self, menu: Self::Handle) -> Vec<RawItem<Self::Handle>>;
    /// The canonical verb for a command id, if the handler gives one.
    fn verb(&self, id: u32) -> Option<String>;
}

/// The deepest submenu walked; nobody nests deeper, and a broken handler cannot loop us.
const MAX_DEPTH: u32 = 4;

/// `"Open &with\tCtrl+O"` → `"Open with"`; `&&` stays a literal `&`.
pub fn clean_label(raw: &str) -> String {
    let text = raw.split('\t').next().unwrap_or("");
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '&' {
            if chars.peek() == Some(&'&') {
                out.push('&');
                chars.next();
            }
            continue;
        }
        out.push(c);
    }
    out.trim().to_string()
}

/// No separator first, last or twice in a row — what dropping rows leaves behind.
pub fn tidy_separators(items: Vec<ShellMenuItem>) -> Vec<ShellMenuItem> {
    let mut out: Vec<ShellMenuItem> = Vec::with_capacity(items.len());
    for item in items {
        if item.separator && out.last().is_none_or(|l| l.separator) {
            continue;
        }
        out.push(item);
    }
    while out.last().is_some_and(|l| l.separator) {
        out.pop();
    }
    out
}

/// Walk `menu` into the serializable tree: labels cleaned, textless rows (owner-drawn with
/// nothing to show) and empty submenus dropped, separators tidied.
pub fn walk<S: MenuSource>(src: &S, menu: S::Handle) -> Vec<ShellMenuItem> {
    walk_at(src, menu, 0)
}

fn walk_at<S: MenuSource>(src: &S, menu: S::Handle, depth: u32) -> Vec<ShellMenuItem> {
    let mut out = Vec::new();
    for (index, raw) in src.items(menu).into_iter().enumerate() {
        if raw.separator {
            out.push(ShellMenuItem {
                id: 0,
                label: String::new(),
                verb: None,
                enabled: false,
                separator: true,
                children: Vec::new(),
                icon_key: None,
            });
            continue;
        }
        let label = clean_label(&raw.label);
        if label.is_empty() {
            continue;
        }
        let children = match raw.submenu {
            Some(sub) if depth < MAX_DEPTH => {
                src.prepare(sub, index as u32);
                let kids = walk_at(src, sub, depth + 1);
                if kids.is_empty() {
                    continue;
                }
                kids
            }
            Some(_) => continue,
            None => Vec::new(),
        };
        let leaf = children.is_empty();
        out.push(ShellMenuItem {
            id: if leaf { raw.id } else { 0 },
            label,
            verb: if leaf {
                src.verb(raw.id).map(|v| v.to_ascii_lowercase())
            } else {
                None
            },
            enabled: !raw.disabled,
            separator: false,
            children,
            icon_key: raw.icon_key,
        });
    }
    tidy_separators(out)
}

/// The menu bitmaps seen this run, as PNG by key. Small (16px) and few; cleared wholesale past
/// the cap rather than tracked by age.
static ICONS: Mutex<Option<HashMap<String, Arc<[u8]>>>> = Mutex::new(None);
const ICON_CAP: usize = 512;

/// Keep `png` and return its `menu/<hash>` key.
pub fn store_icon(png: Vec<u8>) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    png.hash(&mut h);
    let key = format!("menu/{:016x}", h.finish());
    let mut guard = ICONS.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    if map.len() >= ICON_CAP && !map.contains_key(&key) {
        map.clear();
    }
    map.entry(key.clone()).or_insert_with(|| png.into());
    key
}

/// The PNG behind a `menu/<hash>` key, if this run has seen it.
pub fn icon(key: &str) -> Option<Arc<[u8]>> {
    let guard = ICONS.lock().unwrap_or_else(|e| e.into_inner());
    guard.as_ref()?.get(key).cloned()
}

#[cfg(windows)]
pub use win::{invoke, query};

/// How long after launch the worker is warmed: past the first listing, before most first clicks.
#[cfg(windows)]
pub const PREWARM_DELAY: std::time::Duration = std::time::Duration::from_secs(3);

/// Start the worker and ask it once about a scratch file, off the startup path, so the first
/// real right-click finds COM up and the common handlers (7-Zip, Send to, Defender) loaded,
/// then once about a folder's empty space. Cold, the first answer took 539-781 ms on a test machine,
/// past the 400 ms the menu waits; warmed, a file took 40-90 ms. Errors are logged and dropped:
/// a cold first menu is the cost, never a failed launch.
#[cfg(windows)]
pub fn prewarm() {
    let file = std::env::temp_dir().join("trove-shell-menu-warm.txt");
    if let Err(e) = std::fs::write(&file, b"") {
        log::info!("shell menu prewarm: no scratch file: {e}");
        return;
    }
    let started = std::time::Instant::now();
    match query(vec![file.to_string_lossy().into_owned()], false, false, 0) {
        Ok(m) => log::info!(
            "shell menu prewarm: {} rows in {} ms",
            m.items.len(),
            started.elapsed().as_millis()
        ),
        Err(e) => log::info!("shell menu prewarm: {e}"),
    }
    let _ = std::fs::remove_file(&file);
    // the empty-space menu loads its own handlers (New, view): its first ask was 294-357 ms warm
    let started = std::time::Instant::now();
    match query(
        vec![std::env::temp_dir().to_string_lossy().into_owned()],
        true,
        false,
        0,
    ) {
        Ok(m) => log::info!(
            "shell menu prewarm (background): {} rows in {} ms",
            m.items.len(),
            started.elapsed().as_millis()
        ),
        Err(e) => log::info!("shell menu prewarm (background): {e}"),
    }
}

/// Not on macOS or Linux: their menus stay as they are.
#[cfg(not(windows))]
pub fn query(
    _paths: Vec<String>,
    _background: bool,
    _extended: bool,
    _hwnd: isize,
) -> Result<ShellMenu, String> {
    Err("The Windows shell menu exists only on Windows".into())
}

#[cfg(not(windows))]
pub fn invoke(_token: u64, _id: u32, _dir: String, _hwnd: isize) -> Result<(), String> {
    Err("The Windows shell menu exists only on Windows".into())
}

#[cfg(windows)]
mod win {
    use super::{walk, MenuSource, RawItem, ShellMenu};
    use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
    use std::sync::Mutex;
    use std::time::Duration;
    use windows::core::{PCSTR, PCWSTR, PSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, POINT, WPARAM};
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{
        IContextMenu, IContextMenu2, ILFindLastID, ILFree, IShellFolder, SHBindToObject,
        SHBindToParent, SHParseDisplayName, CMF_EXTENDEDVERBS, CMF_NORMAL, CMINVOKECOMMANDINFO,
        CMINVOKECOMMANDINFOEX, GCS_VERBW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreatePopupMenu, DestroyMenu, DispatchMessageW, GetMenuItemCount, GetMenuItemInfoW,
        PeekMessageW, TranslateMessage, HMENU, MENUITEMINFOW, MFS_DISABLED, MFT_SEPARATOR,
        MIIM_BITMAP, MIIM_FTYPE, MIIM_ID, MIIM_STATE, MIIM_STRING, MIIM_SUBMENU, MSG, PM_REMOVE,
        SW_SHOWNORMAL, WM_INITMENUPOPUP,
    };

    /// How long a query may take before the worker is presumed hung. The frontend's own
    /// deadline (~400 ms) is shorter; this one only bounds the IPC call.
    const QUERY_DEADLINE: Duration = Duration::from_secs(3);
    /// An invoke that shows its own dialog can run for minutes; past this the call returns
    /// and the worker is retired, still running the handler.
    const INVOKE_DEADLINE: Duration = Duration::from_secs(2);
    const ID_FIRST: u32 = 1;
    const ID_LAST: u32 = 0x7FFF;
    const CMIC_MASK_UNICODE: u32 = 0x0000_4000;
    const CMIC_MASK_ASYNCOK: u32 = 0x0010_0000;

    enum Job {
        Query {
            paths: Vec<String>,
            background: bool,
            extended: bool,
            hwnd: isize,
            reply: Sender<Result<ShellMenu, String>>,
        },
        Invoke {
            token: u64,
            id: u32,
            dir: String,
            hwnd: isize,
            reply: Sender<Result<(), String>>,
        },
    }

    static WORKER: Mutex<Option<Sender<Job>>> = Mutex::new(None);

    fn worker() -> Result<Sender<Job>, String> {
        let mut guard = WORKER.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(tx) = guard.as_ref() {
            return Ok(tx.clone());
        }
        let (tx, rx) = channel();
        std::thread::Builder::new()
            .name("shell-menu-sta".into())
            .spawn(move || run(rx))
            .map_err(|e| format!("shell menu thread: {e}"))?;
        *guard = Some(tx.clone());
        Ok(tx)
    }

    /// The worker missed a deadline: the next call gets a fresh thread. The old one keeps
    /// whatever it is stuck in and exits once it comes back to an empty, closed channel.
    fn retire() {
        *WORKER.lock().unwrap_or_else(|e| e.into_inner()) = None;
        log::warn!("shell menu: a shell extension missed its deadline; worker retired");
    }

    fn ask<T>(
        job: impl FnOnce(Sender<Result<T, String>>) -> Job,
        deadline: Duration,
    ) -> Option<Result<T, String>> {
        let (reply, rx) = channel();
        let tx = match worker() {
            Ok(tx) => tx,
            Err(e) => return Some(Err(e)),
        };
        if tx.send(job(reply)).is_err() {
            retire();
            return Some(Err("The shell menu worker stopped".into()));
        }
        match rx.recv_timeout(deadline) {
            Ok(r) => Some(r),
            Err(RecvTimeoutError::Timeout) => {
                retire();
                None
            }
            Err(RecvTimeoutError::Disconnected) => {
                Some(Err("The shell menu worker stopped".into()))
            }
        }
    }

    /// The shell's menu for `paths` (one folder, all siblings) or, with `background`, for the
    /// empty space of the folder `paths[0]`. Shift adds the extended verbs, as in Explorer.
    pub fn query(
        paths: Vec<String>,
        background: bool,
        extended: bool,
        hwnd: isize,
    ) -> Result<ShellMenu, String> {
        ask(
            |reply| Job::Query {
                paths,
                background,
                extended,
                hwnd,
                reply,
            },
            QUERY_DEADLINE,
        )
        .unwrap_or_else(|| Err("Windows' menu items took too long".into()))
    }

    /// Run item `id` of the menu `token` names, from the folder `dir`.
    pub fn invoke(token: u64, id: u32, dir: String, hwnd: isize) -> Result<(), String> {
        // a handler still showing its own dialog past the deadline has not failed
        ask(
            |reply| Job::Invoke {
                token,
                id,
                dir,
                hwnd,
                reply,
            },
            INVOKE_DEADLINE,
        )
        .unwrap_or(Ok(()))
    }

    /// The live menu an invoke targets. Dropped (and its `HMENU` destroyed) by the next query.
    struct Live {
        token: u64,
        ctx: IContextMenu,
        hmenu: HMENU,
    }

    impl Drop for Live {
        fn drop(&mut self) {
            // SAFETY: `hmenu` came from CreatePopupMenu and is destroyed exactly once, here.
            unsafe {
                let _ = DestroyMenu(self.hmenu);
            }
        }
    }

    fn run(rx: Receiver<Job>) {
        super::super::icons::ensure_com();
        let mut live: Option<Live> = None;
        let mut next_token = 1u64;
        loop {
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(Job::Query {
                    paths,
                    background,
                    extended,
                    hwnd,
                    reply,
                }) => {
                    live = None;
                    let token = next_token;
                    next_token += 1;
                    let answer =
                        build(&paths, background, extended, hwnd).map(|(ctx, hmenu, items)| {
                            live = Some(Live { token, ctx, hmenu });
                            ShellMenu { token, items }
                        });
                    let _ = reply.send(answer);
                }
                Ok(Job::Invoke {
                    token,
                    id,
                    dir,
                    hwnd,
                    reply,
                }) => {
                    let answer = match live.as_ref().filter(|l| l.token == token) {
                        Some(l) => run_command(&l.ctx, id, &dir, hwnd),
                        None => Err("That menu has closed; right-click again".into()),
                    };
                    let _ = reply.send(answer);
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            pump();
        }
    }

    /// An STA thread must pump: some handlers post to hidden windows on it.
    fn pump() {
        let mut msg = MSG::default();
        // SAFETY: a live MSG; a null window reads this thread's queue.
        unsafe {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Absolute PIDLs, freed on drop.
    struct Pidls(Vec<*mut ITEMIDLIST>);
    impl Drop for Pidls {
        fn drop(&mut self) {
            for p in self.0.drain(..) {
                // SAFETY: each came from SHParseDisplayName and is freed once.
                unsafe { ILFree(Some(p)) };
            }
        }
    }

    fn parse(path: &str) -> Result<*mut ITEMIDLIST, String> {
        let w = wide(path);
        let mut pidl = std::ptr::null_mut();
        // SAFETY: a NUL-terminated name and a live out pointer.
        unsafe { SHParseDisplayName(PCWSTR(w.as_ptr()), None, &mut pidl, 0, None) }
            .map_err(|e| format!("{path}: {e}"))?;
        Ok(pidl)
    }

    fn build(
        paths: &[String],
        background: bool,
        extended: bool,
        hwnd: isize,
    ) -> Result<(IContextMenu, HMENU, Vec<super::ShellMenuItem>), String> {
        if paths.is_empty() {
            return Err("No item to ask the shell about".into());
        }
        let owner = HWND(hwnd as *mut _);
        let pidls = Pidls(paths.iter().map(|p| parse(p)).collect::<Result<_, _>>()?);
        // SAFETY: every PIDL is live for the duration of these calls; the menu object copies
        // what it needs, so freeing them afterwards is fine.
        let ctx: IContextMenu = unsafe {
            if background {
                let folder: IShellFolder =
                    SHBindToObject(None, pidls.0[0], None).map_err(|e| e.to_string())?;
                folder.CreateViewObject(owner).map_err(|e| e.to_string())?
            } else {
                let parent: IShellFolder =
                    SHBindToParent(pidls.0[0], None).map_err(|e| e.to_string())?;
                let children: Vec<*const ITEMIDLIST> = pidls
                    .0
                    .iter()
                    .map(|p| ILFindLastID(*p) as *const _)
                    .collect();
                parent
                    .GetUIObjectOf(owner, &children, None)
                    .map_err(|e| e.to_string())?
            }
        };
        // SAFETY: plain menu creation; owned by `Live` from here.
        let hmenu = unsafe { CreatePopupMenu() }.map_err(|e| e.to_string())?;
        let flags = CMF_NORMAL | if extended { CMF_EXTENDEDVERBS } else { 0 };
        // SAFETY: a live menu and an id range we own.
        let hr = unsafe { ctx.QueryContextMenu(hmenu, 0, ID_FIRST, ID_LAST, flags) };
        if hr.is_err() {
            // SAFETY: not handed to `Live`, so destroyed here.
            unsafe {
                let _ = DestroyMenu(hmenu);
            }
            return Err(hr.message());
        }
        let src = Real {
            ctx: &ctx,
            ctx2: windows::core::Interface::cast(&ctx).ok(),
        };
        let items = walk(&src, hmenu);
        Ok((ctx, hmenu, items))
    }

    fn run_command(ctx: &IContextMenu, id: u32, dir: &str, hwnd: isize) -> Result<(), String> {
        if id < ID_FIRST {
            return Err("Not a command".into());
        }
        let dir_w = wide(dir);
        let offset = (id - ID_FIRST) as usize;
        let info = CMINVOKECOMMANDINFOEX {
            cbSize: std::mem::size_of::<CMINVOKECOMMANDINFOEX>() as u32,
            fMask: CMIC_MASK_UNICODE | CMIC_MASK_ASYNCOK,
            hwnd: HWND(hwnd as *mut _),
            // MAKEINTRESOURCE(offset): the command by position, not by name
            lpVerb: PCSTR(offset as *const u8),
            lpVerbW: PCWSTR(offset as *const u16),
            lpDirectory: PCSTR::null(),
            lpDirectoryW: if dir.is_empty() {
                PCWSTR::null()
            } else {
                PCWSTR(dir_w.as_ptr())
            },
            nShow: SW_SHOWNORMAL.0,
            ptInvoke: POINT::default(),
            ..Default::default()
        };
        // SAFETY: `info` and the strings it points at outlive the call; the EX struct starts
        // with the plain one's layout, which is how the API is meant to be called.
        unsafe {
            ctx.InvokeCommand((&info as *const CMINVOKECOMMANDINFOEX).cast::<CMINVOKECOMMANDINFO>())
        }
        .map_err(|e| e.message())
    }

    struct Real<'a> {
        ctx: &'a IContextMenu,
        ctx2: Option<IContextMenu2>,
    }

    impl MenuSource for Real<'_> {
        type Handle = HMENU;

        fn prepare(&self, sub: HMENU, index: u32) {
            if let Some(c2) = &self.ctx2 {
                // SAFETY: a live submenu handle; the handler fills it in place.
                let _ = unsafe {
                    c2.HandleMenuMsg(
                        WM_INITMENUPOPUP,
                        WPARAM(sub.0 as usize),
                        LPARAM(index as isize),
                    )
                };
            }
        }

        fn items(&self, menu: HMENU) -> Vec<RawItem<HMENU>> {
            // SAFETY: a live menu handle.
            let count = unsafe { GetMenuItemCount(Some(menu)) }.max(0) as u32;
            (0..count).filter_map(|i| read_item(menu, i)).collect()
        }

        fn verb(&self, id: u32) -> Option<String> {
            if id < ID_FIRST {
                return None;
            }
            let mut buf = [0u16; 128];
            // SAFETY: GCS_VERBW writes at most `cchmax` UTF-16 units into `buf`.
            unsafe {
                self.ctx
                    .GetCommandString(
                        (id - ID_FIRST) as usize,
                        GCS_VERBW,
                        None,
                        PSTR(buf.as_mut_ptr().cast()),
                        buf.len() as u32,
                    )
                    .ok()?;
            }
            let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            let verb = String::from_utf16_lossy(&buf[..end]);
            (!verb.trim().is_empty()).then(|| verb.trim().to_string())
        }
    }

    fn read_item(menu: HMENU, index: u32) -> Option<RawItem<HMENU>> {
        let mut info = MENUITEMINFOW {
            cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
            fMask: MIIM_FTYPE | MIIM_STATE | MIIM_ID | MIIM_SUBMENU | MIIM_STRING | MIIM_BITMAP,
            ..Default::default()
        };
        // SAFETY: first call sizes the string (null buffer), second reads it into `buf`.
        unsafe { GetMenuItemInfoW(menu, index, true, &mut info) }.ok()?;
        let separator = info.fType.0 & MFT_SEPARATOR.0 != 0;
        let mut buf = vec![0u16; info.cch as usize + 1];
        if !separator && info.cch > 0 {
            info.dwTypeData = windows::core::PWSTR(buf.as_mut_ptr());
            info.cch += 1;
            // SAFETY: `buf` holds `cch` units including the NUL.
            unsafe { GetMenuItemInfoW(menu, index, true, &mut info) }.ok()?;
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let label = if separator {
            String::new()
        } else {
            String::from_utf16_lossy(&buf[..end])
        };
        Some(RawItem {
            id: info.wID,
            label,
            separator,
            disabled: info.fState.0 & MFS_DISABLED.0 != 0,
            submenu: (!info.hSubMenu.is_invalid()).then_some(info.hSubMenu),
            icon_key: icon_of(info.hbmpItem.0 as isize),
        })
    }

    /// A real bitmap (not one of the `HBMMENU_*` stand-ins, -1 and 1..=11) as a served PNG.
    fn icon_of(hbm: isize) -> Option<String> {
        if hbm == 0 || hbm == -1 || (1..=11).contains(&hbm) {
            return None;
        }
        let (w, h, rgba) = super::super::icons::bitmap_to_rgba(hbm as *mut _)?;
        let png = super::super::icons::encode_png(w, h, &rgba)?;
        Some(super::store_icon(png))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// A menu as data: handle → rows; `filled` handles get their rows only after `prepare`,
    /// the way "Send to" does.
    #[derive(Default)]
    struct Fake {
        menus: HashMap<u32, Vec<RawItem<u32>>>,
        lazy: HashMap<u32, Vec<RawItem<u32>>>,
        verbs: HashMap<u32, &'static str>,
        prepared: RefCell<Vec<u32>>,
    }

    impl MenuSource for Fake {
        type Handle = u32;
        fn prepare(&self, sub: u32, _index: u32) {
            self.prepared.borrow_mut().push(sub);
        }
        fn items(&self, menu: u32) -> Vec<RawItem<u32>> {
            if let Some(rows) = self.menus.get(&menu) {
                return rows.clone();
            }
            if self.prepared.borrow().contains(&menu) {
                return self.lazy.get(&menu).cloned().unwrap_or_default();
            }
            Vec::new()
        }
        fn verb(&self, id: u32) -> Option<String> {
            self.verbs.get(&id).map(|v| v.to_string())
        }
    }

    fn item(id: u32, label: &str) -> RawItem<u32> {
        RawItem {
            id,
            label: label.into(),
            separator: false,
            disabled: false,
            submenu: None,
            icon_key: None,
        }
    }
    fn sep() -> RawItem<u32> {
        RawItem {
            separator: true,
            ..item(0, "")
        }
    }
    fn sub(handle: u32, label: &str) -> RawItem<u32> {
        RawItem {
            submenu: Some(handle),
            ..item(99, label)
        }
    }

    #[test]
    fn labels_lose_accelerators_and_shortcut_text() {
        assert_eq!(clean_label("Open &with"), "Open with");
        assert_eq!(clean_label("Tom && Jerry"), "Tom & Jerry");
        assert_eq!(clean_label("&Copy\tCtrl+C"), "Copy");
        assert_eq!(clean_label("&"), "");
    }

    #[test]
    fn walk_reads_rows_verbs_and_submenus() {
        let mut f = Fake::default();
        f.menus.insert(
            1,
            vec![
                item(1, "&Open"),
                sep(),
                RawItem {
                    disabled: true,
                    icon_key: Some("menu/ab".into()),
                    ..item(2, "Scan with &Defender")
                },
                sub(2, "Se&nd to"),
                sep(),
                item(3, "P&roperties"),
            ],
        );
        f.lazy.insert(
            2,
            vec![
                item(10, "Desktop (create shortcut)"),
                item(11, "Mail recipient"),
            ],
        );
        f.verbs.insert(1, "Open");
        f.verbs.insert(3, "properties");
        let tree = walk(&f, 1);
        let labels: Vec<_> = tree.iter().map(|i| i.label.as_str()).collect();
        assert_eq!(
            labels,
            [
                "Open",
                "",
                "Scan with Defender",
                "Send to",
                "",
                "Properties"
            ]
        );
        assert_eq!(
            tree[0].verb.as_deref(),
            Some("open"),
            "verbs are lower-cased"
        );
        assert!(!tree[2].enabled);
        assert_eq!(tree[2].icon_key.as_deref(), Some("menu/ab"));
        assert_eq!(tree[3].id, 0, "a submenu row runs nothing");
        assert_eq!(tree[3].children.len(), 2, "filled by prepare, like Send to");
        assert_eq!(tree[3].children[1].id, 11);
        assert_eq!(*f.prepared.borrow(), vec![2]);
    }

    #[test]
    fn walk_drops_textless_rows_empty_submenus_and_stray_separators() {
        let mut f = Fake::default();
        f.menus.insert(
            1,
            vec![
                sep(),
                item(1, ""),
                sep(),
                sub(5, "Empty"),
                sep(),
                item(2, "Keep"),
                sep(),
                sep(),
            ],
        );
        let tree = walk(&f, 1);
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].label, "Keep");
    }

    #[test]
    fn walk_stops_at_max_depth() {
        let mut f = Fake::default();
        for h in 1..10 {
            f.menus
                .insert(h, vec![sub(h + 1, "deeper"), item(h, "leaf")]);
        }
        let tree = walk(&f, 1);
        let mut depth = 0;
        let mut node = &tree;
        while let Some(first) = node.first().filter(|i| !i.children.is_empty()) {
            depth += 1;
            node = &first.children;
        }
        assert_eq!(depth, MAX_DEPTH as usize);
    }

    #[test]
    fn tree_serializes_camel_case() {
        let item = ShellMenuItem {
            id: 7,
            label: "Open".into(),
            verb: Some("open".into()),
            enabled: true,
            separator: false,
            children: vec![],
            icon_key: Some("menu/1".into()),
        };
        let json = serde_json::to_value(ShellMenu {
            token: 3,
            items: vec![item],
        })
        .unwrap();
        assert_eq!(json["items"][0]["iconKey"], "menu/1");
        assert_eq!(json["token"], 3);
    }

    #[test]
    fn icons_round_trip_by_key() {
        let key = store_icon(vec![1, 2, 3]);
        assert!(key.starts_with("menu/"));
        assert_eq!(icon(&key).as_deref(), Some(&[1u8, 2, 3][..]));
        assert_eq!(icon("menu/none"), None);
    }

    /// Run once by hand: `cargo test shell_menu::tests::live_prewarm -- --ignored --nocapture`.
    /// The cold first ask, then what a right-click after the prewarm costs.
    #[cfg(windows)]
    #[test]
    #[ignore = "asks the real shell; prints cold and warm timings"]
    fn live_prewarm_then_a_real_ask() {
        use std::time::Instant;
        let t = Instant::now();
        prewarm();
        println!("cold prewarm: {} ms", t.elapsed().as_millis());
        let dir = std::env::temp_dir().join("trove-shell-menu-timing");
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("notes.txt");
        let b = dir.join("photo.png");
        std::fs::write(&a, b"hi").unwrap();
        std::fs::write(&b, b"x").unwrap();
        for (name, paths, bg) in [
            ("file", vec![a.display().to_string()], false),
            (
                "two files",
                vec![a.display().to_string(), b.display().to_string()],
                false,
            ),
            ("background", vec![dir.display().to_string()], true),
            ("file again", vec![a.display().to_string()], false),
        ] {
            let t = Instant::now();
            let got = query(paths, bg, false, 0);
            println!(
                "warm {name}: {} ms, {} rows",
                t.elapsed().as_millis(),
                got.map(|m| m.items.len()).unwrap_or(0)
            );
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Run once by hand: `cargo test shell_menu::tests::live -- --ignored --nocapture`.
    #[cfg(windows)]
    #[test]
    #[ignore = "asks the real shell; prints the verbs it sees"]
    fn live_menu_on_a_temp_file() {
        let path = std::env::temp_dir().join("trove-shell-menu-live.txt");
        std::fs::write(&path, b"hi").unwrap();
        let menu = query(vec![path.display().to_string()], false, false, 0).expect("menu");
        fn dump(items: &[ShellMenuItem], depth: usize) {
            for i in items {
                if i.separator {
                    println!("{}----", "  ".repeat(depth));
                } else {
                    println!(
                        "{}{} [id {} verb {:?} icon {}]",
                        "  ".repeat(depth),
                        i.label,
                        i.id,
                        i.verb,
                        i.icon_key.is_some()
                    );
                    dump(&i.children, depth + 1);
                }
            }
        }
        dump(&menu.items, 0);
        assert!(!menu.items.is_empty());
        let bg = query(
            vec![std::env::temp_dir().display().to_string()],
            true,
            false,
            0,
        )
        .expect("background");
        println!("== background ==");
        dump(&bg.items, 0);
        let _ = std::fs::remove_file(path);
    }
}
