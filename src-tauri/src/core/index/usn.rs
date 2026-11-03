//! NTFS change journal (USN) tail for the name table (plan 21C.3b). Windows only.
//!
//! No admin. Measured on Joy's box (plan 21C, "What Windows lets a normal user do"): a volume
//! handle (`\\.\C:`) needs admin, but a plain *folder* handle on the drive answers
//! `FSCTL_QUERY_USN_JOURNAL` and `FSCTL_READ_UNPRIVILEGED_USN_JOURNAL`. The unprivileged read
//! gives ids and reasons but no names, so a name is looked up with `OpenFileById` while the file
//! still exists. When the process is elevated, `FSCTL_READ_USN_JOURNAL` is tried first and the
//! records carry their names.
//!
//! Only records with `USN_REASON_CLOSE` are turned into events: NTFS adds reasons to one record
//! per file until the last handle closes, so the close record holds everything that happened.
//!
//! The caller must tell three failures apart, so [`UsnError`] does: no access (fall back to the
//! watcher + re-walk), no journal (same, and never create one — that needs admin), and a wrapped
//! or replaced journal (re-walk, plan 21C.3c).

use std::ffi::{c_void, OsStr, OsString};
use std::fmt;
use std::io;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_INVALID_FUNCTION,
    ERROR_INVALID_PARAMETER, ERROR_JOURNAL_DELETE_IN_PROGRESS, ERROR_JOURNAL_ENTRY_DELETED,
    ERROR_JOURNAL_NOT_ACTIVE, ERROR_NOT_SUPPORTED, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ExtendedFileIdType, FileIdType, GetFinalPathNameByHandleW, OpenFileById,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_ID_128, FILE_ID_DESCRIPTOR, FILE_READ_ATTRIBUTES,
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Ioctl::{
    FSCTL_QUERY_USN_JOURNAL, FSCTL_READ_UNPRIVILEGED_USN_JOURNAL, FSCTL_READ_USN_JOURNAL,
    READ_USN_JOURNAL_DATA_V1, USN_REASON_CLOSE, USN_REASON_FILE_CREATE, USN_REASON_FILE_DELETE,
    USN_REASON_RENAME_NEW_NAME, USN_REASON_RENAME_OLD_NAME,
};
use windows_sys::Win32::System::IO::DeviceIoControl;

/// One read's buffer. The probe got 1023 records in 64 KB.
const BUF: usize = 64 * 1024;

/// Why the journal cannot be tailed. Each one tells the caller what to do instead.
#[derive(Debug)]
pub enum UsnError {
    /// Windows refused (error 5): neither the elevated nor the unprivileged read is allowed, or
    /// the folder cannot be opened. Fall back to the `notify` watcher; never ask for elevation.
    NoAccess,
    /// The drive has no change journal (error 1179 / 1178), or is not NTFS/ReFS (error 1).
    /// Fall back to the watcher. Making a journal needs admin (plan 21C.6, only if asked).
    NoJournal,
    /// The saved position is gone: the journal wrapped past it, or it is a different journal
    /// (new id). Re-walk (plan 21C.3c).
    Wrapped,
    /// Anything else.
    Io(io::Error),
}

impl fmt::Display for UsnError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UsnError::NoAccess => f.write_str("no access to the change journal"),
            UsnError::NoJournal => f.write_str("the drive has no change journal"),
            UsnError::Wrapped => f.write_str("the change journal moved past the saved position"),
            UsnError::Io(e) => write!(f, "change journal: {e}"),
        }
    }
}

impl std::error::Error for UsnError {}

impl UsnError {
    fn from_code(code: u32) -> Self {
        match code {
            ERROR_ACCESS_DENIED => UsnError::NoAccess,
            ERROR_JOURNAL_NOT_ACTIVE
            | ERROR_JOURNAL_DELETE_IN_PROGRESS
            | ERROR_INVALID_FUNCTION
            | ERROR_NOT_SUPPORTED => UsnError::NoJournal,
            ERROR_JOURNAL_ENTRY_DELETED => UsnError::Wrapped,
            _ => UsnError::Io(io::Error::from_raw_os_error(code as i32)),
        }
    }

    fn last() -> Self {
        // SAFETY: reads the calling thread's last-error value, no arguments.
        Self::from_code(unsafe { GetLastError() })
    }
}

/// Where the journal stands right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Journal {
    /// Changes when the journal is deleted and made again; a saved USN from another id is void.
    pub id: u64,
    /// The oldest record still kept. A saved USN below this means the journal wrapped.
    pub first_usn: i64,
    /// Where the next record will be written.
    pub next_usn: i64,
}

/// What happened to one file or folder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Change {
    Created,
    Renamed,
    Deleted,
}

/// One create / rename / delete, from one close record.
#[derive(Clone, Debug)]
pub struct Event {
    pub change: Change,
    /// File id (128-bit; NTFS ids are the 64-bit reference zero-extended).
    pub id: u128,
    /// The folder it is in now (for a rename: the new folder).
    #[cfg_attr(
        not(test),
        allow(dead_code, reason = "rows are found by `id`; tests read it")
    )]
    pub parent: u128,
    /// The record's own name. Only an elevated read has it; `None` otherwise.
    #[allow(
        dead_code,
        reason = "read only to tell a skipped folder from a ghost; tests build it"
    )]
    pub name: Option<OsString>,
    /// The full path now, from `OpenFileById`. `None` for a delete, or when the file is already
    /// gone (or moved somewhere this user cannot open) by the time the record is read.
    pub path: Option<PathBuf>,
    #[cfg_attr(
        not(test),
        allow(dead_code, reason = "rows are found by `id`; tests read it")
    )]
    pub usn: i64,
    #[allow(
        dead_code,
        reason = "the watcher's rule looks at the disk for the folder flag"
    )]
    pub folder: bool,
}

/// An owned Win32 handle, closed on drop.
struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: the handle came from CreateFileW / OpenFileById and is closed once, here.
        unsafe { CloseHandle(self.0) };
    }
}

// SAFETY: a file handle may be used and closed from any thread.
unsafe impl Send for Handle {}

fn wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(Some(0)).collect()
}

/// A folder (or file) handle that answers the journal FSCTLs without admin.
fn open_folder(dir: &Path) -> Result<Handle, UsnError> {
    let path = wide(dir.as_os_str());
    // SAFETY: `path` is NUL-terminated and outlives the call; no security attributes or template.
    let h = unsafe {
        CreateFileW(
            path.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if h == INVALID_HANDLE_VALUE {
        return Err(UsnError::last());
    }
    Ok(Handle(h))
}

/// `DeviceIoControl` into `out`; returns the bytes written.
fn ioctl<T>(h: &Handle, code: u32, input: Option<&T>, out: &mut [u8]) -> Result<usize, UsnError> {
    let (ip, il) = match input {
        Some(t) => (t as *const T as *const c_void, size_of::<T>() as u32),
        None => (std::ptr::null(), 0),
    };
    let mut got = 0u32;
    // SAFETY: `ip`/`il` describe a live `T` or nothing; `out` is a live mutable buffer of the
    // length passed; synchronous call (no OVERLAPPED).
    let ok = unsafe {
        DeviceIoControl(
            h.0,
            code,
            ip,
            il,
            out.as_mut_ptr().cast(),
            out.len() as u32,
            &mut got,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(UsnError::last());
    }
    Ok(got as usize)
}

fn query_handle(h: &Handle) -> Result<Journal, UsnError> {
    // USN_JOURNAL_DATA_V2 is 80 bytes; V0 (56) is what an old kernel answers.
    let mut out = [0u8; 80];
    let n = ioctl::<()>(h, FSCTL_QUERY_USN_JOURNAL, None, &mut out)?;
    if n < 24 {
        return Err(UsnError::Io(io::Error::other("short journal answer")));
    }
    Ok(Journal {
        id: u64_at(&out, 0),
        first_usn: i64_at(&out, 8),
        next_usn: i64_at(&out, 16),
    })
}

/// The journal of the drive `dir` is on. `dir` is any folder on that drive (`C:\` works).
#[allow(
    dead_code,
    reason = "only the tests ask for a journal without tailing it"
)]
pub fn query(dir: &Path) -> Result<Journal, UsnError> {
    query_handle(&open_folder(dir)?)
}

/// The 128-bit file id of `path` (`FileIdInfo`), the same id the journal records carry. The
/// index asks it of a part's root, to know a delete made directly in it.
pub fn file_id(path: &Path) -> io::Result<u128> {
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO,
    };
    let h = open_folder(path).map_err(|e| match e {
        UsnError::Io(e) => e,
        other => io::Error::other(other.to_string()),
    })?;
    // SAFETY: FILE_ID_INFO is plain data; all-zero is a valid value.
    let mut info: FILE_ID_INFO = unsafe { std::mem::zeroed() };
    // SAFETY: `info` is a live FILE_ID_INFO and its size is passed.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            h.0,
            FileIdInfo,
            (&mut info as *mut FILE_ID_INFO).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(u128::from_le_bytes(info.FileId.Identifier))
}

/// The current full path of file `id`, or `None` if it is gone or cannot be opened.
fn path_of(hint: &Handle, id: u128) -> Option<PathBuf> {
    let mut d = FILE_ID_DESCRIPTOR {
        dwSize: size_of::<FILE_ID_DESCRIPTOR>() as u32,
        ..Default::default()
    };
    if let Ok(small) = u64::try_from(id) {
        d.Type = FileIdType;
        d.Anonymous.FileId = small as i64;
    } else {
        d.Type = ExtendedFileIdType;
        d.Anonymous.ExtendedFileId = FILE_ID_128 {
            Identifier: id.to_le_bytes(),
        };
    }
    // SAFETY: `hint` is a live handle on the same volume, `d` is a filled descriptor; access 0
    // is enough to ask for the name.
    let h = unsafe {
        OpenFileById(
            hint.0,
            &d,
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            FILE_FLAG_BACKUP_SEMANTICS,
        )
    };
    if h == INVALID_HANDLE_VALUE {
        return None;
    }
    let h = Handle(h);
    let mut buf = vec![0u16; 512];
    loop {
        // SAFETY: `buf` is live and its length in u16s is passed; flags 0 = normalized DOS path.
        let n = unsafe { GetFinalPathNameByHandleW(h.0, buf.as_mut_ptr(), buf.len() as u32, 0) }
            as usize;
        if n == 0 {
            return None;
        }
        if n < buf.len() {
            buf.truncate(n);
            break;
        }
        buf.resize(n + 1, 0);
    }
    let s = OsString::from_wide(&buf);
    // `\\?\C:\x` → `C:\x`; keep `\\?\UNC\…` and anything else as it is.
    let s = match s.to_str() {
        Some(t) if t.starts_with(r"\\?\") && t.as_bytes().get(5) == Some(&b':') => {
            OsString::from(&t[4..])
        }
        _ => s,
    };
    Some(PathBuf::from(s))
}

fn u16_at(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(b[o..o + 4].try_into().unwrap_or_default())
}
fn u64_at(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(b[o..o + 8].try_into().unwrap_or_default())
}
fn i64_at(b: &[u8], o: usize) -> i64 {
    u64_at(b, o) as i64
}
fn u128_at(b: &[u8], o: usize) -> u128 {
    u128::from_le_bytes(b[o..o + 16].try_into().unwrap_or_default())
}

/// One raw record, version 2 or 3 (4 holds no names and only appears with range tracking on).
struct Record {
    id: u128,
    parent: u128,
    usn: i64,
    reason: u32,
    attrs: u32,
    name: Option<OsString>,
}

/// The records in one read's output (after its leading 8-byte next-USN).
fn parse(buf: &[u8]) -> Vec<Record> {
    let mut out = Vec::new();
    let mut at = 8;
    while at + 8 <= buf.len() {
        let len = u32_at(buf, at) as usize;
        if len < 8 || at + len > buf.len() {
            break;
        }
        let r = &buf[at..at + len];
        // (id, parent, offset of Usn); the fields after Usn sit at the same distances in both.
        let ids = match u16_at(r, 4) {
            2 if len >= 60 => Some((u64_at(r, 8) as u128, u64_at(r, 16) as u128, 24)),
            3 if len >= 76 => Some((u128_at(r, 8), u128_at(r, 24), 40)),
            _ => None,
        };
        if let Some((id, parent, o)) = ids {
            let name_len = u16_at(r, o + 32) as usize;
            let name_off = u16_at(r, o + 34) as usize;
            let name = (name_len > 0 && name_off + name_len <= len).then(|| {
                let w: Vec<u16> = r[name_off..name_off + name_len]
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|c| u16::from_le_bytes(*c))
                    .collect();
                OsString::from_wide(&w)
            });
            out.push(Record {
                id,
                parent,
                usn: i64_at(r, o),
                reason: u32_at(r, o + 16),
                attrs: u32_at(r, o + 28),
                name,
            });
        }
        at += len;
    }
    out
}

/// What a close record means for the index, or `None` if it is not a create / rename / delete.
fn change_of(reason: u32) -> Option<Change> {
    if reason & USN_REASON_CLOSE == 0 {
        return None;
    }
    if reason & USN_REASON_FILE_DELETE != 0 {
        Some(Change::Deleted)
    } else if reason & USN_REASON_FILE_CREATE != 0 {
        Some(Change::Created)
    } else if reason & (USN_REASON_RENAME_NEW_NAME | USN_REASON_RENAME_OLD_NAME) != 0 {
        Some(Change::Renamed)
    } else {
        None
    }
}

/// Reads the journal of one drive forward from a position, a batch per [`UsnTail::read`].
pub struct UsnTail {
    folder: Handle,
    journal: Journal,
    next: i64,
    /// `FSCTL_READ_USN_JOURNAL` worked (elevated): records carry names.
    privileged: bool,
}

impl UsnTail {
    /// Tail the journal of `dir`'s drive from now on.
    pub fn open(dir: &Path) -> Result<Self, UsnError> {
        let folder = open_folder(dir)?;
        let journal = query_handle(&folder)?;
        let mut tail = UsnTail {
            folder,
            journal,
            next: journal.next_usn,
            privileged: true,
        };
        tail.probe()?;
        Ok(tail)
    }

    /// Resume from a saved journal id and USN (plan 21C.3c). [`UsnError::Wrapped`] when that
    /// position is no longer in the journal.
    pub fn resume(dir: &Path, journal_id: u64, from: i64) -> Result<Self, UsnError> {
        let folder = open_folder(dir)?;
        let journal = query_handle(&folder)?;
        if journal.id != journal_id || from < journal.first_usn || from > journal.next_usn {
            return Err(UsnError::Wrapped);
        }
        let mut tail = UsnTail {
            folder,
            journal,
            next: from,
            privileged: true,
        };
        tail.probe()?;
        Ok(tail)
    }

    /// Pick the read that works here, so `open` already answers `NoAccess`.
    fn probe(&mut self) -> Result<(), UsnError> {
        let mut buf = vec![0u8; 4096];
        match self.read_raw(&mut buf, self.next) {
            Ok(_) => Ok(()),
            Err(UsnError::NoAccess) if self.privileged => {
                self.privileged = false;
                self.read_raw(&mut buf, self.next).map(|_| ())
            }
            Err(e) => Err(e),
        }
    }

    /// The journal as it was when this tail opened.
    pub fn journal(&self) -> Journal {
        self.journal
    }

    /// The position the next [`read`](Self::read) starts from — save this with the index.
    pub fn next_usn(&self) -> i64 {
        self.next
    }

    /// Whether records carry their names (the process is elevated). Unprivileged reads look the
    /// name up by id instead, so deletes come without a path.
    pub fn has_names(&self) -> bool {
        self.privileged
    }

    fn read_raw(&self, buf: &mut [u8], from: i64) -> Result<usize, UsnError> {
        let input = READ_USN_JOURNAL_DATA_V1 {
            StartUsn: from,
            ReasonMask: USN_REASON_CLOSE
                | USN_REASON_FILE_CREATE
                | USN_REASON_FILE_DELETE
                | USN_REASON_RENAME_NEW_NAME
                | USN_REASON_RENAME_OLD_NAME,
            ReturnOnlyOnClose: 1,
            Timeout: 0,
            BytesToWaitFor: 0,
            UsnJournalID: self.journal.id,
            MinMajorVersion: 2,
            MaxMajorVersion: 3,
        };
        let code = if self.privileged {
            FSCTL_READ_USN_JOURNAL
        } else {
            FSCTL_READ_UNPRIVILEGED_USN_JOURNAL
        };
        match ioctl(&self.folder, code, Some(&input), buf) {
            // A journal id that no longer matches comes back as "invalid parameter".
            Err(UsnError::Io(e)) if e.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) => {
                Err(UsnError::Wrapped)
            }
            other => other,
        }
    }

    /// Every create / rename / delete since the last read (or since `open`). Returns at once;
    /// an empty list means nothing closed since. A change is seen when the file's last handle
    /// closes — an antivirus scan can hold that a moment.
    pub fn read(&mut self) -> Result<Vec<Event>, UsnError> {
        let mut buf = vec![0u8; BUF];
        let mut events = Vec::new();
        loop {
            let n = self.read_raw(&mut buf, self.next)?;
            if n < 8 {
                break;
            }
            let next = i64_at(&buf, 0);
            for r in parse(&buf[..n]) {
                let Some(change) = change_of(r.reason) else {
                    continue;
                };
                let path = match change {
                    Change::Deleted => None,
                    _ => path_of(&self.folder, r.id),
                };
                events.push(Event {
                    change,
                    id: r.id,
                    parent: r.parent,
                    name: r.name,
                    path,
                    usn: r.usn,
                    folder: r.attrs & 0x10 != 0, // FILE_ATTRIBUTE_DIRECTORY
                });
            }
            let done = n == 8 || next <= self.next;
            self.next = next.max(self.next);
            if done {
                break;
            }
        }
        Ok(events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// Read until an event of `change` for `id` shows up (antivirus can delay the close record).
    fn wait_for(tail: &mut UsnTail, id: u128, change: Change) -> Event {
        let end = Instant::now() + Duration::from_secs(10);
        loop {
            let events = tail.read().expect("read journal");
            if let Some(e) = events
                .into_iter()
                .find(|e| e.id == id && e.change == change)
            {
                return e;
            }
            assert!(
                Instant::now() < end,
                "no {change:?} event for id {id:#x} in 10 s"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    #[test]
    fn change_of_needs_close_and_prefers_delete() {
        assert_eq!(change_of(USN_REASON_FILE_CREATE), None);
        assert_eq!(
            change_of(USN_REASON_FILE_CREATE | USN_REASON_CLOSE),
            Some(Change::Created)
        );
        assert_eq!(
            change_of(USN_REASON_FILE_CREATE | USN_REASON_FILE_DELETE | USN_REASON_CLOSE),
            Some(Change::Deleted)
        );
        assert_eq!(
            change_of(USN_REASON_RENAME_OLD_NAME | USN_REASON_RENAME_NEW_NAME | USN_REASON_CLOSE),
            Some(Change::Renamed)
        );
        assert_eq!(change_of(USN_REASON_CLOSE | 0x2), None); // data extend only
    }

    #[test]
    fn parse_reads_a_v2_record_with_name() {
        let name: Vec<u8> = "ab".encode_utf16().flat_map(u16::to_le_bytes).collect();
        let len = 60 + name.len();
        let mut rec = vec![0u8; len];
        rec[0..4].copy_from_slice(&(len as u32).to_le_bytes());
        rec[4..6].copy_from_slice(&2u16.to_le_bytes());
        rec[8..16].copy_from_slice(&7u64.to_le_bytes());
        rec[16..24].copy_from_slice(&5u64.to_le_bytes());
        rec[24..32].copy_from_slice(&99i64.to_le_bytes());
        rec[40..44].copy_from_slice(&(USN_REASON_FILE_CREATE | USN_REASON_CLOSE).to_le_bytes());
        rec[52..56].copy_from_slice(&0x10u32.to_le_bytes());
        rec[56..58].copy_from_slice(&(name.len() as u16).to_le_bytes());
        rec[58..60].copy_from_slice(&60u16.to_le_bytes());
        rec[60..].copy_from_slice(&name);
        let mut buf = 123i64.to_le_bytes().to_vec();
        buf.extend_from_slice(&rec);
        let got = parse(&buf);
        assert_eq!(got.len(), 1);
        let r = &got[0];
        assert_eq!((r.id, r.parent, r.usn, r.attrs), (7, 5, 99, 0x10));
        assert_eq!(r.reason, USN_REASON_FILE_CREATE | USN_REASON_CLOSE);
        assert_eq!(r.name.as_deref(), Some(OsStr::new("ab")));
    }

    #[test]
    fn usn_tail_sees_create_rename_delete_in_temp() {
        let temp = std::env::temp_dir();
        if !temp
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("C:")
        {
            println!("SKIP usn_tail: temp dir {} is not on C:", temp.display());
            return;
        }
        let dir = temp.join(format!("trove-usn-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("make temp dir");

        let mut tail = match UsnTail::open(&dir) {
            Ok(t) => t,
            Err(e @ (UsnError::NoAccess | UsnError::NoJournal)) => {
                println!("SKIP usn_tail: {e} on C: - the caller falls back to watcher + re-walk");
                let _ = std::fs::remove_dir_all(&dir);
                return;
            }
            Err(e) => panic!("open journal: {e}"),
        };
        println!(
            "usn_tail: journal {:#x}, from usn {}, names in records (elevated read): {}",
            tail.journal().id,
            tail.next_usn(),
            tail.has_names()
        );

        let a = dir.join("made.txt");
        std::fs::write(&a, b"x").expect("create");
        let id = file_id(&a).expect("file id");
        let created = wait_for(&mut tail, id, Change::Created);
        let created_path = created.path.clone().expect("created file has a path");
        assert!(
            created_path.ends_with("made.txt"),
            "created path {}",
            created_path.display()
        );

        let b = dir.join("renamed.txt");
        std::fs::rename(&a, &b).expect("rename");
        let renamed = wait_for(&mut tail, id, Change::Renamed);
        let renamed_path = renamed.path.clone().expect("renamed file has a path");
        assert!(
            renamed_path.ends_with("renamed.txt"),
            "renamed path {}",
            renamed_path.display()
        );
        assert_eq!(renamed.parent, file_id(&dir).expect("dir id"));

        std::fs::remove_file(&b).expect("delete");
        let deleted = wait_for(&mut tail, id, Change::Deleted);
        assert!(deleted.path.is_none());
        assert!(deleted.usn > renamed.usn && renamed.usn > created.usn);

        println!(
            "usn_tail: saw created {} -> renamed {} -> deleted (usn {} -> {} -> {})",
            created_path.display(),
            renamed_path.display(),
            created.usn,
            renamed.usn,
            deleted.usn
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
