//! Signing in to a network share (plan 05 5.3d).
//!
//! A share that wants a user name answers a listing with `ERROR_ACCESS_DENIED` (5) or
//! `ERROR_LOGON_FAILURE` (1326). Explorer then shows the Windows credential box and connects;
//! Trove does the same, once per attempt, when the person asks for it: the frontend offers
//! "Sign in…" on that error, `sign_in` shows `CredUIPromptForWindowsCredentialsW` and hands
//! what was typed to `WNetAddConnection2W`, and the listing is tried again.
//!
//! ⛔ The password never leaves this module: it is read out of the credential buffer, passed
//! to `WNetAddConnection2W`, and both buffers are zeroed before they are freed. It is never
//! logged and never crosses IPC. The connection is `CONNECT_TEMPORARY`: nothing is remembered
//! past logoff, so Trove adds no saved credential the person did not choose in the box itself.

/// `ERROR_ACCESS_DENIED`.
pub const ACCESS_DENIED: i32 = 5;
/// `ERROR_LOGON_FAILURE`: unknown user name or bad password.
pub const LOGON_FAILURE: i32 = 1326;
/// `ERROR_SESSION_CREDENTIAL_CONFLICT`: already connected to that server as someone else.
#[cfg_attr(not(windows), allow(dead_code))] // only Windows connects; tested everywhere
const CREDENTIAL_CONFLICT: i32 = 1219;
/// `ERROR_CANCELLED`, what the credential box answers to Cancel.
#[cfg(windows)]
const CANCELLED: u32 = 1223;

/// The share to sign in to for `path`, or `None` when a credential box would not help: not a
/// UNC path, or a WSL distro (`\\wsl.localhost` is this machine; it has no password).
pub fn sign_in_target(path: &str) -> Option<String> {
    let root = crate::core::mounts::share_root(path)?;
    let host = root.trim_start_matches('\\').split('\\').next()?;
    (!crate::core::mounts::is_wsl_host(host)).then_some(root)
}

/// Whether an OS error code is one a user name and password could fix.
pub fn wants_credentials(code: Option<i32>) -> bool {
    matches!(code, Some(ACCESS_DENIED | LOGON_FAILURE))
}

/// What `sign_in` did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(not(windows), allow(dead_code))] // only Windows signs in; tested everywhere
pub enum SignIn {
    /// Connected; list the share again.
    Connected,
    /// The person closed the box.
    Cancelled,
}

/// The plain-words message for a `WNetAddConnection2W` failure.
#[cfg_attr(not(windows), allow(dead_code))] // only Windows connects; tested everywhere
pub fn connect_error_message(share: &str, code: i32) -> String {
    match code {
        LOGON_FAILURE => format!("{share}: the user name or password is wrong"),
        ACCESS_DENIED => format!("{share}: that account may not open this share"),
        CREDENTIAL_CONFLICT => format!(
            "{share}: Windows is already connected to this server as another user; \
             disconnect it first (net use)"
        ),
        _ => format!(
            "{share}: could not connect ({})",
            std::io::Error::from_raw_os_error(code)
        ),
    }
}

/// Shows the Windows credential box for `share` over `owner` and connects with what was
/// typed. `last_error` is the code the listing failed with, so the box can say why it asks.
#[cfg(windows)]
pub fn sign_in(share: &str, owner: isize, last_error: i32) -> Result<SignIn, String> {
    use std::ffi::c_void;
    use windows_sys::Win32::NetworkManagement::WNet::{
        WNetAddConnection2W, CONNECT_TEMPORARY, NETRESOURCEW, RESOURCETYPE_DISK,
    };
    use windows_sys::Win32::Security::Credentials::{
        CredUIPromptForWindowsCredentialsW, CredUnPackAuthenticationBufferW, CREDUIWIN_GENERIC,
        CREDUI_INFOW,
    };
    use windows_sys::Win32::System::Com::CoTaskMemFree;

    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain([0]).collect() };
    let caption = wide("Trove");
    let message = wide(&format!("Enter a user name and password for {share}"));
    let info = CREDUI_INFOW {
        cbSize: std::mem::size_of::<CREDUI_INFOW>() as u32,
        hwndParent: owner as _,
        pszMessageText: message.as_ptr(),
        pszCaptionText: caption.as_ptr(),
        hbmBanner: std::ptr::null_mut(),
    };
    let mut package = 0u32;
    let mut out: *mut c_void = std::ptr::null_mut();
    let mut out_len = 0u32;
    // SAFETY: every pointer is to a live local; `out` is allocated by the call and freed below.
    let asked = unsafe {
        CredUIPromptForWindowsCredentialsW(
            &info,
            u32::try_from(last_error).unwrap_or(0),
            &mut package,
            std::ptr::null(),
            0,
            &mut out,
            &mut out_len,
            std::ptr::null_mut(),
            CREDUIWIN_GENERIC,
        )
    };
    if asked == CANCELLED {
        return Ok(SignIn::Cancelled);
    }
    if asked != 0 {
        return Err(connect_error_message(share, asked as i32));
    }

    let mut user = vec![0u16; 514];
    let mut domain = vec![0u16; 338];
    let mut password = vec![0u16; 514];
    let (mut user_len, mut domain_len, mut password_len) = (514u32, 338u32, 514u32);
    // SAFETY: the buffers are as long as the lengths passed; `out`/`out_len` come from the box.
    let unpacked = unsafe {
        CredUnPackAuthenticationBufferW(
            0,
            out,
            out_len,
            user.as_mut_ptr(),
            &mut user_len,
            domain.as_mut_ptr(),
            &mut domain_len,
            password.as_mut_ptr(),
            &mut password_len,
        )
    };
    // SAFETY: `out` holds `out_len` bytes the box allocated; zeroed, then freed once.
    unsafe {
        zero(out.cast::<u8>(), out_len as usize);
        CoTaskMemFree(out);
    }
    if unpacked == 0 {
        zero_vec(&mut password);
        return Err(format!("{share}: could not read what was typed"));
    }

    let mut remote = wide(share);
    let resource = NETRESOURCEW {
        dwScope: 0,
        dwType: RESOURCETYPE_DISK,
        dwDisplayType: 0,
        dwUsage: 0,
        lpLocalName: std::ptr::null_mut(),
        lpRemoteName: remote.as_mut_ptr(),
        lpComment: std::ptr::null_mut(),
        lpProvider: std::ptr::null_mut(),
    };
    // SAFETY: `resource` points at `remote`, and `user` / `password` are NUL-terminated by
    // CredUnPackAuthenticationBufferW; all outlive the call.
    let code = unsafe {
        WNetAddConnection2W(
            &resource,
            password.as_ptr(),
            user.as_ptr(),
            CONNECT_TEMPORARY,
        )
    };
    zero_vec(&mut password);
    if code == 0 {
        log::info!("net: signed in to a share");
        Ok(SignIn::Connected)
    } else {
        log::warn!("net: sign-in to a share failed, code {code}");
        Err(connect_error_message(share, code as i32))
    }
}

#[cfg(not(windows))]
pub fn sign_in(share: &str, _owner: isize, _last_error: i32) -> Result<SignIn, String> {
    Err(format!("{share}: signing in to a share is Windows only"))
}

/// Overwrites `len` bytes at `p` in a way the optimiser may not drop.
///
/// # Safety
/// `p` must be valid for `len` byte writes.
#[cfg(windows)]
unsafe fn zero(p: *mut u8, len: usize) {
    for i in 0..len {
        // SAFETY: in bounds by the caller's promise
        unsafe { std::ptr::write_volatile(p.add(i), 0) };
    }
}

#[cfg(windows)]
fn zero_vec(v: &mut [u16]) {
    for c in v.iter_mut() {
        // SAFETY: `c` is a valid, aligned `&mut u16`
        unsafe { std::ptr::write_volatile(c, 0) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_real_shares_get_a_sign_in() {
        assert_eq!(
            sign_in_target(r"\\nas\media\film").as_deref(),
            Some(r"\\nas\media")
        );
        assert_eq!(
            sign_in_target("//10.0.0.5/backup").as_deref(),
            Some(r"\\10.0.0.5\backup")
        );
        assert_eq!(sign_in_target(r"\\wsl.localhost\Ubuntu\home"), None);
        assert_eq!(sign_in_target(r"\\wsl$\Ubuntu"), None);
        assert_eq!(sign_in_target(r"\\nas"), None);
        assert_eq!(sign_in_target(r"C:\Users"), None);
    }

    #[test]
    fn access_denied_and_logon_failure_want_credentials() {
        assert!(wants_credentials(Some(5)));
        assert!(wants_credentials(Some(1326)));
        assert!(!wants_credentials(Some(2)));
        assert!(!wants_credentials(Some(53)));
        assert!(!wants_credentials(None));
    }

    #[test]
    fn connect_errors_are_plain_words() {
        let s = r"\\nas\media";
        assert_eq!(
            connect_error_message(s, 1326),
            r"\\nas\media: the user name or password is wrong"
        );
        assert!(connect_error_message(s, 1219).contains("another user"));
        assert!(connect_error_message(s, 53).starts_with(r"\\nas\media: could not connect ("));
    }

    #[test]
    fn sign_in_answers_serialise_for_the_frontend() {
        assert_eq!(
            serde_json::to_string(&SignIn::Connected).unwrap(),
            "\"connected\""
        );
        assert_eq!(
            serde_json::to_string(&SignIn::Cancelled).unwrap(),
            "\"cancelled\""
        );
    }
}
