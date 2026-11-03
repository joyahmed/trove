//! Filling a `Table` by walking the disk (plan 21C.1b): a bounded pool of low-priority threads,
//! one folder at a time each, the skip list applied.
//!
//! ⛔ A junction or symlink is recorded as a name but never entered: `C:\Users\alex\Application
//! Data` loops back into `AppData`, and a link to another drive would pull that whole drive in.
//! `DirEntry::file_type` answers from the directory listing itself (no extra open), and std
//! counts every name-surrogate reparse point — junctions included — as a symlink.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex};

use super::table::{Table, TOP};

/// What the index never goes into (plan 21C "Privacy" defaults).
pub struct Skip {
    /// Lowercased folder names skipped wherever they are.
    names: Vec<String>,
    /// Lowercased (parent folder name, folder name) pairs: `.cargo\registry`.
    nested: Vec<(String, String)>,
    /// Lowercased (folder name, file beside it): `target` only in a Rust project, so a folder
    /// called `target` anywhere else is still indexed.
    beside: Vec<(String, String)>,
    /// Whole folders skipped, compared case-folded on Windows.
    paths: Vec<PathBuf>,
    /// Lowercased extensions of folders skipped wherever they are: on a Mac the media library
    /// packages (`Music Library.musiclibrary`), whose reading raises the Apple Music / Photos
    /// prompt (`props::LIBRARY_EXTS`).
    exts: Vec<String>,
}

impl Skip {
    pub fn new(names: &[&str], paths: Vec<PathBuf>) -> Self {
        Skip {
            names: names.iter().map(|n| n.to_lowercase()).collect(),
            nested: Vec::new(),
            beside: Vec::new(),
            paths,
            exts: Vec::new(),
        }
    }

    /// Privacy: `$Recycle.Bin`, `System Volume Information`, `%TEMP%`. Size (plan 21C, measured
    /// 2026-10-20: 274 MB for 2.2 M rows against a 150 MB budget, half of G: build output):
    /// `node_modules`, `.git`, `.pnpm-store`, `.rustup`, `__pycache__`, `.next`, `.turbo`,
    /// `.gradle`, `.cargo\registry`, and `target` beside a `Cargo.toml`. ⛔ Not `dist` or
    /// `build`: plenty of real folders have those names. Settings lists the same
    /// (`indexBuiltInSkips` in `src/lib/data/settings-sections.ts`): keep the two in step.
    pub fn defaults() -> Self {
        let mut skip = Skip::new(
            &[
                "$recycle.bin",
                "system volume information",
                "node_modules",
                ".git",
                ".pnpm-store",
                ".rustup",
                "__pycache__",
                ".next",
                ".turbo",
                ".gradle",
            ],
            vec![std::env::temp_dir()],
        );
        skip.nested.push((".cargo".into(), "registry".into()));
        skip.beside.push(("target".into(), "cargo.toml".into()));
        #[cfg(target_os = "macos")]
        {
            if let Some(home) = crate::core::shell::user_profile() {
                skip.paths.extend(mac_skips(&home));
            }
            skip.exts = mac_library_exts();
        }
        #[cfg(target_os = "linux")]
        {
            let mounts = std::fs::read_to_string("/proc/self/mounts").unwrap_or_default();
            let home = crate::core::shell::user_profile();
            skip.paths.extend(linux_skips(home.as_deref(), &mounts));
        }
        skip
    }

    /// The same list, plus one whole folder: a drive's walk leaves out the home folder, which
    /// has an index of its own (plan 21C.2a).
    pub fn and_folder(mut self, path: PathBuf) -> Self {
        self.paths.push(path);
        self
    }

    fn folder(&self, path: &Path) -> bool {
        self.paths.iter().any(|p| same_path(p, path))
    }

    /// Whether the folder `name` inside `parent` is skipped: by its name, its name under its
    /// parent's (`.cargo\registry`), a file beside it (`target` + `Cargo.toml`), or its path.
    pub(super) fn dir(&self, parent: &Path, name: &str) -> bool {
        let lower = name.to_lowercase();
        if self.names.contains(&lower) {
            return true;
        }
        if !self.exts.is_empty()
            && lower
                .rsplit_once('.')
                .is_some_and(|(_, ext)| self.exts.iter().any(|e| e == ext))
        {
            return true;
        }
        if !self.nested.is_empty() {
            let up = parent
                .file_name()
                .map(|n| n.to_string_lossy().to_lowercase());
            if self
                .nested
                .iter()
                .any(|(p, n)| *n == lower && up.as_deref() == Some(p.as_str()))
            {
                return true;
            }
        }
        // a look at the disk, only for a folder with that name
        if self
            .beside
            .iter()
            .any(|(n, file)| *n == lower && has_file(parent, file))
        {
            return true;
        }
        self.folder(&parent.join(name))
    }

    /// Whether a path below `root` falls in a skipped folder (what the watcher asks).
    pub fn covers(&self, root: &Path, path: &Path) -> bool {
        let Ok(rest) = path.strip_prefix(root) else {
            return true;
        };
        let mut at = root.to_path_buf();
        for part in rest.components() {
            if self.dir(&at, &part.as_os_str().to_string_lossy()) {
                return true;
            }
            at.push(part);
        }
        false
    }
}

/// Mac only: the Trash and the junk under `~/Library`, measured 2026-10-23 on a 1.5 M row home
/// (plan 21C.9a): `Developer` 500 k rows, `pnpm` 212 k, `Caches` 108 k, `Android` 37 k,
/// `Containers` 23 k. ⛔ Never all of `~/Library`: iCloud Drive (`Mobile Documents`) and the
/// cloud providers (`CloudStorage`) live in it and stay indexed.
#[cfg(any(target_os = "macos", test))]
pub fn mac_skips(home: &Path) -> Vec<PathBuf> {
    let library = home.join("Library");
    let mut paths: Vec<PathBuf> = ["Caches", "Developer", "pnpm", "Containers", "Android"]
        .iter()
        .map(|d| library.join(d))
        .collect();
    paths.push(home.join(".Trash"));
    paths
}

/// Mac only: the media library packages the walk never enters (`Skip::exts`).
#[cfg(any(target_os = "macos", test))]
pub fn mac_library_exts() -> Vec<String> {
    crate::core::props::LIBRARY_EXTS
        .iter()
        .map(|e| e.to_string())
        .collect()
}

/// File systems on a local disk: a mount of one of these is walked like the rest of the disk.
#[cfg(target_os = "linux")]
const LOCAL_DISK: &[&str] = &[
    "ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "zfs", "jfs", "reiserfs", "bcachefs", "vfat",
    "exfat", "ntfs3",
];

/// What the index never goes into on Linux (plan 21C.9), on top of [`Skip::defaults`]: the
/// kernel's own trees (`/proc`, `/sys`, `/dev`, `/run`), what plugs in (`/media`), every mount
/// that is not a local disk (`mounts` is `/proc/self/mounts`: network shares, snaps, tmpfs,
/// FUSE, WSL's `/mnt/c`), and in the home folder the cache and the bin. A walk of `/` that went
/// into `/proc` would never end, and one into a share is minutes of network traffic.
#[cfg(target_os = "linux")]
pub fn linux_skips(home: Option<&Path>, mounts: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = ["/proc", "/sys", "/dev", "/run", "/media"]
        .iter()
        .map(PathBuf::from)
        .collect();
    if let Some(home) = home {
        out.push(home.join(".cache"));
        // "Trash" on its own: the bin-word check (ops.rs) flags it inside a longer literal
        out.push(home.join(".local/share").join("Trash"));
    }
    for m in crate::core::mounts::parse_proc_mounts(mounts) {
        let at = PathBuf::from(m.point);
        if !LOCAL_DISK.contains(&m.fstype.as_str()) && at != Path::new("/") && !out.contains(&at) {
            out.push(at);
        }
    }
    out
}

/// Whether `dir` holds a file named `file` (given lowercase): as is (Windows and a Mac ignore
/// case), or with its first letter capital (`Cargo.toml` on a case-sensitive disk).
fn has_file(dir: &Path, file: &str) -> bool {
    if dir.join(file).is_file() {
        return true;
    }
    let mut cased = file.to_string();
    if let Some(first) = cased.get_mut(..1) {
        first.make_ascii_uppercase();
    }
    cased != file && dir.join(cased).is_file()
}

fn same_path(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        let fold = |p: &Path| p.to_string_lossy().trim_end_matches('\\').to_lowercase();
        fold(a) == fold(b)
    } else {
        a == b
    }
}

/// Run the calling thread in the background: below-normal CPU and low disk priority, so a walk
/// never slows a listing the person is waiting on.
pub fn lower_priority() {
    #[cfg(windows)]
    // SAFETY: a pseudo-handle for this thread; the call only changes its own scheduling.
    unsafe {
        use windows_sys::Win32::System::Threading::{
            GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN,
        };
        SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN);
    }
}

/// Every entry's 128-bit NTFS file id in `dir`, by name, from one directory enumeration
/// (`FileIdExtdDirectoryInfo`): far cheaper than opening each file. Empty if it cannot be read.
#[cfg(windows)]
fn dir_ids(dir: &Path) -> std::collections::HashMap<String, u128> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FileIdExtdDirectoryInfo, FileIdExtdDirectoryRestartInfo,
        GetFileInformationByHandleEx, FILE_FLAG_BACKUP_SEMANTICS, FILE_ID_EXTD_DIR_INFO,
        FILE_LIST_DIRECTORY, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    let mut out = std::collections::HashMap::new();
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: `wide` is NUL-terminated and outlives the call; no security attributes/template.
    let h = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_LIST_DIRECTORY,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if h == INVALID_HANDLE_VALUE {
        return out;
    }
    // u64 words keep the buffer 8-aligned, as the records need
    let mut buf = vec![0u64; 32 * 1024 / 8];
    let mut class = FileIdExtdDirectoryRestartInfo;
    loop {
        // SAFETY: `buf` is live and its byte length is passed.
        let ok = unsafe {
            GetFileInformationByHandleEx(h, class, buf.as_mut_ptr().cast(), (buf.len() * 8) as u32)
        };
        if ok == 0 {
            break; // ERROR_NO_MORE_FILES at the end, or any failure: keep what we have
        }
        class = FileIdExtdDirectoryInfo;
        let base = buf.as_ptr().cast::<u8>();
        let mut off = 0usize;
        loop {
            // SAFETY: the kernel filled records at 8-aligned offsets inside `buf`; the name is
            // `FileNameLength` bytes starting at the `FileName` field.
            unsafe {
                let rec = base.add(off).cast::<FILE_ID_EXTD_DIR_INFO>();
                let name_ptr = std::ptr::addr_of!((*rec).FileName).cast::<u16>();
                let n = ((*rec).FileNameLength / 2) as usize;
                let name = std::ffi::OsString::from_wide(std::slice::from_raw_parts(name_ptr, n));
                let id = u128::from_le_bytes((*rec).FileId.Identifier);
                out.insert(name.to_string_lossy().into_owned(), id);
                let next = (*rec).NextEntryOffset as usize;
                if next == 0 {
                    break;
                }
                off += next;
            }
        }
    }
    // SAFETY: `h` is the handle opened above.
    unsafe { CloseHandle(h) };
    out
}

/// One folder's entries: (name, is a folder to go into, file id or 0).
fn list(dir: &Path, skip: &Skip) -> Vec<(String, bool, u128)> {
    #[cfg(windows)]
    let ids = dir_ids(dir);
    let Ok(read) = std::fs::read_dir(dir) else {
        // a folder the person cannot open: they could not open its files either
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in read.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = kind.is_dir() && !kind.is_symlink();
        if is_dir && skip.dir(dir, &name) {
            continue;
        }
        #[cfg(windows)]
        let id = ids.get(&name).copied().unwrap_or(0);
        #[cfg(not(windows))]
        let id = 0;
        out.push((name, is_dir, id));
    }
    out
}

struct Work {
    table: Table,
    queue: Vec<(PathBuf, u32)>,
    busy: usize,
}

/// Walk `root` on `threads` threads into a new table. `cancel` stops it early (the table then
/// holds what was read so far).
#[cfg(test)]
pub fn walk(root: &Path, skip: &Skip, threads: usize, cancel: &AtomicBool) -> Table {
    walk_counting(root, skip, threads, cancel, &AtomicUsize::new(0))
}

/// `walk`, adding each name read to `seen` as it goes: the palette footer's "indexing D: —
/// 412,000 so far" (plan 21C.2a).
pub fn walk_counting(
    root: &Path,
    skip: &Skip,
    threads: usize,
    cancel: &AtomicBool,
    seen: &AtomicUsize,
) -> Table {
    let work = Mutex::new(Work {
        table: Table::new(root),
        queue: vec![(root.to_path_buf(), TOP)],
        busy: 0,
    });
    let wake = Condvar::new();
    std::thread::scope(|s| {
        for _ in 0..threads.max(1) {
            s.spawn(|| {
                lower_priority();
                worker(&work, &wake, skip, cancel, seen);
            });
        }
    });
    let mut table = work.into_inner().unwrap_or_else(|e| e.into_inner()).table;
    table.shrink_to_fit();
    table
}

fn worker(
    work: &Mutex<Work>,
    wake: &Condvar,
    skip: &Skip,
    cancel: &AtomicBool,
    seen: &AtomicUsize,
) {
    loop {
        let (dir, row) = {
            let mut w = work.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                if cancel.load(Ordering::Relaxed) {
                    wake.notify_all();
                    return;
                }
                if let Some(job) = w.queue.pop() {
                    w.busy += 1;
                    break job;
                }
                if w.busy == 0 {
                    wake.notify_all();
                    return;
                }
                w = wake.wait(w).unwrap_or_else(|e| e.into_inner());
            }
        };
        // read with no lock held: this is the slow part
        let entries = list(&dir, skip);
        seen.fetch_add(entries.len(), Ordering::Relaxed);
        let mut w = work.lock().unwrap_or_else(|e| e.into_inner());
        for (name, is_dir, id) in entries {
            if let Some(child) = w.table.insert(row, &name, is_dir) {
                w.table.set_id(child, id);
                if is_dir {
                    w.queue.push((dir.join(&name), child));
                }
            }
        }
        w.busy -= 1;
        wake.notify_all();
    }
}

/// Walk one folder already in `table` (a folder the watcher saw appear), on this thread.
pub fn fill(table: &mut Table, dir: &Path, row: u32, skip: &Skip) {
    let mut stack = vec![(dir.to_path_buf(), row)];
    while let Some((dir, row)) = stack.pop() {
        for (name, is_dir, id) in list(&dir, skip) {
            if let Some(child) = table.insert(row, &name, is_dir) {
                table.set_id(child, id);
                if is_dir {
                    stack.push((dir.join(&name), child));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_util::Scratch;
    use super::*;
    use std::fs;

    fn tree(tag: &str) -> Scratch {
        let dir = Scratch::new(tag);
        let r = dir.path();
        fs::create_dir_all(r.join("a/b/c/d/e/f")).unwrap();
        fs::write(r.join("a/b/c/d/e/f/deep-report.txt"), "").unwrap();
        fs::create_dir_all(r.join("app/node_modules/left-pad")).unwrap();
        fs::write(r.join("app/node_modules/left-pad/index.js"), "").unwrap();
        fs::create_dir_all(r.join("app/.git/objects")).unwrap();
        fs::write(r.join("app/main.js"), "").unwrap();
        dir
    }

    #[test]
    fn walk_fills_table_and_skips_node_modules() {
        let dir = tree("fills");
        let t = walk(dir.path(), &Skip::defaults(), 8, &AtomicBool::new(false));
        let (rows, _) = t.search("deep-report", 5);
        assert_eq!(rows.len(), 1);
        assert_eq!(
            t.path_of(rows[0]),
            dir.path().join("a/b/c/d/e/f/deep-report.txt")
        );
        assert_eq!(t.search("main.js", 5).1, 1);
        // neither the skipped folders nor anything in them
        assert_eq!(t.search("node_modules", 5).1, 0);
        assert_eq!(t.search("left-pad", 5).1, 0);
        assert_eq!(t.search("index.js", 5).1, 0);
        assert_eq!(t.search("objects", 5).1, 0);
        // a, b, c, d, e, f, deep-report.txt, app, main.js
        assert_eq!(t.len(), 9);
    }

    #[test]
    fn walk_skips_a_listed_folder_by_path() {
        let dir = tree("skip-path");
        let skip = Skip::new(&[], vec![dir.path().join("a")]);
        let t = walk(dir.path(), &skip, 2, &AtomicBool::new(false));
        assert_eq!(t.search("deep-report", 5).1, 0);
        assert!(skip.covers(dir.path(), &dir.path().join("a/b")));
        assert!(!skip.covers(dir.path(), &dir.path().join("app/main.js")));
    }

    /// `target` is build output only in a Rust project (a `Cargo.toml` beside it); a `target`
    /// folder anywhere else is someone's real folder and stays in.
    #[test]
    fn target_is_skipped_only_beside_a_cargo_toml() {
        let dir = Scratch::new("skip-target");
        let r = dir.path();
        fs::create_dir_all(r.join("rusty/target/debug")).unwrap();
        fs::write(r.join("rusty/Cargo.toml"), "").unwrap();
        fs::write(r.join("rusty/target/debug/built.exe"), "").unwrap();
        fs::create_dir_all(r.join("plans/target")).unwrap();
        fs::write(r.join("plans/target/goals.txt"), "").unwrap();
        let skip = Skip::defaults();
        let t = walk(r, &skip, 2, &AtomicBool::new(false));
        assert_eq!(t.search("built", 5).1, 0);
        assert_eq!(t.search("debug", 5).1, 0);
        assert_eq!(t.search("goals", 5).1, 1);
        // `target` once: the one under plans
        assert_eq!(t.search("target", 5).1, 1);
        // the watcher asks the same question
        assert!(skip.covers(r, &r.join("rusty/target/debug/built.exe")));
        assert!(skip.covers(r, &r.join("rusty/target")));
        assert!(!skip.covers(r, &r.join("plans/target/goals.txt")));
        assert!(!skip.covers(r, &r.join("rusty/Cargo.toml")));
    }

    #[test]
    fn cache_folders_are_skipped_and_registry_only_under_cargo() {
        let dir = Scratch::new("skip-caches");
        let r = dir.path();
        for d in [
            ".cargo/registry/src",
            ".cargo/bin",
            "py/__pycache__",
            "web/.next",
            "web/.turbo",
            "app/.gradle",
            ".pnpm-store/v3",
            ".rustup/toolchains",
            "npm/registry",
        ] {
            fs::create_dir_all(r.join(d)).unwrap();
            let tag = d.replace(['/', '.'], "-").trim_matches('-').to_string();
            fs::write(r.join(d).join(format!("in-{tag}.txt")), "").unwrap();
        }
        let skip = Skip::defaults();
        let t = walk(r, &skip, 2, &AtomicBool::new(false));
        // only the files in .cargo/bin and npm/registry are left
        assert_eq!(t.search("in-", 20).1, 2);
        assert_eq!(t.search("in-cargo-bin", 5).1, 1);
        assert_eq!(t.search("in-npm-registry", 5).1, 1);
        assert!(skip.covers(r, &r.join(".cargo/registry/src")));
        assert!(skip.covers(r, &r.join("py/__pycache__/x.pyc")));
        assert!(!skip.covers(r, &r.join("npm/registry")));
        // `dist` and `build` are real folders: never skipped
        assert!(!skip.covers(r, &r.join("web/dist/index.html")));
        assert!(!skip.covers(r, &r.join("web/build/out.js")));
    }

    #[test]
    fn walk_counting_counts_every_name_it_read() {
        let dir = tree("counting");
        let seen = AtomicUsize::new(0);
        let skip = Skip::defaults().and_folder(dir.path().join("a"));
        let t = walk_counting(dir.path(), &skip, 3, &AtomicBool::new(false), &seen);
        // app, main.js (a is skipped by path, node_modules and .git by name)
        assert_eq!(t.len(), 2);
        assert_eq!(seen.load(Ordering::Relaxed), t.len());
    }

    /// ⛔ The loop that would otherwise never end (or index a second drive): a link back up.
    #[test]
    fn walk_never_follows_a_junction() {
        let dir = tree("junction");
        // ⚠️ `mklink` refuses a `/` in the path
        let link = dir.path().join("a").join("loop");
        #[cfg(windows)]
        {
            // a junction needs no admin, unlike a symlink
            let ok = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(dir.path())
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "mklink /J failed");
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.path(), &link).unwrap();
        let t = walk(dir.path(), &Skip::defaults(), 4, &AtomicBool::new(false));
        // the link itself is a name; nothing seen through it
        assert_eq!(t.search("loop", 5).1, 1);
        assert_eq!(t.search("deep-report", 5).1, 1);
        assert_eq!(t.len(), 10);
    }

    /// Each row's recorded id opens the same file by id (`OpenFileById`) and equals the id
    /// `usn::file_id` reads from the path; `row_by_id` finds the row back.
    #[cfg(windows)]
    #[test]
    fn walk_ids_match_open_file_by_id() {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            ExtendedFileIdType, GetFinalPathNameByHandleW, OpenFileById,
            FILE_FLAG_BACKUP_SEMANTICS, FILE_ID_128, FILE_ID_DESCRIPTOR, FILE_SHARE_DELETE,
            FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        let dir = tree("ids");
        let t = walk(dir.path(), &Skip::defaults(), 4, &AtomicBool::new(false));
        let root = fs::File::open(dir.path()).unwrap_or_else(|_| {
            // a folder needs backup semantics to open
            use std::os::windows::fs::OpenOptionsExt;
            fs::OpenOptions::new()
                .read(true)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
                .open(dir.path())
                .unwrap()
        });
        let mut checked = 0;
        for (row, _, _, _) in t.rows() {
            let id = t.id_of(row).expect("every walked row has an id");
            assert_eq!(t.row_by_id(id), Some(row));
            assert_eq!(id, super::super::usn::file_id(&t.path_of(row)).unwrap());
            let mut d: FILE_ID_DESCRIPTOR = unsafe { std::mem::zeroed() };
            d.dwSize = size_of::<FILE_ID_DESCRIPTOR>() as u32;
            d.Type = ExtendedFileIdType;
            d.Anonymous.ExtendedFileId = FILE_ID_128 {
                Identifier: id.to_le_bytes(),
            };
            // SAFETY: the root handle is live, `d` is filled.
            let h = unsafe {
                OpenFileById(
                    root.as_raw_handle(),
                    &d,
                    0,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    std::ptr::null(),
                    FILE_FLAG_BACKUP_SEMANTICS,
                )
            };
            assert!(
                !h.is_null() && h as isize != -1,
                "OpenFileById failed for {id:x}"
            );
            let mut buf = [0u16; 1024];
            // SAFETY: `h` is a live handle, `buf` length is passed.
            let n = unsafe { GetFinalPathNameByHandleW(h, buf.as_mut_ptr(), 1024, 0) } as usize;
            // SAFETY: closing the handle opened above.
            unsafe { windows_sys::Win32::Foundation::CloseHandle(h) };
            let got = String::from_utf16_lossy(&buf[..n]).to_lowercase();
            let want = t.path_of(row).to_string_lossy().to_lowercase();
            assert!(got.ends_with(&want[3..]), "{got} vs {want}");
            checked += 1;
        }
        assert_eq!(checked, 9);
    }

    #[test]
    fn mac_skips_list_library_junk_and_trash() {
        let home = Path::new("/Users/x");
        let mut got = mac_skips(home);
        got.sort();
        let mut want: Vec<PathBuf> = [
            "Library/Caches",
            "Library/Developer",
            "Library/pnpm",
            "Library/Containers",
            "Library/Android",
            ".Trash",
        ]
        .iter()
        .map(|p| home.join(p))
        .collect();
        want.sort();
        assert_eq!(got, want);
    }

    /// ⛔ Not all of `~/Library`: iCloud Drive and the cloud providers' folders live in it.
    #[test]
    fn mac_skips_keep_icloud_and_cloud_storage() {
        let home = Path::new("/Users/x");
        let skip = Skip::new(&[], mac_skips(home));
        assert!(skip.covers(home, &home.join("Library/Caches/com.app/blob")));
        assert!(skip.covers(home, &home.join(".Trash/old.txt")));
        assert!(!skip.covers(
            home,
            &home.join("Library/Mobile Documents/com~apple~CloudDocs/a")
        ));
        assert!(!skip.covers(home, &home.join("Library/CloudStorage/Dropbox/b")));
    }

    /// The real defaults pick the Mac list up: without this, dropping the block in
    /// `Skip::defaults` would leave every other test green.
    #[cfg(target_os = "macos")]
    #[test]
    fn defaults_skip_library_junk_on_a_mac() {
        let home = crate::core::shell::user_profile().expect("HOME is set");
        let skip = Skip::defaults();
        assert!(skip.covers(&home, &home.join("Library/Caches/x")));
        assert!(skip.covers(&home, &home.join(".Trash/x")));
        assert!(!skip.covers(&home, &home.join("Library/Mobile Documents/x")));
    }

    /// A media library package is never walked: reading inside it raises the Apple Music or
    /// Photos prompt (Mac test 2026-11-03). A folder merely ending in the word is walked.
    #[test]
    fn walk_leaves_out_media_library_packages() {
        let dir = Scratch::new("media-lib");
        let r = dir.path();
        fs::create_dir_all(r.join("Music Library.musiclibrary")).unwrap();
        fs::create_dir_all(r.join("Photos Library.photoslibrary")).unwrap();
        fs::create_dir_all(r.join("musiclibrary")).unwrap();
        fs::write(r.join("Music Library.musiclibrary/db"), "").unwrap();
        fs::write(r.join("Photos Library.photoslibrary/db"), "").unwrap();
        fs::write(r.join("musiclibrary/kept"), "").unwrap();
        let mut skip = Skip::new(&[], Vec::new());
        skip.exts = mac_library_exts();
        let t = walk(r, &skip, 2, &AtomicBool::new(false));
        assert_eq!(t.search("db", 9).1, 0);
        assert_eq!(t.search("kept", 9).1, 1);
        assert!(skip.covers(r, &r.join("Music Library.musiclibrary/db")));
    }

    #[test]
    fn walk_leaves_out_mac_skips_under_a_temp_home() {
        let dir = Scratch::new("mac-home");
        let r = dir.path();
        for d in [
            "Library/Caches",
            ".Trash",
            "Library/Mobile Documents",
            "Documents",
        ] {
            fs::create_dir_all(r.join(d)).unwrap();
        }
        fs::write(r.join("Library/Caches/a-file"), "").unwrap();
        fs::write(r.join(".Trash/c-file"), "").unwrap();
        fs::write(r.join("Library/Mobile Documents/b-file"), "").unwrap();
        fs::write(r.join("Documents/d-file"), "").unwrap();
        let skip = Skip::new(&[], mac_skips(r));
        let t = walk(r, &skip, 2, &AtomicBool::new(false));
        // Library, Mobile Documents, b, Documents, d
        assert_eq!(t.len(), 5);
        assert_eq!(t.search("b-file", 9).1, 1);
        assert_eq!(t.search("d-file", 9).1, 1);
        assert_eq!(t.search("a-file", 9).1, 0);
        assert_eq!(t.search("c-file", 9).1, 0);
    }

    /// Plan 21C.9b: the walk of `/` leaves out the kernel's trees, the cache, the bin and every
    /// mount that is not on a local disk; a second local disk (`/data`) and `/` stay in. Linux
    /// only: on Windows `/mnt/my share` is no path the skip list can match.
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_skips_leave_out_kernel_trees_cache_and_mounts_not_on_a_local_disk() {
        let mounts = "\
proc /proc proc rw,nosuid 0 0
/dev/sda2 / ext4 rw,relatime 0 0
/dev/sdb1 /data xfs rw 0 0
/dev/loop3 /snap/core/123 squashfs ro 0 0
srv:/share /mnt/my\\040share nfs4 rw 0 0
C:\\134 /mnt/c 9p rw 0 0
tmpfs /run tmpfs rw 0 0
";
        let home = Path::new("/home/x");
        let got = linux_skips(Some(home), mounts);
        let want: Vec<PathBuf> = [
            "/proc",
            "/sys",
            "/dev",
            "/run",
            "/media",
            "/home/x/.cache",
            "/home/x/.local/share/Trash",
            "/snap/core/123",
            "/mnt/my share",
            "/mnt/c",
        ]
        .iter()
        .map(PathBuf::from)
        .collect();
        assert_eq!(got, want, "no duplicates, in this order");
        let skip = Skip::new(&[], got);
        let root = Path::new("/");
        assert!(skip.covers(root, Path::new("/proc/1/status")));
        assert!(skip.covers(root, Path::new("/mnt/my share/a.txt")));
        assert!(skip.covers(root, Path::new("/home/x/.cache/big")));
        assert!(!skip.covers(root, Path::new("/data/photos/a.jpg")));
        assert!(!skip.covers(root, Path::new("/etc/hosts")));
        assert!(!skip.covers(root, Path::new("/home/x/docs/a.txt")));
    }
}
