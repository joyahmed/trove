//! macOS uninstall (plan 18, Phase 3): move the `.app` bundle to the Trash, after pre-checks.
//!
//! Trove never deletes an app. The move goes through `Launcher::trash` → `ops::trash` →
//! `trash_mac` (Finder first, so Put Back works; the file manager when macOS refuses Trove
//! Apple Events for Finder; a typed `NoRecycleBin` when both fail). A `NoRecycleBin` is NOT
//! followed by a permanent delete here: the person is told to drag the app to the Trash in
//! Finder (plan 18 rule "never a fake Trash").
//!
//! What is refused, and how it is told (every check runs on the fresh listing, at action time):
//! - `/System/…` (path prefix) or a read-only volume (`statfs` `MNT_RDONLY`: the sealed system
//!   volume) → `System`.
//! - a symlink: the bundle itself, or ANY folder on its way (the path is not its own canonical
//!   form) → `Link`, or `System` when the link resolves into `/System` (Safari:
//!   `/Applications/Safari.app` → `/System/Cryptexes/App/System/Applications/Safari.app`, which
//!   `apps_mac` lists for that reason). Trashing the link would say "moved" while the app stays;
//!   following it would move an app that lives elsewhere. Decided: refuse both, never move
//!   through a link; the target is resolved only to pick the reason shown.
//! - not a real folder named `*.app` holding a `Contents` folder → `NotApp`.
//! - not directly in `/Applications` or `~/Applications` (or one folder deeper, `Utilities`), or
//!   on a network volume (`statfs` filesystem type) → `Elsewhere`.
//! - the bundle Trove itself runs from → `Trove`.
//! - running: any process whose executable (`proc_pidpath`), any argv entry (`KERN_PROCARGS2`:
//!   the exec path and every argument, so `/bin/sh X.app/Contents/MacOS/run` counts) or working
//!   folder (`PROC_PIDVNODEPATHINFO` `pvi_cdir`) lies inside the bundle, compared by path
//!   component (`/A/X.app` never matches `/A/X.appfoo`) → `Refusal::Running` "Quit {name}
//!   first". Fail closed: if the pid list itself cannot be read, the app counts as running (same
//!   sentence). A pid whose details cannot be read (`EPERM` on another user's process, or one
//!   that just ended) is skipped, not fatal: those fields are simply absent for it. Checked only
//!   when acting, not when listing.
//!
//! The entry the person confirmed is pinned by `stamp`: a hash of the bundle folder's device,
//! inode and mtime. `uninstall::resolve` refuses a fresh row whose stamp differs (`Changed`), so
//! an app swapped in at the same path after the confirm is never moved.
//!
//! ⛔ Tests never pass a real app to anything that moves: they build `X.app` folders in a temp
//! dir and hand a `Recorder` or a fake `trash_mac` runner. The read-only, network and running
//! checks are a `Probe`, so the pure part runs on every OS. Compiled on macOS and in tests.

use std::path::{Path, PathBuf};

use crate::core::ops::no_recycle_bin;
use crate::core::uninstall::{
    resolve, stable_id, Command, Confirmed, Launcher, Refusal, Removable, Uninstallable,
};

/// What the pre-checks ask the live system. Read-only, all three.
pub trait Probe {
    /// on a read-only volume (the sealed system volume)
    fn read_only(&self, path: &Path) -> bool;
    /// on a network volume (smbfs, nfs, afpfs, webdav…)
    fn network(&self, path: &Path) -> bool;
    /// some process runs an executable inside `bundle`
    fn running(&self, bundle: &Path) -> bool;
}

/// Where the checks look.
pub struct Ctx<'a> {
    /// the Applications folders an app may be moved from (`/Applications`, `~/Applications`)
    pub roots: &'a [PathBuf],
    /// Trove's own executable, to refuse the bundle holding it
    pub trove_exe: Option<&'a Path>,
    /// what counts as "part of macOS": `SYSTEM_ROOTS` live, a temp folder in tests
    pub system: &'a [PathBuf],
    pub probe: &'a dyn Probe,
}

/// How deep under a root a bundle may sit: `X.app` and `Utilities/X.app`, as `apps_mac` lists.
const MAX_DEPTH: usize = 2;

/// Where macOS keeps its own apps; a link resolving under one of these is "Part of macOS".
pub const SYSTEM_ROOTS: &[&str] = &["/System"];

/// `SYSTEM_ROOTS` as paths, for `Ctx::system` and `apps_mac`.
pub fn system_roots() -> Vec<PathBuf> {
    SYSTEM_ROOTS.iter().map(PathBuf::from).collect()
}

fn in_system(path: &Path, system: &[PathBuf]) -> bool {
    system.iter().any(|r| path.starts_with(r))
}

/// A link (the bundle or a folder on its way) is never moved: `System` when its target lies
/// under a system root, else `Link`.
fn link_reason(path: &Path, system: &[PathBuf]) -> Removable {
    match std::fs::canonicalize(path) {
        Ok(real) if in_system(&real, system) => Removable::System,
        _ => Removable::Link,
    }
}

fn is_app_name(path: &Path) -> bool {
    path.extension()
        .is_some_and(|x| x.eq_ignore_ascii_case("app"))
}

/// Whether `path` may go to the Trash, and if not, why. Never follows a link.
pub fn may_trash(path: &Path, ctx: &Ctx) -> Removable {
    // textual first: a system app is "Part of macOS" whatever else is true of it
    if in_system(path, ctx.system) {
        return Removable::System;
    }
    let Ok(meta) = path.symlink_metadata() else {
        return Removable::NotApp;
    };
    if meta.file_type().is_symlink() {
        return link_reason(path, ctx.system);
    }
    if !meta.is_dir() || !is_app_name(path) || !path.join("Contents").is_dir() {
        return Removable::NotApp;
    }
    // a folder on the way is a link: the path is not its own canonical form
    match std::fs::canonicalize(path) {
        Ok(real) if real == path => {}
        Ok(_) => return link_reason(path, ctx.system),
        Err(_) => return Removable::NotApp,
    }
    if ctx.probe.read_only(path) {
        return Removable::System;
    }
    if ctx.probe.network(path) {
        return Removable::Elsewhere;
    }
    let inside = ctx.roots.iter().any(|r| {
        path.strip_prefix(r)
            .is_ok_and(|rest| (1..=MAX_DEPTH).contains(&rest.components().count()))
    });
    if !inside {
        return Removable::Elsewhere;
    }
    if ctx.trove_exe.is_some_and(|exe| exe.starts_with(path)) {
        return Removable::Trove;
    }
    Removable::Yes
}

/// An opaque fingerprint of the bundle folder as it is now: device, inode and mtime on unix.
/// `''` when it cannot be read (the row is then not `Yes` anyway).
pub fn stamp(path: &Path) -> String {
    let Ok(meta) = path.symlink_metadata() else {
        return String::new();
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        stable_id(&[
            &meta.dev().to_string(),
            &meta.ino().to_string(),
            &meta.mtime().to_string(),
            &meta.mtime_nsec().to_string(),
        ])
    }
    #[cfg(not(unix))]
    {
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos().to_string())
            .unwrap_or_default();
        stable_id(&[&mtime])
    }
}

/// One row per bundle `apps_mac` listed. The id is a hash of the path; the path itself is sent
/// only as `program`/`folder`, for the confirm to show and the tile join — never acted on.
pub fn list(bundles: &[PathBuf], ctx: &Ctx) -> Vec<Uninstallable> {
    bundles
        .iter()
        .filter_map(|path| {
            let name = path.file_stem()?.to_string_lossy().into_owned();
            let shown = path.to_string_lossy().into_owned();
            let removable = may_trash(path, ctx);
            Some(Uninstallable {
                id: stable_id(&["macos", &shown]),
                name,
                version: String::new(),
                publisher: String::new(),
                folder: shown.clone(),
                removable,
                program: shown.clone(),
                stamp: stamp(path),
                path: String::new(),
                typed: false,
                command: (removable == Removable::Yes).then(|| Command {
                    program: shown,
                    params: String::new(),
                    dir: String::new(),
                }),
                deb: None,
            })
        })
        .collect()
}

/// Move the bundle of the fresh row `id` names to the Trash, once: only if `resolve` accepts
/// it (unchanged since the confirm, `Yes`) and nothing runs from inside it. Returns the bundle
/// path, for the caller to see whether it is gone.
pub fn trash_app(
    id: &str,
    seen: &Confirmed,
    fresh: &[Uninstallable],
    probe: &dyn Probe,
    l: &dyn Launcher,
) -> Result<PathBuf, Refusal> {
    let (row, command) = resolve(id, seen, fresh)?;
    let bundle = PathBuf::from(&command.program);
    if probe.running(&bundle) {
        return Err(Refusal::Running(row.name.clone()));
    }
    match l.trash(&bundle) {
        Ok(()) => Ok(bundle),
        Err(e) if no_recycle_bin(&e).is_some() => Err(Refusal::NoTrash),
        Err(e) => Err(Refusal::Trash(e.to_string())),
    }
}

/// The live checks. Read-only: `statfs` and the process table.
#[cfg(target_os = "macos")]
pub struct LiveProbe;

#[cfg(target_os = "macos")]
impl LiveProbe {
    fn statfs(path: &Path) -> Option<libc::statfs> {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
        // SAFETY: zeroed is a valid statfs; the path is NUL-terminated and outlives the call.
        let mut buf: libc::statfs = unsafe { std::mem::zeroed() };
        let rc = unsafe { libc::statfs(c.as_ptr(), &mut buf) };
        (rc == 0).then_some(buf)
    }
}

#[cfg(target_os = "macos")]
impl Probe for LiveProbe {
    fn read_only(&self, path: &Path) -> bool {
        // cannot tell → treat as read-only: refusing is the safe side
        Self::statfs(path).is_none_or(|s| s.f_flags & (libc::MNT_RDONLY as u32) != 0)
    }

    fn network(&self, path: &Path) -> bool {
        Self::statfs(path).is_none_or(|s| {
            // SAFETY: f_fstypename is a NUL-terminated C string inside the struct.
            let name = unsafe { std::ffi::CStr::from_ptr(s.f_fstypename.as_ptr()) };
            crate::core::mounts::is_network_fs(&name.to_string_lossy())
        })
    }

    fn running(&self, bundle: &Path) -> bool {
        any_running(bundle, gather())
    }
}

/// The pid list could not be read: nothing is known, so `any_running` says "running".
#[derive(Debug)]
pub struct ScanError;

/// What one process shows of where it runs from. A field it would not tell (another user's
/// process, one that just ended) is empty: absent, not a reason to refuse.
#[derive(Debug, Default)]
pub struct ProcInfo {
    /// `proc_pidpath`
    pub exe: Option<PathBuf>,
    /// `KERN_PROCARGS2`: the exec path, then argv[0..argc]
    pub argv: Vec<PathBuf>,
    /// `PROC_PIDVNODEPATHINFO` `pvi_cdir`
    pub cwd: Option<PathBuf>,
}

/// Whether `info` runs from inside `bundle`: its executable, any argv entry or its working
/// folder. `Path::starts_with` compares whole components, so `X.appfoo` is not inside `X.app`.
/// A relative argv entry is read against the process's working folder.
pub fn runs_from(bundle: &Path, info: &ProcInfo) -> bool {
    let inside = |p: &Path| p.starts_with(bundle);
    info.exe.as_deref().is_some_and(inside)
        || info.cwd.as_deref().is_some_and(inside)
        || info.argv.iter().any(|a| {
            if a.is_absolute() {
                inside(a)
            } else {
                info.cwd.as_deref().is_some_and(|cwd| inside(&cwd.join(a)))
            }
        })
}

/// Fail closed: a scan that failed counts as running.
pub fn any_running(bundle: &Path, scan: Result<Vec<ProcInfo>, ScanError>) -> bool {
    match scan {
        Ok(procs) => procs.iter().any(|p| runs_from(bundle, p)),
        Err(ScanError) => {
            log::warn!("uninstall: the process list could not be read; refusing as running");
            true
        }
    }
}

/// Every pid's `ProcInfo`. `Err` only when the pid list itself cannot be read.
#[cfg(target_os = "macos")]
fn gather() -> Result<Vec<ProcInfo>, ScanError> {
    // SAFETY: a null buffer asks only for the count.
    let n = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if n <= 0 {
        return Err(ScanError);
    }
    let mut pids: Vec<libc::c_int> = vec![0; n as usize + 64];
    let bytes = (pids.len() * std::mem::size_of::<libc::c_int>()) as libc::c_int;
    // SAFETY: the buffer holds `bytes` bytes.
    let got = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
    if got <= 0 {
        return Err(ScanError);
    }
    pids.truncate(got as usize);
    let argmax = arg_max();
    Ok(pids
        .into_iter()
        .filter(|&pid| pid > 0)
        .map(|pid| ProcInfo {
            exe: pid_path(pid),
            argv: pid_args(pid, argmax),
            cwd: pid_cwd(pid),
        })
        .collect())
}

#[cfg(target_os = "macos")]
fn os_path(bytes: &[u8]) -> PathBuf {
    use std::os::unix::ffi::OsStrExt;
    PathBuf::from(std::ffi::OsStr::from_bytes(bytes))
}

#[cfg(target_os = "macos")]
fn pid_path(pid: libc::c_int) -> Option<PathBuf> {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: the buffer holds PROC_PIDPATHINFO_MAXSIZE bytes.
    let len = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    (len > 0).then(|| os_path(&buf[..len as usize]))
}

#[cfg(target_os = "macos")]
fn pid_cwd(pid: libc::c_int) -> Option<PathBuf> {
    // SAFETY: zeroed is a valid proc_vnodepathinfo; the size passed is its own.
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    let got = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            (&mut info as *mut libc::proc_vnodepathinfo).cast(),
            size,
        )
    };
    if got != size {
        return None;
    }
    // SAFETY: vip_path is MAXPATHLEN bytes of C chars (libc declares it as 32x32).
    let raw: &[u8] = unsafe {
        std::slice::from_raw_parts(
            info.pvi_cdir.vip_path.as_ptr().cast::<u8>(),
            std::mem::size_of_val(&info.pvi_cdir.vip_path),
        )
    };
    let end = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
    (end > 0).then(|| os_path(&raw[..end]))
}

/// `kern.argmax`, the most `KERN_PROCARGS2` can return; 1 MiB when it cannot be read.
#[cfg(target_os = "macos")]
fn arg_max() -> usize {
    let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
    let mut value: libc::c_int = 0;
    let mut len = std::mem::size_of::<libc::c_int>();
    // SAFETY: `value` is an int and `len` its size.
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            2,
            (&mut value as *mut libc::c_int).cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc == 0 && value > 0 {
        value as usize
    } else {
        1 << 20
    }
}

/// The exec path and argv of `pid`; empty when it will not say (`EPERM` on another user's
/// process).
#[cfg(target_os = "macos")]
fn pid_args(pid: libc::c_int, argmax: usize) -> Vec<PathBuf> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut buf = vec![0u8; argmax];
    let mut len = buf.len();
    // SAFETY: the buffer holds `len` bytes; sysctl writes at most that and updates `len`.
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buf.as_mut_ptr().cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        return Vec::new();
    }
    parse_procargs2(&buf[..len.min(buf.len())])
        .into_iter()
        .map(|b| os_path(&b))
        .collect()
}

/// `KERN_PROCARGS2` layout: `int argc`, the exec path NUL-terminated, NUL padding, then `argc`
/// NUL-terminated strings (the environment follows and is not read). Returns the exec path and
/// argv; a short or garbled buffer gives what could be read.
pub fn parse_procargs2(buf: &[u8]) -> Vec<Vec<u8>> {
    let Some(head) = buf.get(..4) else {
        return Vec::new();
    };
    let argc = i32::from_ne_bytes([head[0], head[1], head[2], head[3]]).max(0) as usize;
    let mut rest = &buf[4..];
    let mut out = Vec::new();
    // the exec path
    let end = rest.iter().position(|&b| b == 0).unwrap_or(rest.len());
    if end > 0 {
        out.push(rest[..end].to_vec());
    }
    rest = &rest[end..];
    // skip the padding
    let start = rest.iter().position(|&b| b != 0).unwrap_or(rest.len());
    rest = &rest[start..];
    for _ in 0..argc {
        if rest.is_empty() {
            break;
        }
        let end = rest.iter().position(|&b| b == 0).unwrap_or(rest.len());
        out.push(rest[..end].to_vec());
        rest = rest.get(end + 1..).unwrap_or(&[]);
    }
    out
}

/// The live list: every bundle `apps_mac` lists, checked against `/Applications` and
/// `~/Applications`. Read-only.
#[cfg(target_os = "macos")]
pub fn live_list() -> Result<Vec<Uninstallable>, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let bundles: Vec<PathBuf> =
        crate::core::apps_mac::mac_apps(&crate::core::apps_mac::mac_roots(home.as_deref()))
            .into_iter()
            .map(|a| PathBuf::from(a.path))
            .collect();
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = &home {
        roots.push(home.join("Applications"));
    }
    let exe = std::env::current_exe().ok();
    let system = system_roots();
    let ctx = Ctx {
        roots: &roots,
        trove_exe: exe.as_deref(),
        system: &system,
        probe: &LiveProbe,
    };
    Ok(list(&bundles, &ctx))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::trash_mac::{trash_with, Ledger, Method};
    use crate::core::uninstall::{Recorder, Waited};
    use std::cell::RefCell;

    /// A temp dir, canonical (on macOS `/var` is a link to `/private/var`), removed on drop.
    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn scratch(tag: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!("trove-18b-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Applications")).unwrap();
        Scratch(std::fs::canonicalize(&dir).unwrap())
    }

    /// A fake `X.app`: `Contents/Info.plist` and an empty `Contents/MacOS/X`. Never a real app.
    fn fake_app(at: &Path) -> PathBuf {
        let macos = at.join("Contents/MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        std::fs::write(at.join("Contents/Info.plist"), "<plist/>").unwrap();
        std::fs::write(macos.join(at.file_stem().unwrap()), "").unwrap();
        at.to_path_buf()
    }

    #[derive(Default)]
    struct FakeProbe {
        read_only: bool,
        network: bool,
        running: bool,
    }
    impl Probe for FakeProbe {
        fn read_only(&self, _: &Path) -> bool {
            self.read_only
        }
        fn network(&self, _: &Path) -> bool {
            self.network
        }
        fn running(&self, _: &Path) -> bool {
            self.running
        }
    }

    fn check(path: &Path, root: &Path, probe: &FakeProbe) -> Removable {
        let roots = [root.join("Applications")];
        may_trash(
            path,
            &Ctx {
                roots: &roots,
                trove_exe: None,
                system: &system_roots(),
                probe,
            },
        )
    }

    fn rows(paths: &[PathBuf], root: &Path, probe: &FakeProbe) -> Vec<Uninstallable> {
        let roots = [root.join("Applications")];
        list(
            paths,
            &Ctx {
                roots: &roots,
                trove_exe: None,
                system: &system_roots(),
                probe,
            },
        )
    }

    fn seen(r: &Uninstallable) -> Confirmed<'_> {
        Confirmed {
            name: &r.name,
            version: &r.version,
            program: &r.program,
            stamp: &r.stamp,
        }
    }

    #[test]
    fn a_user_app_passes_and_goes_through_the_launcher_once() {
        let s = scratch("ok");
        let app = fake_app(&s.0.join("Applications/TroveTestApp.app"));
        let probe = FakeProbe::default();
        let fresh = rows(std::slice::from_ref(&app), &s.0, &probe);
        assert_eq!(fresh[0].removable, Removable::Yes);
        assert_eq!(fresh[0].name, "TroveTestApp");
        assert!(!fresh[0].id.contains("TroveTestApp"), "the id is opaque");
        let rec = Recorder::new(Waited::Exited);
        let moved = trash_app(&fresh[0].id, &seen(&fresh[0]), &fresh, &probe, &rec).unwrap();
        assert_eq!(moved, app);
        assert_eq!(
            *rec.calls.borrow(),
            vec![format!("trash {}", app.display())]
        );
        // in Utilities too
        let util = fake_app(&s.0.join("Applications/Utilities/Tool.app"));
        assert_eq!(check(&util, &s.0, &probe), Removable::Yes);
    }

    #[test]
    fn system_app_refused() {
        let probe = FakeProbe::default();
        let p = Path::new("/System/Applications/Calculator.app");
        assert_eq!(check(p, Path::new("/"), &probe), Removable::System);
        assert!(!Refusal::Not(Removable::System).sentence().is_empty());
    }

    #[test]
    fn read_only_volume_is_system() {
        let s = scratch("ro");
        let app = fake_app(&s.0.join("Applications/Safari.app"));
        let probe = FakeProbe {
            read_only: true,
            ..FakeProbe::default()
        };
        assert_eq!(check(&app, &s.0, &probe), Removable::System);
    }

    #[test]
    fn network_volume_refused() {
        let s = scratch("net");
        let app = fake_app(&s.0.join("Applications/Remote.app"));
        let probe = FakeProbe {
            network: true,
            ..FakeProbe::default()
        };
        assert_eq!(check(&app, &s.0, &probe), Removable::Elsewhere);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_bundle_refused() {
        let s = scratch("link");
        let real = fake_app(&s.0.join("elsewhere/Real.app"));
        let link = s.0.join("Applications/Real.app");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let probe = FakeProbe::default();
        assert_eq!(check(&link, &s.0, &probe), Removable::Link);
        // listed anyway (by hand): no command, so nothing can be moved
        let fresh = rows(std::slice::from_ref(&link), &s.0, &probe);
        assert!(fresh[0].command.is_none());
        let rec = Recorder::new(Waited::Exited);
        assert_eq!(
            trash_app(&fresh[0].id, &seen(&fresh[0]), &fresh, &probe, &rec).err(),
            Some(Refusal::Not(Removable::Link))
        );
        assert!(rec.calls.borrow().is_empty());
        assert!(real.exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_out_of_applications_refused() {
        // a folder on the way is a link: Applications/Linked -> elsewhere
        let s = scratch("dirlink");
        std::fs::create_dir_all(s.0.join("elsewhere")).unwrap();
        fake_app(&s.0.join("elsewhere/App.app"));
        std::os::unix::fs::symlink(s.0.join("elsewhere"), s.0.join("Applications/Linked")).unwrap();
        let probe = FakeProbe::default();
        assert_eq!(
            check(&s.0.join("Applications/Linked/App.app"), &s.0, &probe),
            Removable::Link
        );
    }

    /// Safari's shape: a link whose target lies under a system root is `System` ("Part of
    /// macOS"), never `Yes`, and nothing goes to the Trash. A stand-in temp folder plays `/System`.
    #[cfg(unix)]
    #[test]
    fn link_into_the_system_root_is_system_and_never_moved() {
        let s = scratch("syslink");
        let real = fake_app(&s.0.join("System/Cryptexes/App/System/Applications/Safari.app"));
        let link = s.0.join("Applications/Safari.app");
        std::os::unix::fs::symlink(
            "../System/Cryptexes/App/System/Applications/Safari.app",
            &link,
        )
        .unwrap();
        let roots = [s.0.join("Applications")];
        let system = [s.0.join("System")];
        let probe = FakeProbe::default();
        let ctx = Ctx {
            roots: &roots,
            trove_exe: None,
            system: &system,
            probe: &probe,
        };
        assert_eq!(may_trash(&link, &ctx), Removable::System);
        let fresh = list(std::slice::from_ref(&link), &ctx);
        assert_eq!(fresh[0].removable, Removable::System);
        assert!(fresh[0].command.is_none());
        let rec = Recorder::new(Waited::Exited);
        assert_eq!(
            trash_app(&fresh[0].id, &seen(&fresh[0]), &fresh, &probe, &rec).err(),
            Some(Refusal::Not(Removable::System))
        );
        assert!(rec.calls.borrow().is_empty());
        assert!(real.exists());
        // the same link with no system root is a plain `Link`
        let plain = Ctx { system: &[], ..ctx };
        assert_eq!(may_trash(&link, &plain), Removable::Link);
    }

    fn proc(exe: Option<&str>, argv: &[&str], cwd: Option<&str>) -> ProcInfo {
        ProcInfo {
            exe: exe.map(PathBuf::from),
            argv: argv.iter().map(PathBuf::from).collect(),
            cwd: cwd.map(PathBuf::from),
        }
    }

    #[test]
    fn running_is_exe_or_argv_or_cwd_inside_the_bundle() {
        let x = Path::new("/Applications/X.app");
        // the executable inside
        assert!(runs_from(
            x,
            &proc(Some("/Applications/X.app/Contents/MacOS/X"), &[], None)
        ));
        // a script launcher: /bin/sh runs a script inside the bundle
        assert!(runs_from(
            x,
            &proc(
                Some("/bin/sh"),
                &["/bin/sh", "sh", "/Applications/X.app/Contents/MacOS/run"],
                Some("/")
            )
        ));
        // a relative argv entry read against the working folder
        assert!(runs_from(
            x,
            &proc(
                Some("/bin/sh"),
                &["/bin/sh", "sh", "X.app/Contents/MacOS/run"],
                Some("/Applications")
            )
        ));
        // working folder inside
        assert!(runs_from(
            x,
            &proc(
                Some("/bin/zsh"),
                &["-zsh"],
                Some("/Applications/X.app/Contents")
            )
        ));
        // the bundle folder itself
        assert!(runs_from(x, &proc(None, &[], Some("/Applications/X.app"))));
        // a sibling whose name only starts the same: not inside
        let sibling = proc(
            Some("/Applications/X.appfoo/Contents/MacOS/X"),
            &["/Applications/X.appfoo/run", "X.appfoo"],
            Some("/Applications/X.appfoo"),
        );
        assert!(!runs_from(x, &sibling));
        // nothing readable (another user's process): not running
        assert!(!runs_from(x, &ProcInfo::default()));
        assert!(!any_running(x, Ok(vec![sibling, ProcInfo::default()])));
    }

    #[test]
    fn a_failed_scan_counts_as_running_and_is_refused() {
        let x = Path::new("/Applications/X.app");
        assert!(any_running(x, Err(ScanError)));
        assert!(any_running(
            x,
            Ok(vec![proc(
                Some("/Applications/X.app/Contents/MacOS/X"),
                &[],
                None
            )])
        ));
        // the refusal the person sees is the "Quit … first." one
        struct Failing;
        impl Probe for Failing {
            fn read_only(&self, _: &Path) -> bool {
                false
            }
            fn network(&self, _: &Path) -> bool {
                false
            }
            fn running(&self, bundle: &Path) -> bool {
                any_running(bundle, Err(ScanError))
            }
        }
        let s = scratch("scanerr");
        let app = fake_app(&s.0.join("Applications/TroveTestApp.app"));
        let fresh = rows(&[app], &s.0, &FakeProbe::default());
        let rec = Recorder::new(Waited::Exited);
        let r = trash_app(&fresh[0].id, &seen(&fresh[0]), &fresh, &Failing, &rec).unwrap_err();
        assert_eq!(r.sentence(), "Quit TroveTestApp first.");
        assert!(rec.calls.borrow().is_empty());
    }

    #[test]
    fn procargs2_is_parsed() {
        let mut buf = 2i32.to_ne_bytes().to_vec();
        buf.extend_from_slice(b"/bin/sh\0\0\0\0sh\0/A/X.app/run\0PATH=/usr/bin\0");
        let got = parse_procargs2(&buf);
        assert_eq!(
            got,
            [
                b"/bin/sh".to_vec(),
                b"sh".to_vec(),
                b"/A/X.app/run".to_vec()
            ]
        );
        // short or garbled buffers give what can be read, never panic
        assert!(parse_procargs2(&[1, 0]).is_empty());
        let mut cut = 5i32.to_ne_bytes().to_vec();
        cut.extend_from_slice(b"/bin/sh\0\0sh");
        assert_eq!(parse_procargs2(&cut), [b"/bin/sh".to_vec(), b"sh".to_vec()]);
    }

    #[test]
    fn outside_applications_refused() {
        let s = scratch("out");
        let probe = FakeProbe::default();
        let app = fake_app(&s.0.join("Downloads/Thing.app"));
        assert_eq!(check(&app, &s.0, &probe), Removable::Elsewhere);
        // too deep
        let deep = fake_app(&s.0.join("Applications/a/b/Deep.app"));
        assert_eq!(check(&deep, &s.0, &probe), Removable::Elsewhere);
    }

    #[test]
    fn non_app_refused() {
        let s = scratch("notapp");
        let probe = FakeProbe::default();
        // a folder not named .app
        let dir = s.0.join("Applications/Folder");
        std::fs::create_dir_all(dir.join("Contents")).unwrap();
        assert_eq!(check(&dir, &s.0, &probe), Removable::NotApp);
        // a file named .app
        let file = s.0.join("Applications/File.app");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(check(&file, &s.0, &probe), Removable::NotApp);
        // a .app folder with no Contents
        let empty = s.0.join("Applications/Empty.app");
        std::fs::create_dir_all(&empty).unwrap();
        assert_eq!(check(&empty, &s.0, &probe), Removable::NotApp);
        // gone
        assert_eq!(
            check(&s.0.join("Applications/Gone.app"), &s.0, &probe),
            Removable::NotApp
        );
    }

    #[test]
    fn trove_refused() {
        let s = scratch("trove");
        let app = fake_app(&s.0.join("Applications/Trove.app"));
        let exe = app.join("Contents/MacOS/Trove");
        let roots = [s.0.join("Applications")];
        let probe = FakeProbe::default();
        let ctx = Ctx {
            roots: &roots,
            trove_exe: Some(&exe),
            system: &system_roots(),
            probe: &probe,
        };
        assert_eq!(may_trash(&app, &ctx), Removable::Trove);
    }

    #[test]
    fn running_app_refused() {
        let s = scratch("run");
        let app = fake_app(&s.0.join("Applications/TroveTestApp.app"));
        let fresh = rows(&[app], &s.0, &FakeProbe::default());
        let running = FakeProbe {
            running: true,
            ..FakeProbe::default()
        };
        let rec = Recorder::new(Waited::Exited);
        let r = trash_app(&fresh[0].id, &seen(&fresh[0]), &fresh, &running, &rec).unwrap_err();
        assert_eq!(r, Refusal::Running("TroveTestApp".into()));
        assert_eq!(r.sentence(), "Quit TroveTestApp first.");
        assert!(rec.calls.borrow().is_empty());
    }

    #[test]
    fn changed_entry_refused() {
        let s = scratch("changed");
        let app = fake_app(&s.0.join("Applications/Swap.app"));
        let probe = FakeProbe::default();
        let listed = rows(std::slice::from_ref(&app), &s.0, &probe);
        let shown = seen(&listed[0]);
        // another app moved in at the same path (the old one kept, so its inode is not reused)
        std::fs::rename(&app, s.0.join("old.app")).unwrap();
        fake_app(&app);
        let fresh = rows(std::slice::from_ref(&app), &s.0, &probe);
        assert_eq!(fresh[0].id, listed[0].id, "same path, same id");
        let rec = Recorder::new(Waited::Exited);
        assert_eq!(
            trash_app(&fresh[0].id, &shown, &fresh, &probe, &rec).err(),
            Some(Refusal::Changed)
        );
        // an id the fresh list does not hold
        assert_eq!(
            trash_app("0000000000000000", &shown, &fresh, &probe, &rec).err(),
            Some(Refusal::UnknownId)
        );
        assert!(rec.calls.borrow().is_empty());
    }

    /// A launcher whose `trash` runs the real `trash_with` order over a fake method runner. The live
    /// launcher's own route (`ops::trash` → `trash_with`, Finder first) is tested in `trash_mac`.
    struct FakeTrash {
        answers: RefCell<Vec<Result<(), trash::Error>>>,
        calls: RefCell<Vec<Method>>,
    }
    impl Launcher for FakeTrash {
        fn launch(&self, _: &Command) -> Result<Box<dyn crate::core::uninstall::Running>, String> {
            panic!("a Mac app is never launched to uninstall it")
        }
        fn open_apps_settings(&self) -> Result<(), String> {
            panic!("no Settings on a Mac")
        }
        fn apt_check(&self, _: &str) -> Result<(), String> {
            panic!("no apt on a Mac")
        }
        fn trash(&self, bundle: &Path) -> std::io::Result<()> {
            let ledger = std::sync::Mutex::new(Ledger::new());
            trash_with(&[bundle.to_path_buf()], &ledger, |m, _| {
                self.calls.borrow_mut().push(m);
                self.answers.borrow_mut().remove(0).map(|()| vec![])
            })
        }
    }

    fn denied() -> trash::Error {
        trash::Error::Os {
            code: 1,
            description: "execution error: Not authorized to send Apple events to Finder. (-1743)"
                .into(),
        }
    }

    #[test]
    fn finder_auth_error_falls_back_to_the_file_manager() {
        let s = scratch("fallback");
        let app = fake_app(&s.0.join("Applications/A.app"));
        let probe = FakeProbe::default();
        let fresh = rows(&[app], &s.0, &probe);
        let l = FakeTrash {
            answers: RefCell::new(vec![Err(denied()), Ok(())]),
            calls: RefCell::default(),
        };
        assert!(trash_app(&fresh[0].id, &seen(&fresh[0]), &fresh, &probe, &l).is_ok());
        assert_eq!(*l.calls.borrow(), [Method::Finder, Method::FileManager]);
    }

    #[test]
    fn both_failing_is_no_trash_and_nothing_is_deleted() {
        let s = scratch("notrash");
        let app = fake_app(&s.0.join("Applications/A.app"));
        let probe = FakeProbe::default();
        let fresh = rows(std::slice::from_ref(&app), &s.0, &probe);
        let l = FakeTrash {
            answers: RefCell::new(vec![
                Err(denied()),
                Err(trash::Error::Unknown {
                    description: "trashItemAtURL failed".into(),
                }),
            ]),
            calls: RefCell::default(),
        };
        let r = trash_app(&fresh[0].id, &seen(&fresh[0]), &fresh, &probe, &l).unwrap_err();
        assert_eq!(r, Refusal::NoTrash);
        assert!(r.sentence().contains("Drag the app to the Trash in Finder"));
        assert!(app.exists(), "never a permanent delete");
        // any other Finder failure is its plain sentence, not retried
        let l = FakeTrash {
            answers: RefCell::new(vec![Err(trash::Error::Unknown {
                description: "Finder got an error: busy".into(),
            })]),
            calls: RefCell::default(),
        };
        let r = trash_app(&fresh[0].id, &seen(&fresh[0]), &fresh, &probe, &l).unwrap_err();
        assert!(matches!(r, Refusal::Trash(ref why) if why.contains("Finder got an error")));
        assert_eq!(*l.calls.borrow(), [Method::Finder]);
    }

    /// Lists the real Applications folders; moves nothing.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn live_list_has_rows() {
        let rows = live_list().unwrap();
        assert!(!rows.is_empty());
        assert!(rows
            .iter()
            .filter(|r| r.program.starts_with("/System/"))
            .all(|r| r.removable == Removable::System && r.command.is_none()));
        // Safari, listed through its link into /System, is "Part of macOS", never movable
        if let Some(safari) = rows
            .iter()
            .find(|r| r.program == "/Applications/Safari.app")
        {
            assert_eq!(safari.removable, Removable::System);
            assert!(safari.command.is_none());
        }
    }

    /// Live: a `/bin/sh` running a script inside a fake `Fake.app` in a temp dir is seen as
    /// running (argv), and is not once killed. Nothing is moved. Run by hand with `--ignored`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn live_probe_sees_a_script_launcher() {
        let s = scratch("live-run");
        let app = fake_app(&s.0.join("Applications/Fake.app"));
        let script = app.join("Contents/MacOS/Fake");
        // a loop, so sh never execs itself away into `sleep`
        std::fs::write(&script, "while :; do sleep 1; done\n").unwrap();
        let mut child = std::process::Command::new("/bin/sh")
            .arg(&script)
            .current_dir(&s.0)
            .spawn()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let seen = LiveProbe.running(&app);
        let sibling = s.0.join("Applications/Fake.appfoo");
        let not_sibling = !LiveProbe.running(&sibling);
        let _ = child.kill();
        let _ = child.wait();
        assert!(seen, "LiveProbe did not see /bin/sh {}", script.display());
        assert!(not_sibling, "a sibling bundle path matched");
        // a leftover `sleep 1` runs /bin/sleep with its cwd outside the bundle: not "running"
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(!LiveProbe.running(&app), "still running after the kill");
    }
}
