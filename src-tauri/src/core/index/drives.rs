//! Which drives the index walks (plan 21C.2a): every fixed local drive. ⛔ Never a network drive
//! (a walk of a share nobody opened is minutes of SMB traffic); a USB stick or a USB hard disk is
//! off by default — `GetDriveTypeW` calls a USB hard disk FIXED, so its bus is asked too.
//!
//! Off Windows there are no drive letters. Linux walks `/` as one root (plan 21C.9b); a Mac
//! keeps to the home folder for now.

use std::path::PathBuf;

/// GetDriveTypeW's answers (WinBase.h).
#[cfg(any(windows, test))]
#[allow(
    dead_code,
    reason = "only FIXED is matched outside the tests; the rest name what is refused"
)]
mod drive_type {
    pub const REMOVABLE: u32 = 2;
    pub const FIXED: u32 = 3;
    pub const REMOTE: u32 = 4;
    pub const CDROM: u32 = 5;
}

/// `STORAGE_BUS_TYPE` values (ntddstor.h) that mean "plugged in, may leave": USB, SD, MMC.
#[cfg(any(windows, test))]
mod bus_type {
    pub const USB: u32 = 0x7;
    pub const SD: u32 = 0xC;
    pub const MMC: u32 = 0xD;
}

/// Whether a drive is walked: fixed, and not on a bus that unplugs. `bus` is `None` when the
/// disk would not say (a volume with no disk under it, say) — then the drive type decides.
#[cfg(any(windows, test))]
fn walked(kind: u32, bus: Option<u32>) -> bool {
    kind == drive_type::FIXED && !matches!(bus, Some(bus_type::USB | bus_type::SD | bus_type::MMC))
}

/// The fixed local drives, `C:\` first, as roots to walk.
#[cfg(windows)]
pub fn fixed_local() -> Vec<PathBuf> {
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};

    // SAFETY: no arguments, no out-params — the bitmask is the return value.
    let mask = unsafe { GetLogicalDrives() };
    (0u8..26)
        .filter(|i| mask & (1 << i) != 0)
        .map(|i| (b'A' + i) as char)
        .filter(|&letter| {
            let root: Vec<u16> = format!("{letter}:\\").encode_utf16().chain([0]).collect();
            // SAFETY: `root` is NUL-terminated and outlives the call.
            let kind = unsafe { GetDriveTypeW(root.as_ptr()) };
            // only a FIXED drive is worth the bus question (a network letter is never opened)
            kind == drive_type::FIXED && walked(kind, bus_of(letter))
        })
        .map(|letter| PathBuf::from(format!("{letter}:\\")))
        .collect()
}

/// Linux (plan 21C.9b): `/`, one root for the whole disk outside the home folder. Its walk
/// leaves out `/proc`, `/media` and every mount that is not a local disk (`walk::linux_skips`).
#[cfg(target_os = "linux")]
pub fn fixed_local() -> Vec<PathBuf> {
    vec![PathBuf::from("/")]
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn fixed_local() -> Vec<PathBuf> {
    Vec::new()
}

/// The bus a drive's disk hangs on (`IOCTL_STORAGE_QUERY_PROPERTY`, `StorageDeviceProperty`).
/// The volume is opened with no access rights, which a normal user may do (plan 21C, the
/// `CreateFile` with 0 row) and this query accepts.
#[cfg(windows)]
fn bus_of(letter: char) -> Option<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    // ⚠️ `DeviceIoControl` lives behind windows-sys's `Win32_System_IO` feature, which this crate
    // does not turn on; one declaration here is cheaper than a feature for one call.
    #[link(name = "kernel32")]
    extern "system" {
        fn DeviceIoControl(
            device: *mut core::ffi::c_void,
            code: u32,
            input: *const core::ffi::c_void,
            input_len: u32,
            output: *mut core::ffi::c_void,
            output_len: u32,
            returned: *mut u32,
            overlapped: *mut core::ffi::c_void,
        ) -> i32;
    }
    // CTL_CODE(IOCTL_STORAGE_BASE 0x2d, 0x500, METHOD_BUFFERED, FILE_ANY_ACCESS)
    const IOCTL_STORAGE_QUERY_PROPERTY: u32 = 0x002D_1400;
    // STORAGE_DEVICE_DESCRIPTOR: Version, Size (u32 each), four BYTEs, four u32 offsets, BusType
    const BUS_TYPE_AT: usize = 4 + 4 + 4 + 4 * 4;

    let path: Vec<u16> = format!("\\\\.\\{letter}:")
        .encode_utf16()
        .chain([0])
        .collect();
    // SAFETY: `path` is NUL-terminated; no security attributes, no template.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return None;
    }
    // STORAGE_PROPERTY_QUERY { StorageDeviceProperty = 0, PropertyStandardQuery = 0, [0] }
    let query = [0u32; 3];
    let mut out = [0u8; 512];
    let mut got = 0u32;
    // SAFETY: `handle` is open; `query` and `out` are live buffers of the lengths passed.
    let ok = unsafe {
        DeviceIoControl(
            handle,
            IOCTL_STORAGE_QUERY_PROPERTY,
            query.as_ptr().cast(),
            std::mem::size_of_val(&query) as u32,
            out.as_mut_ptr().cast(),
            out.len() as u32,
            &mut got,
            std::ptr::null_mut(),
        )
    };
    // SAFETY: `handle` came from CreateFileW above and is closed once.
    unsafe { CloseHandle(handle) };
    if ok == 0 || (got as usize) < BUS_TYPE_AT + 4 {
        return None;
    }
    let bytes: [u8; 4] = out[BUS_TYPE_AT..BUS_TYPE_AT + 4].try_into().ok()?;
    Some(u32::from_le_bytes(bytes))
}

/// The name the palette footer shows for a root: `D:` for a drive, `home` for the home folder.
pub fn label_of(root: &std::path::Path) -> String {
    let text = root.to_string_lossy();
    let bytes = text.as_bytes();
    if bytes.len() <= 3 && bytes.len() >= 2 && bytes[1] == b':' {
        return text[..2].to_uppercase();
    }
    if text == "/" {
        return "/".into();
    }
    "home".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walked_takes_fixed_drives_and_leaves_network_and_usb() {
        assert!(walked(drive_type::FIXED, None));
        assert!(walked(drive_type::FIXED, Some(0x11))); // NVMe
        assert!(!walked(drive_type::FIXED, Some(bus_type::USB)));
        assert!(!walked(drive_type::FIXED, Some(bus_type::SD)));
        assert!(!walked(drive_type::REMOTE, None));
        assert!(!walked(drive_type::REMOVABLE, None));
        assert!(!walked(drive_type::CDROM, None));
    }

    #[test]
    fn label_is_the_letter_for_a_drive() {
        assert_eq!(label_of(std::path::Path::new("d:\\")), "D:");
        assert_eq!(label_of(std::path::Path::new("C:\\Users\\alex")), "home");
        assert_eq!(label_of(std::path::Path::new("/")), "/");
    }

    /// What this box walks (plan 21C.2a). On Windows the system drive is always one.
    #[test]
    fn fixed_local_lists_the_system_drive() {
        let drives = fixed_local();
        eprintln!("index drives: {drives:?}");
        if cfg!(windows) {
            let system = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
            assert!(drives.contains(&PathBuf::from(format!("{system}\\"))));
        } else if cfg!(target_os = "linux") {
            assert_eq!(drives, vec![PathBuf::from("/")]);
        } else {
            assert!(drives.is_empty());
        }
    }
}
