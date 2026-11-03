//! macOS only: thumbnails from QuickLook (`QLThumbnailGenerator`) for the kinds the Rust
//! decoders in `image_thumbs.rs` cannot read — HEIC/HEIF, AVIF, TIFF and video. On Windows the
//! shell draws all of these; off Windows they had only a "no preview" label (8efbe8d).
//!
//! The result is plain RGBA, so it goes through the same PNG encoder, memory LRU and disk cache
//! (and the same 48/96/256 size keys) as a decoded photo: `icons.rs` `render_photo` asks
//! `image_thumbs::thumbnail_of_file`, which routes here by extension.
//!
//! Threads: this runs on an `icons.rs` slow-lane worker (two at most, `workers.rs`), never on
//! the main thread. QuickLook calls its completion handler on a queue of its own, which sends
//! the pixels down a channel; the worker waits at most `WAIT` and then cancels the request, so a
//! wedged QuickLook extension costs a worker three seconds, not forever. A handler that fires
//! after the wait finds the channel closed and its pixels are dropped.
//!
//! An app bundle (`Calculator.app`, a folder) gets QuickLook's *icon* representation the same way:
//! many modern apps keep their icon only in `Assets.car`, which no Rust crate reads, so a glyph
//! was all Trove drew. QuickLook reads the asset catalog (or the `.icns`) as Finder does.

use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::autoreleasepool;
use objc2::AllocAnyThread;
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo, CGImageByteOrderInfo,
};
use objc2_foundation::NSError;
use objc2_quick_look_thumbnailing::{
    QLThumbnailGenerationRequest, QLThumbnailGenerationRequestRepresentationTypes,
    QLThumbnailGenerator, QLThumbnailRepresentation,
};

use super::image_thumbs::{NoThumbnail, MAX_PIXELS};

/// What QuickLook draws here that the Rust decoders do not, by lower-case extension. ⛔ The
/// frontend keeps the same list (`src/lib/utils/file-icon.ts`, `QUICKLOOK_THUMBNAIL_EXTS`) and a
/// test there reads this line. Only kinds QuickLook was seen to thumbnail on macOS 27: WebM,
/// MKV and AVI give no thumbnail, so they keep the glyph and the "no preview" label.
pub const QUICKLOOK_EXTS: [&str; 8] = ["heic", "heif", "avif", "tif", "tiff", "mov", "mp4", "m4v"];

/// The longest a worker waits for QuickLook. A HEIC takes tens of milliseconds and a video's
/// first frame a few hundred; past this the request is cancelled and the tile keeps its glyph.
const WAIT: Duration = Duration::from_secs(3);

/// Whether `path`'s extension is one QuickLook draws here (case-insensitive), an app included.
pub fn is_quicklook_kind(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| QUICKLOOK_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        || is_app_bundle_name(path)
}

/// `X.app` by name (any case); whether it is a folder is checked against the disk later.
fn is_app_bundle_name(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("app"))
        && path.file_stem().is_some_and(|s| !s.is_empty())
}

/// The QuickLook thumbnail of the file at `path`, fitted to `size` × `size`, as (width, height,
/// RGBA rows top-down, straight alpha) — what `image_thumbs::thumbnail_of_file` returns.
///
/// A timeout, a missing file or one not stamped is `NotRead` (try again later); a file QuickLook
/// looked at and could not draw is `Undecodable`, which `icons.rs` remembers once it has settled.
/// For an app bundle (a folder) the picture is the app's icon.
pub fn thumbnail_of_file(path: &Path, size: u32) -> Result<(u32, u32, Vec<u8>), NoThumbnail> {
    if size == 0 || !is_quicklook_kind(path) {
        return Err(NoThumbnail::NotRead);
    }
    let meta = std::fs::metadata(path).map_err(|_| NoThumbnail::NotRead)?;
    let app = is_app_bundle_name(path);
    if (app && !meta.is_dir()) || (!app && !meta.is_file()) {
        return Err(NoThumbnail::NotRead);
    }
    let stamp = super::icons::file_stamp(&meta).ok_or(NoThumbnail::NotRead)?;
    let kind = if app {
        QLThumbnailGenerationRequestRepresentationTypes::Icon
    } else {
        QLThumbnailGenerationRequestRepresentationTypes::Thumbnail
    };
    // QuickLook draws a symlink as the link (a generic document), not its target: Safari in
    // `/Applications` is a link into `/System/Cryptexes/App/...` on recent macOS. Ask for the
    // file the link names; a path that cannot be resolved is asked for as given.
    let target = std::fs::canonicalize(path);
    let path = target.as_deref().unwrap_or(path);
    match generate(path, size, kind) {
        Outcome::Drawn(px) => Ok(px),
        Outcome::Refused => Err(NoThumbnail::Undecodable(stamp)),
        Outcome::TimedOut => {
            log::warn!("quicklook thumbnail timed out after {}s", WAIT.as_secs());
            log::debug!("quicklook thumbnail timed out: {}", path.display());
            Err(NoThumbnail::NotRead)
        }
    }
}

enum Outcome {
    Drawn((u32, u32, Vec<u8>)),
    Refused,
    TimedOut,
}

fn generate(
    path: &Path,
    size: u32,
    kind: QLThumbnailGenerationRequestRepresentationTypes,
) -> Outcome {
    let Some(path_str) = path.to_str() else {
        return Outcome::Refused;
    };
    autoreleasepool(|_| {
        // an archive member's path (NUL inside) or an empty one has no URL: refuse, never abort
        let Some(url) = crate::core::open_with_mac::file_url(Path::new(path_str)) else {
            return Outcome::Refused;
        };
        let box_size = CGSize::new(f64::from(size), f64::from(size));
        // SAFETY: a fresh allocation initialised once with a valid file URL; scale 1 asks for
        // `size` pixels, not points. One kind only: a file's generic icon is not a preview.
        let request = unsafe {
            QLThumbnailGenerationRequest::initWithFileAtURL_size_scale_representationTypes(
                QLThumbnailGenerationRequest::alloc(),
                &url,
                box_size,
                1.0,
                kind,
            )
        };
        let (tx, rx) = mpsc::sync_channel::<Option<(u32, u32, Vec<u8>)>>(1);
        let handler = RcBlock::new(
            move |rep: *mut QLThumbnailRepresentation, _err: *mut NSError| {
                // SAFETY: QuickLook passes a valid representation or nil, alive for the call.
                let px = unsafe { rep.as_ref() }.and_then(|rep| {
                    // SAFETY: every representation carries its CGImage.
                    let image = unsafe { rep.CGImage() };
                    rgba_of(&image, size)
                });
                // the worker may have given up (`WAIT`): then nobody listens, which is fine
                let _ = tx.try_send(px);
            },
        );
        // SAFETY: the shared generator is thread-safe; the request and the block are retained
        // by QuickLook until the handler has run.
        let generator = unsafe { QLThumbnailGenerator::sharedGenerator() };
        unsafe {
            generator.generateBestRepresentationForRequest_completionHandler(&request, &handler)
        };
        match rx.recv_timeout(WAIT) {
            Ok(Some(px)) => Outcome::Drawn(px),
            Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => Outcome::Refused,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // SAFETY: cancelling a request that is running or already done is allowed.
                unsafe { generator.cancelRequest(&request) };
                Outcome::TimedOut
            }
        }
    })
}

/// `image` drawn into an RGBA buffer that fits `size` × `size` (aspect kept, never enlarged),
/// alpha un-premultiplied as the PNG encoder expects.
fn rgba_of(image: &CGImage, size: u32) -> Option<(u32, u32, Vec<u8>)> {
    let (iw, ih) = (CGImage::width(Some(image)), CGImage::height(Some(image)));
    if iw == 0 || ih == 0 || (iw as u64).saturating_mul(ih as u64) > MAX_PIXELS {
        return None;
    }
    let (w, h) = fit(iw as u32, ih as u32, size);
    let stride = w as usize * 4;
    let mut buf = vec![0u8; stride * h as usize];
    let space = CGColorSpace::new_device_rgb()?;
    let info = CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0;
    // SAFETY: `buf` holds exactly `stride * h` bytes and outlives the context, which is dropped
    // at the end of this function; 8 bits per component and 4 per pixel match `info`.
    let ctx: objc2_core_foundation::CFRetained<CGContext> = unsafe {
        CGBitmapContextCreate(
            buf.as_mut_ptr().cast(),
            w as usize,
            h as usize,
            8,
            stride,
            Some(&space),
            info,
        )
    }?;
    let rect = CGRect::new(
        CGPoint::new(0.0, 0.0),
        CGSize::new(f64::from(w), f64::from(h)),
    );
    CGContext::draw_image(Some(&ctx), rect, Some(image));
    drop(ctx);
    unpremultiply(&mut buf);
    Some((w, h, buf))
}

/// `w` × `h` fitted inside `size` × `size`, aspect kept, never enlarged, never below 1 px.
fn fit(w: u32, h: u32, size: u32) -> (u32, u32) {
    if w <= size && h <= size {
        return (w, h);
    }
    let scale = f64::from(size) / f64::from(w.max(h));
    let side = |v: u32| ((f64::from(v) * scale).round() as u32).clamp(1, size);
    (side(w), side(h))
}

fn unpremultiply(rgba: &mut [u8]) {
    for px in rgba.as_chunks_mut::<4>().0 {
        let a = u32::from(px[3]);
        if a != 0 && a != 255 {
            for c in &mut px[..3] {
                *c = ((u32::from(*c) * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    #[test]
    fn heic_tiff_and_video_go_to_quicklook_any_case() {
        for name in [
            "a.heic", "a.HEIC", "a.heif", "a.avif", "a.tif", "a.TIFF", "a.mov", "a.MP4", "a.m4v",
        ] {
            assert!(is_quicklook_kind(Path::new(name)), "{name}");
        }
    }

    #[test]
    fn an_app_bundle_goes_to_quicklook_by_name() {
        assert!(is_quicklook_kind(Path::new(
            "/System/Applications/Calculator.app"
        )));
        assert!(is_quicklook_kind(Path::new("/Applications/X.APP")));
        assert!(!is_quicklook_kind(Path::new("/a/.app")));
        assert!(!is_quicklook_kind(Path::new("/a/app")));
    }

    /// Calculator: QuickLook draws the app icon (from `Assets.car` or `.icns`, as Finder does).
    #[test]
    fn quicklook_draws_an_asset_catalog_app_icon() {
        let calc = Path::new("/System/Applications/Calculator.app");
        assert_thumbnail(calc, 256);
        assert_thumbnail(calc, 48);
        // a file named like an app is not one
        let dir = scratch("fakeapp");
        let fake = dir.join("Fake.app");
        std::fs::write(&fake, b"x").unwrap();
        assert_eq!(thumbnail_of_file(&fake, 256), Err(NoThumbnail::NotRead));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn what_rust_decodes_or_quicklook_cannot_draw_stays_out() {
        for name in [
            "a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.bmp", "a.webm", "a.mkv", "a.avi",
            "a.svg", "heic", ".heic", "a.txt",
        ] {
            assert!(!is_quicklook_kind(Path::new(name)), "{name}");
        }
    }

    #[test]
    fn the_two_lists_never_overlap() {
        for e in QUICKLOOK_EXTS {
            assert!(
                !super::super::image_thumbs::DECODABLE_EXTS.contains(&e),
                "{e}"
            );
        }
    }

    #[test]
    fn fit_keeps_the_aspect_and_never_enlarges() {
        assert_eq!(fit(100, 50, 256), (100, 50));
        assert_eq!(fit(1024, 512, 256), (256, 128));
        assert_eq!(fit(300, 4000, 96), (7, 96));
        assert_eq!(fit(5000, 1, 48), (48, 1));
    }

    #[test]
    fn unpremultiply_restores_straight_alpha() {
        let mut px = [64, 32, 0, 128, 10, 20, 30, 255, 9, 9, 9, 0];
        unpremultiply(&mut px);
        assert_eq!(px, [128, 64, 0, 128, 10, 20, 30, 255, 9, 9, 9, 0]);
    }

    #[test]
    fn a_missing_file_or_another_kind_is_not_read() {
        let missing = std::env::temp_dir().join("trove-ql-missing-file.heic");
        assert_eq!(thumbnail_of_file(&missing, 256), Err(NoThumbnail::NotRead));
        assert_eq!(
            thumbnail_of_file(Path::new("/etc/hosts"), 256),
            Err(NoThumbnail::NotRead)
        );
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("trove-ql-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A 640 × 400 JPEG, so a HEIC and a TIFF can be made from it with `sips`, which every Mac
    /// ships.
    fn jpeg(dir: &Path) -> PathBuf {
        let img = image::RgbImage::from_fn(640, 400, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 160])
        });
        let file = dir.join("source.jpg");
        img.save(&file).unwrap();
        file
    }

    fn sips(src: &Path, format: &str, out: &Path) {
        let ok = Command::new("sips")
            .args(["-s", "format", format])
            .arg(src)
            .arg("--out")
            .arg(out)
            .output()
            .expect("sips runs")
            .status
            .success();
        assert!(ok, "sips made {}", out.display());
    }

    fn assert_thumbnail(file: &Path, size: u32) {
        let started = std::time::Instant::now();
        let (w, h, rgba) = thumbnail_of_file(file, size)
            .unwrap_or_else(|e| panic!("{} gave no thumbnail: {e:?}", file.display()));
        eprintln!(
            "quicklook {} at {size}px: {w}x{h} in {} ms",
            file.display(),
            started.elapsed().as_millis()
        );
        assert!(
            w <= size && h <= size && (w == size || h == size),
            "{w}x{h} in {size}"
        );
        assert_eq!(rgba.len(), (w * h * 4) as usize);
        assert!(
            rgba.as_chunks::<4>().0.iter().any(|p| p[0] > 0 || p[1] > 0),
            "not all black"
        );
        // the bytes the cache stores
        assert!(super::super::icons::encode_png(w, h, &rgba).is_some());
    }

    /// QuickLook runs out of process over XPC; no window server is needed, so this is not
    /// `#[ignore]`d. It fails loudly if a future macOS stops drawing these.
    #[test]
    fn quicklook_draws_a_heic_and_a_tiff() {
        let dir = scratch("still");
        let src = jpeg(&dir);
        let heic = dir.join("photo.heic");
        let tiff = dir.join("scan.tiff");
        sips(&src, "heic", &heic);
        sips(&src, "tiff", &tiff);
        for size in [256, 96, 48] {
            assert_thumbnail(&heic, size);
        }
        assert_thumbnail(&tiff, 256);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A two-second test clip made with `ffmpeg` (Homebrew; `avconvert` needs a movie to start
    /// from), or `None` on a Mac without it. `codec` empty takes ffmpeg's default for the name.
    fn ffmpeg_clip(dir: &Path, name: &str, codec: &[&str]) -> Option<PathBuf> {
        let out = dir.join(name);
        Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi"])
            .args(["-i", "testsrc=size=640x400:rate=25", "-t", "2"])
            .args(codec)
            .arg(&out)
            .output()
            .is_ok_and(|o| o.status.success() && out.exists())
            .then_some(out)
    }

    #[test]
    fn quicklook_draws_a_movie_frame() {
        let dir = scratch("movie");
        let codec = ["-c:v", "h264_videotoolbox", "-pix_fmt", "yuv420p"];
        let Some(mov) = ffmpeg_clip(&dir, "clip.mov", &codec) else {
            eprintln!("no ffmpeg to make a movie with; skipped");
            return;
        };
        assert_thumbnail(&mov, 256);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A WebM, which QuickLook does not thumbnail here (`qlmanage -t` hangs on one; the generator refuses it), comes back
    /// within the wait instead of holding a worker. That is why it is not in `QUICKLOOK_EXTS`.
    #[test]
    fn a_kind_quicklook_cannot_draw_comes_back_within_the_wait() {
        let dir = scratch("webm");
        let Some(webm) = ffmpeg_clip(&dir, "clip.webm", &[]) else {
            eprintln!("no ffmpeg to make a webm with; skipped");
            return;
        };
        let started = std::time::Instant::now();
        let out = generate(
            &webm,
            256,
            QLThumbnailGenerationRequestRepresentationTypes::Thumbnail,
        );
        let took = started.elapsed();
        let what = match out {
            Outcome::Drawn(_) => "drawn",
            Outcome::Refused => "refused",
            Outcome::TimedOut => "timed out",
        };
        eprintln!("webm: {what} in {} ms", took.as_millis());
        assert!(took < WAIT + Duration::from_millis(500), "{took:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A symlinked app draws its target's icon, not QuickLook's generic document for the link:
    /// the shape of Safari in `/Applications` on recent macOS.
    #[test]
    fn a_linked_app_draws_the_icon_of_the_app_it_names() {
        let calc = Path::new("/System/Applications/Calculator.app");
        let dir = scratch("linkedapp");
        let link = dir.join("Calculator.app");
        std::os::unix::fs::symlink(calc, &link).unwrap();
        assert_same_picture(
            &thumbnail_of_file(&link, 96).expect("the link draws"),
            &thumbnail_of_file(calc, 96).expect("the app draws"),
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Live probe on this Mac: `/Applications/Safari.app` (a link into the Cryptex on macOS 26+)
    /// draws the compass, the same picture as the bundle it names. Set `QL_PROBE_OUT` to a folder
    /// to also get both PNGs there to look at.
    #[test]
    #[ignore]
    fn live_probe_safari_draws_its_compass() {
        let link = Path::new("/Applications/Safari.app");
        let real = std::fs::canonicalize(link).unwrap();
        eprintln!("{} -> {}", link.display(), real.display());
        let via_link = thumbnail_of_file(link, 128).expect("Safari via /Applications");
        let direct = thumbnail_of_file(&real, 128).expect("Safari's bundle");
        if let Ok(out) = std::env::var("QL_PROBE_OUT") {
            for (name, (w, h, px)) in [("link", &via_link), ("real", &direct)] {
                let png = super::super::icons::encode_png(*w, *h, px).unwrap();
                std::fs::write(Path::new(&out).join(format!("safari-{name}.png")), png).unwrap();
            }
        }
        assert_same_picture(&via_link, &direct);
    }

    /// Two QuickLook draws of one icon: same size, and pixels within a small mean difference
    /// (a second draw of the same bundle is not always byte-identical). A generic document
    /// against an app's icon is far outside it.
    fn assert_same_picture(a: &(u32, u32, Vec<u8>), b: &(u32, u32, Vec<u8>)) {
        assert_eq!((a.0, a.1), (b.0, b.1), "same size");
        let diff: u64 =
            a.2.iter()
                .zip(&b.2)
                .map(|(x, y)| u64::from(x.abs_diff(*y)))
                .sum();
        let mean = diff as f64 / a.2.len() as f64;
        eprintln!("mean channel difference {mean:.2}");
        assert!(mean < 4.0, "mean channel difference {mean:.2}");
    }
}
