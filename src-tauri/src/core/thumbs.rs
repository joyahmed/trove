//! Big icons and thumbnails from the shell — `IShellItemImageFactory::GetImage`, the call
//! Explorer itself makes for its Large / Extra large views and Gallery. An icon-only request
//! gives the association's icon at any size (folders included, `desktop.ini` honoured); a
//! thumbnail request gives the file's own picture for images, video, PDF, Office, falling
//! back to the icon. The HBITMAP is read out with GDI and encoded to PNG once; caching lives
//! in `icons.rs` next to the small icons. No tauri types here.

use std::path::Path;

/// What to ask the shell for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageMode {
    /// The association's (or folder's) icon, scaled by the shell to `size`.
    IconOnly,
    /// The file's own thumbnail when the shell has a handler for it, else the icon.
    ThumbnailOrIcon,
}

/// The three sizes the grid offers: Medium, Large, Extra large (Explorer's names).
pub const BIG_SIZES: [u32; 3] = [48, 96, 256];

/// Anything else snaps to the nearest of the three.
pub fn clamp_big(size: u32) -> u32 {
    *BIG_SIZES
        .iter()
        .min_by_key(|&&s| s.abs_diff(size))
        .expect("three sizes")
}

/// `thumb/<path>` / `big/<path>` → the mode, or `None` for another key.
pub fn mode_of(key: &str) -> Option<(ImageMode, &str)> {
    if let Some(p) = key.strip_prefix("thumb/") {
        return (!p.is_empty()).then_some((ImageMode::ThumbnailOrIcon, p));
    }
    if let Some(p) = key.strip_prefix("big/") {
        return (!p.is_empty()).then_some((ImageMode::IconOnly, p));
    }
    None
}

/// The PNG for `path` at `size` (one of `BIG_SIZES`), or `None` when the shell has nothing
/// (a missing file, an unsupported format, off Windows).
#[cfg_attr(not(test), allow(dead_code))]
pub fn shell_image(path: &Path, size: u32, mode: ImageMode) -> Option<Vec<u8>> {
    shell_image_sized(path, clamp_big(size), mode)
}

/// `shell_image` at exactly the size asked for, for the callers that do not snap to `BIG_SIZES`
/// — the palette's app rows want 16 and 32, and `GetImage` is happy to give them.
///
/// ⚠️ `path` is whatever `SHCreateItemFromParsingName` accepts, which is **not** only a file:
/// `shell:AppsFolder\<aumid>` resolves to a Store app's tile icon this way, and that is the
/// only way to draw the 86 rows on this machine that have no `.lnk` to take an icon from.
pub fn shell_image_sized(path: &Path, size: u32, mode: ImageMode) -> Option<Vec<u8>> {
    shell_image_checked(path, size, mode).map(|(png, _)| png)
}

/// `shell_image_sized` that also says whether the picture is the real answer to the request.
/// `false` is a thumbnail request the shell could not fill — a file still open for writing, a
/// handler that failed — and answered with the association icon instead. That icon is fine to
/// draw now but is not the file's thumbnail, so nothing may remember it (B.5.5).
pub fn shell_image_checked(path: &Path, size: u32, mode: ImageMode) -> Option<(Vec<u8>, bool)> {
    let (w, h, rgba, real) = shell_image_rgba(path, size, mode)?;
    super::icons::encode_png(w, h, &rgba).map(|png| (png, real))
}

#[cfg(windows)]
fn shell_image_rgba(path: &Path, size: u32, mode: ImageMode) -> Option<(u32, u32, Vec<u8>, bool)> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK, SIIGBF_ICONONLY,
        SIIGBF_THUMBNAILONLY,
    };

    super::icons::ensure_com();
    let name = HSTRING::from(path.as_os_str());
    // SAFETY: `name` is a valid NUL-terminated wide string for the call's duration; a null
    // bind context is allowed; the returned interface is a plain COM pointer we own.
    let item: IShellItemImageFactory = unsafe { SHCreateItemFromParsingName(&name, None) }.ok()?;
    let sz = SIZE {
        cx: size as i32,
        cy: size as i32,
    };
    let get = |flags| {
        // SAFETY: `item` is a live IShellItemImageFactory; GetImage returns an HBITMAP we own.
        unsafe { item.GetImage(sz, flags) }.ok()
    };
    let (hbm, real) = match mode {
        ImageMode::IconOnly => (get(SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK)?, true),
        ImageMode::ThumbnailOrIcon => match get(SIIGBF_THUMBNAILONLY) {
            Some(hbm) => (hbm, true),
            None => (get(SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK)?, false),
        },
    };
    let out = super::icons::bitmap_to_rgba(hbm.0 as _);
    // SAFETY: GetImage hands the caller ownership of the bitmap; delete it exactly once.
    unsafe {
        let _ = windows::Win32::Graphics::Gdi::DeleteObject(hbm.into());
    }
    out.map(|(w, h, rgba)| (w, h, rgba, real))
}

/// Off Windows there is no shell (plan 14.2): an image file is decoded in Rust, and the icon
/// modes stay empty — folders and non-image files draw their SVG / category glyph in the
/// frontend, which never asks `big/` there.
#[cfg(not(windows))]
fn shell_image_rgba(path: &Path, size: u32, mode: ImageMode) -> Option<(u32, u32, Vec<u8>, bool)> {
    match mode {
        ImageMode::ThumbnailOrIcon => super::image_thumbs::thumbnail_rgba_of_file(path, size)
            .map(|(w, h, rgba)| (w, h, rgba, true)),
        ImageMode::IconOnly => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_snap_to_the_three_the_grid_offers() {
        assert_eq!(clamp_big(40), 48);
        assert_eq!(clamp_big(64), 48);
        assert_eq!(clamp_big(100), 96);
        assert_eq!(clamp_big(200), 256);
        assert_eq!(clamp_big(1000), 256);
    }

    #[test]
    fn keys_name_their_mode() {
        assert_eq!(
            mode_of(r"thumb/C:\a.png"),
            Some((ImageMode::ThumbnailOrIcon, r"C:\a.png"))
        );
        assert_eq!(mode_of(r"big/C:\a"), Some((ImageMode::IconOnly, r"C:\a")));
        assert_eq!(mode_of("thumb/"), None);
        assert_eq!(mode_of("ext/txt"), None);
    }

    /// Off Windows the `thumb/` mode is the Rust decoder and the icon mode is empty (plan 14.2).
    #[cfg(not(windows))]
    #[test]
    fn off_windows_a_photo_is_decoded_and_the_icon_modes_stay_empty() {
        let dir = scratch("decode");
        let file = dir.join("photo.png");
        let mut bytes = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut bytes, 300, 200);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            let mut w = enc.write_header().unwrap();
            w.write_image_data(&[90u8; 300 * 200 * 4]).unwrap();
            w.finish().unwrap();
        }
        std::fs::write(&file, &bytes).unwrap();
        let thumb =
            shell_image(&file, 96, ImageMode::ThumbnailOrIcon).expect("a decoded thumbnail");
        let info = png::Decoder::new(std::io::Cursor::new(thumb))
            .read_info()
            .unwrap()
            .info()
            .clone();
        assert_eq!((info.width, info.height), (96, 64));
        assert!(shell_image(&file, 96, ImageMode::IconOnly).is_none());
        let note = dir.join("note.txt");
        std::fs::write(&note, "not a picture").unwrap();
        assert!(shell_image(&note, 96, ImageMode::ThumbnailOrIcon).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "trove-thumbs-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(windows)]
    #[test]
    fn a_text_file_has_a_big_icon() {
        let dir = scratch("txt");
        let file = dir.join("note.txt");
        std::fs::write(&file, "hi").unwrap();
        let png = shell_image(&file, 96, ImageMode::IconOnly).expect("the shell draws a .txt icon");
        assert!(png.starts_with(b"\x89PNG"));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// ⭐ The evidence the grid's Medium size rests on. Real Explorer draws the file's own
    /// picture from Medium icons (48) up and the association icon at 16 — measured on this
    /// machine against a folder of wallpapers, an MP4 and a PDF. This is the headless half of
    /// that measurement: at 48 the shell really does hand back a *thumbnail*, not the icon, so
    /// `thumb/<path>?size=48` is a picture and not a repaint of `ext/png`.
    #[cfg(windows)]
    #[test]
    fn the_shell_has_a_real_thumbnail_at_the_grids_medium_size() {
        let dir = scratch("medium");
        let file = dir.join("block.png");
        let mut bytes = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut bytes, 128, 128);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            let mut w = enc.write_header().unwrap();
            let px: Vec<u8> = (0..128 * 128).flat_map(|_| [255u8, 0, 255, 255]).collect();
            w.write_image_data(&px).unwrap();
            w.finish().unwrap();
        }
        std::fs::write(&file, &bytes).unwrap();
        let thumb = shell_image(&file, 48, ImageMode::ThumbnailOrIcon).expect("a 48 px thumbnail");
        let icon = shell_image(&file, 48, ImageMode::IconOnly).expect("a 48 px icon");
        assert!(thumb.starts_with(b"\x89PNG") && icon.starts_with(b"\x89PNG"));
        assert_ne!(
            thumb, icon,
            "at 48 the shell must give the file's own picture, not the .png association icon"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// No blank holes: a file the shell has no thumbnail handler for still draws — `GetImage`
    /// falls back to `SIIGBF_ICONONLY` inside the same call, so the tile gets the association
    /// icon at the tile's own size rather than a 404 and an empty box.
    #[cfg(windows)]
    #[test]
    fn a_file_with_no_thumbnail_falls_back_to_its_icon() {
        let dir = scratch("fallback");
        let file = dir.join("note.zzqq");
        std::fs::write(&file, "nothing renders this").unwrap();
        let thumb =
            shell_image(&file, 48, ImageMode::ThumbnailOrIcon).expect("the icon, not nothing");
        let icon = shell_image(&file, 48, ImageMode::IconOnly).expect("the icon");
        assert!(thumb.starts_with(b"\x89PNG"));
        assert_eq!(thumb, icon, "the fallback is the icon itself");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn a_small_png_gets_a_thumbnail() {
        let dir = scratch("png");
        let file = dir.join("dot.png");
        let mut bytes = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut bytes, 4, 4);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            let mut w = enc.write_header().unwrap();
            w.write_image_data(&[200u8; 4 * 4 * 4]).unwrap();
            w.finish().unwrap();
        }
        std::fs::write(&file, &bytes).unwrap();
        let png =
            shell_image(&file, 96, ImageMode::ThumbnailOrIcon).expect("a thumbnail or the icon");
        assert!(png.starts_with(b"\x89PNG"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
