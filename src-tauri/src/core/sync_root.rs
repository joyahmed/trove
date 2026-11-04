//! A cloud folder's sync state, as OneDrive reports it to the Cloud Files API: the glyph on the
//! OneDrive sidebar row (plan 05 5.4). Read-only and cheap; it never asks the provider anything.

use serde::Serialize;
use std::path::Path;

/// What the sidebar says about a sync root, in four words a person knows.
#[cfg_attr(not(windows), allow(dead_code))] // only Windows reads sync status; tested everywhere
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SyncStatus {
    UpToDate,
    Syncing,
    /// disconnected, or the provider lost the network
    Offline,
    /// the provider stopped or reported a fault
    Error,
}

/// `CF_SYNC_PROVIDER_STATUS` bits (cfapi.h).
#[cfg_attr(not(windows), allow(dead_code))] // only Windows reads sync status; tested everywhere
const CONNECTIVITY_LOST: u32 = 0x40;
#[cfg_attr(not(windows), allow(dead_code))] // only Windows reads sync status; tested everywhere
const SYNC_WORK: u32 = 0x2 | 0x4 | 0x8 | 0x10 | 0x20; // populate namespace/metadata/content, sync
#[cfg_attr(not(windows), allow(dead_code))] // only Windows reads sync status; tested everywhere
const IDLE: u32 = 0x1;
#[cfg_attr(not(windows), allow(dead_code))] // only Windows reads sync status; tested everywhere
const FAULT: u32 = 0xC000_0000; // TERMINATED 0xC0000001, ERROR 0xC0000002

/// The status word in the sidebar's four words. A fault wins, then no network, then work in
/// flight; `DISCONNECTED` (0) reads as offline. An unknown word says nothing.
#[cfg_attr(not(windows), allow(dead_code))] // only Windows reads sync status; tested everywhere
pub(crate) fn status_of(code: u32) -> Option<SyncStatus> {
    if code & FAULT == FAULT {
        Some(SyncStatus::Error)
    } else if code & CONNECTIVITY_LOST != 0 || code == 0 {
        Some(SyncStatus::Offline)
    } else if code & SYNC_WORK != 0 {
        Some(SyncStatus::Syncing)
    } else if code == IDLE {
        Some(SyncStatus::UpToDate)
    } else {
        None
    }
}

/// The sync state of the sync root `path` sits in, or `None` when it is not in one.
#[cfg(windows)]
pub fn sync_status(path: &Path) -> Option<SyncStatus> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::CloudFilters::{
        CfGetSyncRootInfoByPath, CF_SYNC_ROOT_INFO_PROVIDER, CF_SYNC_ROOT_PROVIDER_INFO,
    };

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: zeroed is a valid CF_SYNC_ROOT_PROVIDER_INFO (an integer and two u16 arrays).
    let mut info: CF_SYNC_ROOT_PROVIDER_INFO = unsafe { std::mem::zeroed() };
    let mut got = 0u32;
    // SAFETY: `wide` is NUL-terminated and outlives the call; `info` is a writable buffer of
    // exactly the length passed; `got` is a writable u32.
    let hr = unsafe {
        CfGetSyncRootInfoByPath(
            wide.as_ptr(),
            CF_SYNC_ROOT_INFO_PROVIDER,
            (&raw mut info).cast(),
            std::mem::size_of::<CF_SYNC_ROOT_PROVIDER_INFO>() as u32,
            &mut got,
        )
    };
    if hr < 0 {
        return None;
    }
    status_of(info.ProviderStatus as u32)
}

#[cfg(not(windows))]
pub fn sync_status(_path: &Path) -> Option<SyncStatus> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_provider_word_reads_as_four_plain_states() {
        assert_eq!(status_of(0x1), Some(SyncStatus::UpToDate));
        assert_eq!(status_of(0x10), Some(SyncStatus::Syncing));
        assert_eq!(status_of(0x2 | 0x8), Some(SyncStatus::Syncing));
        assert_eq!(status_of(0x0), Some(SyncStatus::Offline));
        assert_eq!(status_of(0x40 | 0x10), Some(SyncStatus::Offline));
        assert_eq!(status_of(0xC000_0001), Some(SyncStatus::Error));
        assert_eq!(status_of(0xC000_0002), Some(SyncStatus::Error));
        assert_eq!(status_of(0x8000_0000), None); // CLEAR_FLAGS is a write-only word
    }

    #[test]
    fn a_plain_folder_is_not_a_sync_root() {
        let dir = std::env::temp_dir();
        assert_eq!(sync_status(&dir), None);
    }
}
