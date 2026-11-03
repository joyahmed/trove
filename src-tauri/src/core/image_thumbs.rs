//! Image thumbnails decoded in Rust, for the systems with no shell to ask (plan 14.2). macOS
//! and Linux reach this through `thumbs.rs`'s non-Windows `shell_image_rgba`; the bytes then go
//! through the same PNG encoder, memory LRU and disk cache as Windows' shell thumbnails, so a
//! photo folder is decoded once and read back after that.
//!
//! ⛔ Release builds are `panic = "abort"` (`Cargo.toml`): a decoder panic would end the app and
//! `catch_unwind` cannot stop it there. So everything that could make a decode huge or slow is
//! refused **before** the pixel buffer exists — the file's size from its metadata, the image's
//! dimensions and decoded size from its header. `catch_unwind` below only keeps a dev build's
//! pool worker alive.
//!
//! Not decoded here, so they keep their drawn glyph: SVG (needs a rasteriser), HEIC/HEIF, AVIF,
//! camera RAW, PSD, ICO/ICNS and TIFF (TIFF alone would add six crates; plan 14.2.1). On a Mac
//! `thumbnail_of_file` hands HEIC/HEIF, AVIF, TIFF and video to QuickLook (`quicklook.rs`).
//!
//! Compiled into the app off Windows only; compiled into tests everywhere (see `Cargo.toml`'s
//! dev-dependency), so `cargo test` on Windows checks the decoder as well.
#![cfg_attr(all(windows, test), allow(dead_code))]

use std::io::Cursor;
use std::path::Path;

use image::imageops::FilterType;
use image::{DynamicImage, ImageDecoder, ImageReader, Limits};

/// What this decoder can read, by lower-case extension. ⛔ The frontend keeps the same list
/// (`src/lib/utils/file-icon.ts`, `DECODED_THUMBNAIL_EXTS`) and a test there reads this line to
/// keep the two equal — a file the frontend asks about but Rust refuses costs a wasted read; one
/// Rust could draw but the frontend never asks about is a glyph where a picture belongs.
pub const DECODABLE_EXTS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

/// The largest file read at all. A phone photo is 2–12 MB; a 64 MB still image is a scan or a
/// panorama, and reading more than this per tile is what makes a folder crawl.
pub const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// The most pixels decoded: 50 MP holds every phone camera's full-size output (48 MP is
/// 8000 × 6000) and refuses the 100 MP scans and stitched panoramas that would take seconds.
pub const MAX_PIXELS: u64 = 50_000_000;

/// The most bytes the decoded image may take before shrinking. Two slow-lane slots decode at
/// once (`workers.rs`), so this is at most twice over; a 48 MP RGB JPEG is 144 MB and passes.
pub const MAX_DECODED_BYTES: u64 = 256 * 1024 * 1024;

/// How much bigger than the target the fast pre-shrink stops: from there Lanczos3 does the
/// last step at a cost that no longer grows with the photo's size.
const PRESHRINK_FACTOR: u32 = 4;

/// Whether `path`'s extension is one this decoder reads (case-insensitive).
pub fn is_decodable(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| DECODABLE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
}

/// The thumbnail of the file at `path`, fitted to `size` × `size`, as (width, height, RGBA rows
/// top-down). `None` for an extension not in `DECODABLE_EXTS`, a file over `MAX_FILE_BYTES`, a
/// missing file, or anything the decoder refuses.
pub fn thumbnail_rgba_of_file(path: &Path, size: u32) -> Option<(u32, u32, Vec<u8>)> {
    thumbnail_of_file(path, size).ok()
}

/// Why a file gave no thumbnail — what decides whether `icons.rs` may remember the miss.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoThumbnail {
    /// Not read, or not read in full: an extension not in the list, over the cap, missing, a
    /// read error (an iCloud or Dropbox placeholder not downloaded yet), or a length different
    /// from the one the file reported (still being written). Next time can differ.
    NotRead,
    /// Read in full and refused by the decoder. `FileStamp` is the file as it was read.
    Undecodable(super::icons::FileStamp),
}

/// `thumbnail_rgba_of_file`, saying why when there is none.
/// On a Mac, HEIC, TIFF and video go to QuickLook instead (`quicklook.rs`), which hands back
/// the same RGBA and the same `NoThumbnail` reasons.
pub fn thumbnail_of_file(path: &Path, size: u32) -> Result<(u32, u32, Vec<u8>), NoThumbnail> {
    #[cfg(target_os = "macos")]
    if super::quicklook::is_quicklook_kind(path) {
        return super::quicklook::thumbnail_of_file(path, size);
    }
    thumbnail_of_file_capped(path, size, MAX_FILE_BYTES)
}

fn thumbnail_of_file_capped(
    path: &Path,
    size: u32,
    max_file_bytes: u64,
) -> Result<(u32, u32, Vec<u8>), NoThumbnail> {
    if !is_decodable(path) {
        return Err(NoThumbnail::NotRead);
    }
    let meta = std::fs::metadata(path).map_err(|_| NoThumbnail::NotRead)?;
    if !meta.is_file() || meta.len() > max_file_bytes {
        return Err(NoThumbnail::NotRead);
    }
    let stamp = super::icons::file_stamp(&meta).ok_or(NoThumbnail::NotRead)?;
    let bytes = std::fs::read(path).map_err(|_| NoThumbnail::NotRead)?;
    if bytes.len() as u64 != stamp.len {
        return Err(NoThumbnail::NotRead);
    }
    decode_to_rgba(&bytes, size).ok_or(NoThumbnail::Undecodable(stamp))
}

/// `decode_to_rgba`, encoded as a PNG (alpha kept) — what the `icon://` route ends up serving.
/// Test-only: the app goes through `thumbs::shell_image_sized`, which encodes the RGBA itself.
#[cfg(test)]
pub fn decode_to_thumbnail(bytes: &[u8], size: u32) -> Option<Vec<u8>> {
    let (w, h, rgba) = decode_to_rgba(bytes, size)?;
    super::icons::encode_png(w, h, &rgba)
}

/// Decode an image file's bytes and fit it within `size` × `size`, keeping its aspect ratio and
/// never enlarging it. EXIF orientation applied; an animation gives its first frame. `None` for
/// anything unreadable, truncated, unsupported or over the limits.
pub fn decode_to_rgba(bytes: &[u8], size: u32) -> Option<(u32, u32, Vec<u8>)> {
    if size == 0 || bytes.is_empty() {
        return None;
    }
    std::panic::catch_unwind(|| decode_inner(bytes, size))
        .ok()
        .flatten()
}

fn decode_inner(bytes: &[u8], size: u32) -> Option<(u32, u32, Vec<u8>)> {
    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_DECODED_BYTES);
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    reader.limits(limits);
    let is_jpeg = reader.format() == Some(image::ImageFormat::Jpeg);
    if is_jpeg && !jpeg_is_complete(bytes) {
        return None;
    }
    let mut decoder = reader.into_decoder().ok()?;
    let (w, h) = decoder.dimensions();
    if w == 0
        || h == 0
        || u64::from(w) * u64::from(h) > MAX_PIXELS
        || decoder.total_bytes() > MAX_DECODED_BYTES
    {
        return None;
    }
    // read before the decode consumes the decoder; a missing or odd tag is "no rotation"
    let orientation = decoder.orientation().ok();
    // A JPEG is first tried small (`jpeg_small`); anything that path does not take — 16-bit,
    // CMYK, a file it refuses — gets the full decode, which reads them all.
    let small_jpeg = if is_jpeg {
        jpeg_small(bytes, size, w, h)
    } else {
        None
    };
    let image = match small_jpeg {
        Some(image) => image,
        None => DynamicImage::from_decoder(decoder).ok()?,
    };
    // Shrink first, rotate after: the box is square, so the fitted size is the same either way,
    // and rotating a 256 px thumbnail is free where rotating the 48 MP original is a copy.
    let mut small = fit_within(image, size);
    if let Some(o) = orientation {
        small.apply_orientation(o);
    }
    let rgba = small.into_rgba8();
    let (tw, th) = rgba.dimensions();
    Some((tw, th, rgba.into_raw()))
}

/// Whether a JPEG's last scan ends in an end-of-image marker. The decoder forgives a file cut
/// mid-scan and fills the rest gray, which would show as a blank box where the drawn glyph
/// belongs. Entropy data stuffs every `FF` as `FF 00`, so after the last start-of-scan (`FF DA`)
/// an `FF D9` can only be the real end; looking after the LAST scan skips the one inside an
/// EXIF thumbnail. Bytes after the end marker (padding, trailers) are fine.
fn jpeg_is_complete(bytes: &[u8]) -> bool {
    let Some(sos) = bytes.windows(2).rposition(|w| w == [0xFF, 0xDA]) else {
        return false;
    };
    bytes[sos..].windows(2).any(|w| w == [0xFF, 0xD9])
}

/// A JPEG's own pixels decoded no bigger than they must be for a `size` box: 1/1, 1/2, 1/4 or
/// 1/8 scale straight from the DCT, the smallest that keeps the long side at least `size`. A
/// 24 MP photo for the 256 box is 750 × 500 pixels this way, where the full decode built all
/// 24 million and then threw them away (`image` decodes JPEG through zune-jpeg, which has no
/// scaled decode). `None` sends the caller to the full decode.
///
/// ⛔ Never the embedded EXIF thumbnail, however fast: an edited or redacted photo can keep
/// the thumbnail of what it was before (a cropped-out face, a blurred plate), and the grid
/// would show the old picture.
///
/// `w` × `h` is the photo's size from zune's reading of the header, already checked against
/// the limits. jpeg-decoder parses the header again on its own, so a file the two read
/// differently (a second frame header, say) is refused here: the limits were checked on
/// zune's numbers, and they must be the numbers this decode runs on.
///
/// 16-bit and CMYK are `None`, for the full decode. The format is read from the buffer's
/// length, not `Decoder::info`, which panics on a precision the parser lets through for
/// lossless JPEGs; the full size comes from `scale` for the same reason.
///
/// ⚠️ jpeg-decoder starts one worker thread per colour component for any output wider than
/// 128 px (its `multithreaded.rs`; `rayon` is off here), so one decode can briefly run up to
/// four threads beside the slow lane's two slots. 0.3.2 has no switch for that: its
/// single-thread worker is chosen only on wasm, and `PreferWorkerKind` is private. The threads
/// live for that one decode, a 1/8 decode is tens of milliseconds, and pinning it would mean
/// forking the crate.
fn jpeg_small(bytes: &[u8], size: u32, w: u32, h: u32) -> Option<DynamicImage> {
    if progressive_coefficient_bytes(bytes)? > MAX_DECODED_BYTES {
        return None;
    }
    let mut decoder = jpeg_decoder::Decoder::new(bytes);
    decoder.set_max_decoding_buffer_size(MAX_DECODED_BYTES as usize);
    // the largest request is answered with scale 1/1, i.e. the full size the header gives
    let (fw, fh) = decoder.scale(u16::MAX, u16::MAX).ok()?;
    if (u32::from(fw), u32::from(fh)) != (w, h) {
        return None;
    }
    let side = u16::try_from(size).ok()?;
    let (sw, sh) = decoder.scale(side, side).ok()?;
    let pixels = decoder.decode().ok()?;
    let (sw, sh) = (u32::from(sw), u32::from(sh));
    let area = sw as usize * sh as usize;
    if pixels.len() == area {
        image::GrayImage::from_raw(sw, sh, pixels).map(DynamicImage::ImageLuma8)
    } else if pixels.len() == area * 3 {
        image::RgbImage::from_raw(sw, sh, pixels).map(DynamicImage::ImageRgb8)
    } else {
        None
    }
}

/// The bytes jpeg-decoder holds for a JPEG's DCT coefficients before it draws a pixel: 0 for
/// a sequential (baseline) JPEG, which it decodes a row of blocks at a time. A progressive one
/// keeps every block of the full-size image — 64 `i16` per 8 × 8 block, per component, rounded
/// up to whole MCUs as its `update_component_sizes` does — whatever scale it is asked for, and
/// its own size limit looks only at the output. So a 50 MP progressive 4:4:4 photo would take
/// ~300 MB here; `jpeg_small` refuses that up front, before any of it is allocated.
///
/// Read from the frame header (SOF) by walking the markers; `None` when there is none before
/// the first scan or the header is cut short.
fn progressive_coefficient_bytes(bytes: &[u8]) -> Option<u64> {
    let be16 = |at: usize| -> Option<u32> {
        let b = bytes.get(at..at.checked_add(2)?)?;
        Some(u32::from(u16::from_be_bytes([b[0], b[1]])))
    };
    let mut at = 2; // after SOI
    loop {
        if *bytes.get(at)? != 0xFF {
            return None;
        }
        let marker = *bytes.get(at + 1)?;
        match marker {
            // fill byte, or a marker with no length
            0xFF => at += 1,
            0x01 | 0xD0..=0xD7 => at += 2,
            0xDA => return None, // a scan before any frame header
            0xC0..=0xCF if !matches!(marker, 0xC4 | 0xC8 | 0xCC) => {
                if !matches!(marker, 0xC2 | 0xC6 | 0xCA | 0xCE) {
                    return Some(0);
                }
                let sof = at + 4; // P, Y, X, Nf, then Nf × (C, HV, Tq)
                let (h, w) = (be16(sof + 1)?, be16(sof + 3)?);
                let n = usize::from(*bytes.get(sof + 5)?);
                let factors: Vec<(u32, u32)> = (0..n)
                    .map(|i| {
                        let hv = *bytes.get(sof + 6 + i * 3 + 1)?;
                        Some((u32::from(hv >> 4).max(1), u32::from(hv & 15).max(1)))
                    })
                    .collect::<Option<_>>()?;
                let h_max = factors.iter().map(|f| f.0).max()?;
                let v_max = factors.iter().map(|f| f.1).max()?;
                let (mcus_x, mcus_y) = (
                    u64::from(w.div_ceil(h_max * 8)),
                    u64::from(h.div_ceil(v_max * 8)),
                );
                let blocks: u64 = factors
                    .iter()
                    .map(|&(hf, vf)| mcus_x * u64::from(hf) * mcus_y * u64::from(vf))
                    .sum();
                return Some(blocks * 64 * 2);
            }
            _ => at = at.checked_add(2)?.checked_add(be16(at + 2)? as usize)?,
        }
    }
}

/// Fit `image` within `size` × `size`: as is when it already fits (never enlarged), else a fast
/// area-average pre-shrink to `PRESHRINK_FACTOR` × the target, then Lanczos3.
fn fit_within(image: DynamicImage, size: u32) -> DynamicImage {
    let (w, h) = (image.width(), image.height());
    if w <= size && h <= size {
        return image;
    }
    let pre = size.saturating_mul(PRESHRINK_FACTOR);
    let image = if w > pre || h > pre {
        image.thumbnail(pre, pre)
    } else {
        image
    };
    image.resize(size, size, FilterType::Lanczos3)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::codecs::gif::GifEncoder;
    use image::codecs::jpeg::JpegEncoder;
    use image::codecs::webp::WebPEncoder;
    use image::{
        ExtendedColorType, Frame, GenericImageView, ImageEncoder, ImageFormat, Rgba, RgbaImage,
    };

    fn encode(img: &RgbaImage, format: ImageFormat) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(img.clone())
            .write_to(&mut out, format)
            .unwrap();
        out.into_inner()
    }

    fn png(w: u32, h: u32, px: [u8; 4]) -> Vec<u8> {
        encode(&RgbaImage::from_pixel(w, h, Rgba(px)), ImageFormat::Png)
    }

    fn decoded(png_bytes: &[u8]) -> RgbaImage {
        image::load_from_memory_with_format(png_bytes, ImageFormat::Png)
            .unwrap()
            .into_rgba8()
    }

    #[test]
    fn a_small_image_is_never_enlarged() {
        let (w, h, rgba) = decode_to_rgba(&png(2, 2, [10, 20, 30, 255]), 256).unwrap();
        assert_eq!((w, h), (2, 2));
        assert_eq!(&rgba[..4], &[10, 20, 30, 255]);
        // exactly the size asked for is also left alone
        assert_eq!(decode_to_rgba(&png(48, 48, [0; 4]), 48).unwrap().0, 48);
    }

    #[test]
    fn a_big_image_fits_the_box_and_keeps_its_aspect() {
        let src = png(300, 200, [200, 100, 50, 255]);
        for (size, want) in [(256, (256, 171)), (96, (96, 64)), (48, (48, 32))] {
            let (w, h, rgba) = decode_to_rgba(&src, size).unwrap();
            assert_eq!((w, h), want, "at {size}");
            assert_eq!(rgba.len(), (w * h * 4) as usize);
        }
        // tall too, and through the pre-shrink (2000 > 4 × 48)
        let (w, h, _) = decode_to_rgba(&png(500, 2000, [1, 2, 3, 255]), 48).unwrap();
        assert_eq!((w, h), (12, 48));
    }

    #[test]
    fn the_png_out_is_a_whole_png_the_cache_accepts() {
        let out = decode_to_thumbnail(&png(300, 200, [9, 9, 9, 255]), 96).unwrap();
        assert!(out.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(out.ends_with(b"\0\0\0\0IEND\xAE\x42\x60\x82"));
        assert_eq!(decoded(&out).dimensions(), (96, 64));
    }

    #[test]
    fn transparency_survives_and_no_backdrop_is_painted() {
        // left half clear, right half opaque red
        let img = RgbaImage::from_fn(200, 100, |x, _| {
            if x < 100 {
                Rgba([0, 0, 0, 0])
            } else {
                Rgba([255, 0, 0, 255])
            }
        });
        let out = decode_to_thumbnail(&encode(&img, ImageFormat::Png), 48).unwrap();
        let t = decoded(&out);
        assert_eq!(t.dimensions(), (48, 24));
        assert_eq!(t.get_pixel(2, 12)[3], 0, "the clear side stays clear");
        assert_eq!(t.get_pixel(45, 12).0, [255, 0, 0, 255]);
    }

    /// A JPEG of `w` × `h`, left half red and right half blue, with an EXIF APP1 segment that
    /// carries only `Orientation = orientation`. Built by hand: the encoder writes no EXIF.
    fn jpeg_with_orientation(w: u32, h: u32, orientation: u16) -> Vec<u8> {
        let rgb: Vec<u8> = (0..w * h)
            .flat_map(|i| {
                if i % w < w / 2 {
                    [255, 0, 0]
                } else {
                    [0, 0, 255]
                }
            })
            .collect();
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, 95)
            .write_image(&rgb, w, h, ExtendedColorType::Rgb8)
            .unwrap();
        // TIFF header (little-endian), one IFD with one SHORT entry: 0x0112 Orientation.
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"II\x2a\x00");
        tiff.extend_from_slice(&8u32.to_le_bytes());
        tiff.extend_from_slice(&1u16.to_le_bytes());
        tiff.extend_from_slice(&0x0112u16.to_le_bytes());
        tiff.extend_from_slice(&3u16.to_le_bytes());
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&orientation.to_le_bytes());
        tiff.extend_from_slice(&[0, 0]);
        tiff.extend_from_slice(&0u32.to_le_bytes());
        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(&tiff);
        let mut app1 = vec![0xFF, 0xE1];
        app1.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        app1.extend_from_slice(&payload);
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8]);
        let mut out = jpeg[..2].to_vec();
        out.extend_from_slice(&app1);
        out.extend_from_slice(&jpeg[2..]);
        out
    }

    #[test]
    fn a_phone_photo_is_turned_the_way_its_exif_says() {
        // Orientation 6: the sensor was held sideways; show it turned 90° clockwise.
        let (w, h, rgba) = decode_to_rgba(&jpeg_with_orientation(64, 32, 6), 256).unwrap();
        assert_eq!((w, h), (32, 64), "landscape pixels, portrait photo");
        let t = RgbaImage::from_raw(w, h, rgba).unwrap();
        // turned clockwise, the left (red) half is now the top
        let top = t.get_pixel(16, 4);
        let bottom = t.get_pixel(16, 60);
        assert!(top[0] > 200 && top[2] < 60, "top is red: {top:?}");
        assert!(
            bottom[2] > 200 && bottom[0] < 60,
            "bottom is blue: {bottom:?}"
        );
        // and with no tag it is left as it was
        let (w, h, _) = decode_to_rgba(&jpeg_with_orientation(64, 32, 1), 256).unwrap();
        assert_eq!((w, h), (64, 32));
    }

    fn solid_jpeg(w: u32, h: u32, rgb: [u8; 3]) -> Vec<u8> {
        let pixels: Vec<u8> = (0..w * h).flat_map(|_| rgb).collect();
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, 90)
            .write_image(&pixels, w, h, ExtendedColorType::Rgb8)
            .unwrap();
        jpeg
    }

    /// `jpeg` with an EXIF APP1 whose second IFD holds `thumb` — the layout cameras write.
    fn jpeg_with_exif_thumbnail(jpeg: &[u8], thumb: &[u8]) -> Vec<u8> {
        // header (8), IFD0 with no entries (2 + 4), IFD1 with two entries (2 + 24 + 4), thumb
        let mut tiff = b"II\x2a\x00".to_vec();
        tiff.extend_from_slice(&8u32.to_le_bytes());
        tiff.extend_from_slice(&0u16.to_le_bytes());
        tiff.extend_from_slice(&14u32.to_le_bytes());
        tiff.extend_from_slice(&2u16.to_le_bytes());
        for (tag, value) in [(0x0201u16, 44u32), (0x0202, thumb.len() as u32)] {
            tiff.extend_from_slice(&tag.to_le_bytes());
            tiff.extend_from_slice(&4u16.to_le_bytes());
            tiff.extend_from_slice(&1u32.to_le_bytes());
            tiff.extend_from_slice(&value.to_le_bytes());
        }
        tiff.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(tiff.len(), 44);
        tiff.extend_from_slice(thumb);
        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(&tiff);
        let mut out = jpeg[..2].to_vec();
        out.extend_from_slice(&[0xFF, 0xE1]);
        out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        out.extend_from_slice(&payload);
        out.extend_from_slice(&jpeg[2..]);
        out
    }

    /// A gray photo whose EXIF block still holds a blue thumbnail of the same shape and big
    /// enough for the box — what an edited or redacted photo looks like when the editor kept
    /// the old thumbnail. The grid must show the photo as it is now: gray.
    #[test]
    fn the_photo_s_own_pixels_are_used_never_its_exif_thumbnail() {
        let mut gray = Vec::new();
        JpegEncoder::new_with_quality(&mut gray, 90)
            .write_image(&vec![128u8; 600 * 400], 600, 400, ExtendedColorType::L8)
            .unwrap();
        let stale = jpeg_with_exif_thumbnail(&gray, &solid_jpeg(300, 200, [0, 0, 255]));
        for (size, want) in [(256, (256, 171)), (96, (96, 64)), (48, (48, 32))] {
            let (w, h, rgba) = decode_to_rgba(&stale, size).unwrap();
            assert_eq!((w, h), want, "at {size}");
            let [r, g, b, _] = rgba[..4] else {
                unreachable!()
            };
            assert!(
                r.abs_diff(128) < 8 && g.abs_diff(128) < 8 && b.abs_diff(128) < 8,
                "gray at {size}, not the thumbnail's blue: {:?}",
                &rgba[..4]
            );
        }
    }

    /// jpeg-decoder reads the header itself; when its size is not the one the limits were
    /// checked on, the scaled path steps aside and the checked full decode answers.
    #[test]
    fn a_size_the_two_decoders_disagree_on_leaves_the_scaled_path() {
        let jpeg = gradient_jpeg(800, 600);
        assert!(jpeg_small(&jpeg, 256, 800, 600).is_some());
        assert!(jpeg_small(&jpeg, 256, 801, 600).is_none());
        assert!(jpeg_small(&jpeg, 256, 800, 599).is_none());
    }

    /// The big JPEG goes through the scaled decode, not the full one: `jpeg_small` answers it
    /// at 1/8 scale (2400 / 8 = 300, still over 256).
    #[test]
    fn a_big_jpeg_is_decoded_at_a_fraction_of_its_size() {
        let jpeg = gradient_jpeg(2400, 1600);
        let small = jpeg_small(&jpeg, 256, 2400, 1600).expect("the scaled path");
        assert_eq!(small.dimensions(), (300, 200));
        let small = jpeg_small(&jpeg, 48, 2400, 1600).unwrap();
        assert_eq!(small.dimensions(), (300, 200));
        // a gray JPEG takes it too
        let mut gray = Vec::new();
        JpegEncoder::new_with_quality(&mut gray, 90)
            .write_image(&vec![128u8; 640 * 480], 640, 480, ExtendedColorType::L8)
            .unwrap();
        assert_eq!(
            jpeg_small(&gray, 96, 640, 480).unwrap().dimensions(),
            (160, 120)
        );
        assert_eq!(decode_to_rgba(&gray, 96).unwrap().0, 96);
    }

    #[test]
    fn an_animated_gif_gives_its_first_frame() {
        let red = RgbaImage::from_pixel(8, 8, Rgba([255, 0, 0, 255]));
        let blue = RgbaImage::from_pixel(8, 8, Rgba([0, 0, 255, 255]));
        let mut gif = Vec::new();
        {
            let mut enc = GifEncoder::new(&mut gif);
            enc.encode_frames(vec![Frame::new(red), Frame::new(blue)])
                .unwrap();
        }
        let (w, h, rgba) = decode_to_rgba(&gif, 48).unwrap();
        assert_eq!((w, h), (8, 8));
        assert!(rgba[0] > 200 && rgba[2] < 60, "the first frame, red");
    }

    #[test]
    fn webp_and_bmp_decode() {
        let img = RgbaImage::from_pixel(120, 60, Rgba([0, 128, 0, 255]));
        let mut webp = Vec::new();
        WebPEncoder::new_lossless(&mut webp)
            .write_image(img.as_raw(), 120, 60, ExtendedColorType::Rgba8)
            .unwrap();
        assert_eq!(decode_to_rgba(&webp, 48).unwrap().0, 48);
        let bmp = encode(&img, ImageFormat::Bmp);
        let (w, h, _) = decode_to_rgba(&bmp, 48).unwrap();
        assert_eq!((w, h), (48, 24));
    }

    #[test]
    fn garbage_and_empty_bytes_are_no_thumbnail_not_a_panic() {
        assert!(decode_to_rgba(b"", 96).is_none());
        assert!(decode_to_rgba(b"this is not an image at all", 96).is_none());
        assert!(decode_to_rgba(&[0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3], 96).is_none());
        assert!(decode_to_rgba(&png(4, 4, [1; 4]), 0).is_none());
    }

    #[test]
    fn a_truncated_png_is_no_thumbnail() {
        let full = png(64, 64, [50, 60, 70, 255]);
        for cut in [8, 33, full.len() / 2, full.len() - 13] {
            assert!(
                decode_to_rgba(&full[..cut], 48).is_none(),
                "cut at {cut} of {}",
                full.len()
            );
        }
    }

    /// The JPEG decoder is lenient: a file cut mid-scan decodes "fine" with the rest filled gray,
    /// which showed as a blank box instead of the drawn glyph (Mac run, 2026-10-02).
    #[test]
    fn a_truncated_jpeg_is_no_thumbnail() {
        let mut full = Vec::new();
        let rgb: Vec<u8> = (0..64u32 * 64)
            .flat_map(|i| [(i % 251) as u8, (i % 127) as u8, (i % 61) as u8])
            .collect();
        JpegEncoder::new_with_quality(&mut full, 90)
            .write_image(&rgb, 64, 64, ExtendedColorType::Rgb8)
            .unwrap();
        assert!(
            decode_to_rgba(&full, 48).is_some(),
            "the whole file decodes"
        );
        for cut in [
            full.len() / 2,
            full.len() * 3 / 4,
            full.len() - 2,
            full.len() - 1,
        ] {
            assert!(
                decode_to_rgba(&full[..cut], 48).is_none(),
                "cut at {cut} of {}",
                full.len()
            );
        }
        // a whole JPEG with junk after its end marker is still a photo
        let mut padded = full.clone();
        padded.extend_from_slice(&[0, 0, 0, 0]);
        assert!(decode_to_rgba(&padded, 48).is_some());
        // an orientation-tagged one is whole too
        assert!(decode_to_rgba(&jpeg_with_orientation(64, 32, 6), 256).is_some());
    }

    /// A `w` × `h` JPEG of a photo-like RGB gradient. ⚠️ The pixels are built a row at a time
    /// (once per 8-row band, the rest copies): per pixel, 24 million closure calls in our
    /// unoptimized test crate took most of a 6.3 s test. Encoding costs ~0.13 µs a pixel even
    /// optimized (3.1 s at 24 MP), which is why the size here is the caller's choice.
    fn gradient_jpeg(w: u32, h: u32) -> Vec<u8> {
        let (wu, hu) = (w as usize, h as usize);
        let mut rgb = Vec::with_capacity(wu * hu * 3);
        let mut row = Vec::with_capacity(wu * 3);
        for y in 0..hu {
            if y % 8 == 0 {
                row.clear();
                row.extend(
                    (0..wu).flat_map(|x| [(x / 24) as u8, (y / 16) as u8, ((x + y) / 40) as u8]),
                );
            }
            rgb.extend_from_slice(&row);
        }
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, 85)
            .write_image(&rgb, w, h, ExtendedColorType::Rgb8)
            .unwrap();
        jpeg
    }

    /// `decode_to_rgba(jpeg, size)`, timed and printed (`-- --nocapture`).
    fn timed_thumbnail(jpeg: &[u8], size: u32, label: &str) -> (u32, u32, Vec<u8>) {
        let started = std::time::Instant::now();
        let out = decode_to_rgba(jpeg, size).unwrap();
        println!(
            "{label} JPEG ({} KB) -> {}x{} in {} ms",
            jpeg.len() / 1024,
            out.0,
            out.1,
            started.elapsed().as_millis()
        );
        out
    }

    /// A camera-sized photo comes out fitted to the gallery's box at every size the grid asks
    /// for, through the pre-shrink (2400 > 4 × 256). 4 MP keeps the test under a second; the
    /// 24 MP timing is the ignored test below.
    #[test]
    fn a_big_photo_becomes_a_gallery_thumbnail() {
        let jpeg = gradient_jpeg(2400, 1600);
        for (size, want) in [(256, (256, 171)), (96, (96, 64)), (48, (48, 32))] {
            let (tw, th, rgba) = timed_thumbnail(&jpeg, size, "2400x1600");
            assert_eq!((tw, th), want, "at {size}");
            assert_eq!(rgba.len(), (tw * th * 4) as usize);
        }
    }

    /// The time a 24 MP camera photo (6000 × 4000) takes, for `cargo test --release
    /// a_24_megapixel -- --ignored --nocapture`. Ignored by default: building the JPEG alone
    /// takes 3 s. On the Mac a debug build took 600–1650 ms per photo before the image crates
    /// were optimized in dev builds (`Cargo.toml`, `[profile.dev.package.*]`). Release on a Windows
    /// PC: 114 / 78 / 73 ms for 256 / 96 / 48 with the full decode, 57-62 / 59-61 / 52 ms
    /// decoded at 1/8 scale (`jpeg_small`, its header-size check included); this gradient JPEG
    /// is 680 KB, a real 24 MP photo 5-10 MB.
    #[test]
    #[ignore = "a timing, not a check: building the 24 MP JPEG takes 3 s"]
    fn a_24_megapixel_photo_becomes_a_gallery_thumbnail() {
        let jpeg = gradient_jpeg(6000, 4000);
        for size in [256, 96, 48, 256] {
            let (tw, th, _) = timed_thumbnail(&jpeg, size, "6000x4000");
            assert_eq!(tw, size);
            assert_eq!(th, (size * 2 + 1) / 3);
        }
        // off Windows the 48 and 96 come from the cached 256 PNG (`icons::render`)
        let (w, h, rgba) = decode_to_rgba(&jpeg, 256).unwrap();
        let png = super::super::icons::encode_png(w, h, &rgba).unwrap();
        let started = std::time::Instant::now();
        assert_eq!(decode_to_rgba(&png, 48).unwrap().0, 48);
        println!(
            "48 from the 256 PNG in {} us",
            started.elapsed().as_micros()
        );
    }

    /// A PNG whose header claims `w` × `h` and which holds no pixels: what a hostile or broken
    /// file looks like to a decoder that trusts its header.
    fn png_header_only(w: u32, h: u32) -> Vec<u8> {
        let mut ihdr = b"IHDR".to_vec();
        ihdr.extend_from_slice(&w.to_be_bytes());
        ihdr.extend_from_slice(&h.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit RGBA
        let crc = crc32(&ihdr);
        let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
        out.extend_from_slice(&13u32.to_be_bytes());
        out.extend_from_slice(&ihdr);
        out.extend_from_slice(&crc.to_be_bytes());
        out.extend_from_slice(b"\0\0\0\0IEND\xAE\x42\x60\x82");
        out
    }

    fn crc32(bytes: &[u8]) -> u32 {
        let mut c = 0xFFFF_FFFFu32;
        for &b in bytes {
            c ^= u32::from(b);
            for _ in 0..8 {
                c = if c & 1 != 0 {
                    0xEDB8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
        }
        !c
    }

    #[test]
    fn a_header_claiming_a_huge_image_is_refused_before_anything_is_allocated() {
        let started = std::time::Instant::now();
        // 3.6 billion pixels, 14 GB decoded: refused from the header
        assert!(decode_to_rgba(&png_header_only(60_000, 60_000), 96).is_none());
        // just over the pixel cap (8000 × 6251 > 50 MP) — refused too
        assert!(decode_to_rgba(&png_header_only(8000, 6251), 96).is_none());
        assert!(
            started.elapsed() < std::time::Duration::from_secs(1),
            "refused at once, not after trying"
        );
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "trove-imgthumbs-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_the_listed_extensions_are_read_any_case() {
        assert!(is_decodable(Path::new("/a/b.JPG")));
        assert!(is_decodable(Path::new("/a/b.webp")));
        for no in [
            "b.heic", "b.svg", "b.avif", "b.tiff", "b.mp4", "b.psd", "README", ".png",
        ] {
            assert!(!is_decodable(Path::new(no)), "{no}");
        }
        // a real PNG named .heic is still not read: the list is the contract with the frontend
        let dir = scratch("ext");
        let heic = dir.join("x.heic");
        std::fs::write(&heic, png(4, 4, [1; 4])).unwrap();
        assert!(thumbnail_rgba_of_file(&heic, 48).is_none());
        let real = dir.join("x.PNG");
        std::fs::write(&real, png(4, 4, [1; 4])).unwrap();
        assert_eq!(thumbnail_rgba_of_file(&real, 48).unwrap().0, 4);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// SOI and a frame header of `w` × `h` with three 1×1 components, as `marker` (C0 baseline,
    /// C2 progressive) — all `progressive_coefficient_bytes` reads.
    fn frame_header(marker: u8, w: u16, h: u16) -> Vec<u8> {
        let mut out = vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0]; // an APP0 to step over
        out.extend_from_slice(&[0xFF, marker, 0, 17, 8]);
        out.extend_from_slice(&h.to_be_bytes());
        out.extend_from_slice(&w.to_be_bytes());
        out.push(3);
        for id in 1..=3 {
            out.extend_from_slice(&[id, 0x11, 0]);
        }
        out
    }

    /// A progressive JPEG keeps every coefficient of the full-size image whatever the scale,
    /// so a big one is refused before jpeg-decoder allocates them.
    #[test]
    fn a_progressive_jpeg_too_big_for_its_coefficients_is_refused_up_front() {
        // 8000 × 6000, 4:4:4: 1000 × 750 blocks × 3 × 128 bytes = 288 MB
        let big = frame_header(0xC2, 8000, 6000);
        assert_eq!(progressive_coefficient_bytes(&big), Some(288_000_000));
        assert!(jpeg_small(&big, 256, 8000, 6000).is_none());
        // the same size sequential holds no coefficients; a small progressive one fits
        assert_eq!(
            progressive_coefficient_bytes(&frame_header(0xC0, 8000, 6000)),
            Some(0)
        );
        assert_eq!(
            progressive_coefficient_bytes(&frame_header(0xC2, 4000, 3000)),
            Some(72_000_000)
        );
        // 4:2:0 rounds to whole 16 × 16 MCUs: 2 × 2 luma blocks and one of each chroma
        let mut sub = frame_header(0xC2, 17, 17);
        let luma = sub.len() - 8;
        sub[luma] = 0x22;
        assert_eq!(progressive_coefficient_bytes(&sub), Some(4 * 6 * 128));
        // cut short, or no frame header at all
        assert_eq!(progressive_coefficient_bytes(&big[..big.len() - 4]), None);
        assert_eq!(
            progressive_coefficient_bytes(&[0xFF, 0xD8, 0xFF, 0xDA]),
            None
        );
        assert_eq!(progressive_coefficient_bytes(b""), None);
        // a real (baseline) JPEG still takes the scaled path
        assert_eq!(
            progressive_coefficient_bytes(&gradient_jpeg(64, 48)),
            Some(0)
        );
    }

    /// Only a file read in full and refused by the decoder is `Undecodable`, with the length
    /// it was read at: a half-written JPEG is one, and the finished file is a different stamp.
    #[test]
    fn a_miss_says_whether_the_file_was_read_in_full() {
        let dir = scratch("why");
        let file = dir.join("half.jpg");
        let whole = gradient_jpeg(64, 48);
        std::fs::write(&file, &whole[..whole.len() / 2]).unwrap();
        match thumbnail_of_file(&file, 48) {
            Err(NoThumbnail::Undecodable(stamp)) => {
                assert_eq!(stamp.len, (whole.len() / 2) as u64)
            }
            other => panic!("want Undecodable, got {:?}", other.map(|t| (t.0, t.1))),
        }
        std::fs::write(&file, &whole).unwrap();
        assert!(thumbnail_of_file(&file, 48).is_ok());
        assert_eq!(
            thumbnail_of_file(&dir.join("gone.jpg"), 48).err(),
            Some(NoThumbnail::NotRead)
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_file_over_the_cap_is_not_even_read() {
        let dir = scratch("cap");
        let file = dir.join("big.png");
        let bytes = png(64, 64, [1, 2, 3, 255]);
        std::fs::write(&file, &bytes).unwrap();
        let len = bytes.len() as u64;
        assert!(thumbnail_of_file_capped(&file, 48, len).is_ok());
        assert_eq!(
            thumbnail_of_file_capped(&file, 48, len - 1).err(),
            Some(NoThumbnail::NotRead)
        );
        // a missing file and a folder named like an image
        assert!(thumbnail_rgba_of_file(&dir.join("gone.png"), 48).is_none());
        let folder = dir.join("album.png");
        std::fs::create_dir_all(&folder).unwrap();
        assert!(thumbnail_rgba_of_file(&folder, 48).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
