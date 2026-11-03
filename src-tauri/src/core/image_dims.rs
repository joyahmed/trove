//! An image's width and height from its header, for the Dimensions column. Nothing is decoded and
//! at most a few hundred bytes are read (a JPEG walks its marker segments, skipping over EXIF),
//! so a folder of photos costs a header each; TIFF and HEIF/AVIF keep their sizes in a table, so
//! those read up to `MAX_TABLE_READ`. Plain byte reading with no codec crate, so it is the same on
//! every OS. PNG, GIF, BMP, WebP, JPEG, TIFF, HEIC/HEIF and AVIF; anything else is `None` (a blank
//! cell).

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// A JPEG with more segments than this before its frame header is not worth walking.
const MAX_JPEG_SEGMENTS: usize = 256;

/// The most a TIFF IFD or a HEIF `meta` box is read to find the size: 64 KB.
const MAX_TABLE_READ: u64 = 64 * 1024;

/// A HEIF file whose `meta` box is not among its first this-many top-level boxes is not walked.
const MAX_HEIF_BOXES: usize = 32;

/// `ftyp` brands of a still HEIF image (HEVC, AV1 or plain MIAF).
const HEIF_BRANDS: [&[u8; 4]; 13] = [
    b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"hevm", b"hevs", b"mif1", b"mif2",
    b"msf1", b"avif", b"avis",
];

fn be16(b: &[u8]) -> u32 {
    u32::from(u16::from_be_bytes([b[0], b[1]]))
}

fn le16(b: &[u8]) -> u32 {
    u32::from(u16::from_le_bytes([b[0], b[1]]))
}

fn le32(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

fn le24(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], 0])
}

/// `(width, height)` of the image behind `r`, or `None` when it is not one of the formats above,
/// is cut short, or claims a zero side.
pub fn read_dimensions<R: Read + Seek>(r: &mut R) -> Option<(u32, u32)> {
    let mut head = [0u8; 32];
    let mut got = 0;
    while got < head.len() {
        match r.read(&mut head[got..]) {
            Ok(0) | Err(_) => break,
            Ok(n) => got += n,
        }
    }
    let head = &head[..got];
    let dims = if head.starts_with(b"\x89PNG\r\n\x1a\n") && got >= 24 {
        Some((be32(&head[16..20]), be32(&head[20..24])))
    } else if (head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a")) && got >= 10 {
        Some((le16(&head[6..8]), le16(&head[8..10])))
    } else if head.starts_with(b"BM") && got >= 26 {
        // BITMAPINFOHEADER: signed width and height; a negative height is a top-down bitmap
        let w = le32(&head[18..22]) as i32;
        let h = le32(&head[22..26]) as i32;
        Some((w.unsigned_abs(), h.unsigned_abs()))
    } else if head.starts_with(b"RIFF") && got >= 16 && &head[8..12] == b"WEBP" {
        webp(head)
    } else if head.starts_with(&[0xFF, 0xD8]) {
        jpeg(r)
    } else if (head.starts_with(b"II*\0") || head.starts_with(b"MM\0*")) && got >= 8 {
        tiff(r, head)
    } else if got >= 12 && &head[4..8] == b"ftyp" {
        heif(r)
    } else {
        None
    };
    dims.filter(|&(w, h)| w > 0 && h > 0)
}

fn be32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}

/// The three WebP flavours: lossy `VP8 `, lossless `VP8L`, extended `VP8X`.
fn webp(head: &[u8]) -> Option<(u32, u32)> {
    match head.get(12..16)? {
        b"VP8 " if head.get(23..26)? == [0x9D, 0x01, 0x2A] => {
            let (w, h) = (head.get(26..28)?, head.get(28..30)?);
            Some((le16(w) & 0x3FFF, le16(h) & 0x3FFF))
        }
        b"VP8L" if *head.get(20)? == 0x2F => {
            let bits = le32(head.get(21..25)?);
            Some(((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1))
        }
        b"VP8X" => Some((le24(head.get(24..27)?) + 1, le24(head.get(27..30)?) + 1)),
        _ => None,
    }
}

/// Walks the marker segments after SOI to the first frame header (SOF0-SOF15 except the DHT,
/// JPG and DAC markers), seeking over every other segment's payload.
fn jpeg<R: Read + Seek>(r: &mut R) -> Option<(u32, u32)> {
    r.seek(SeekFrom::Start(2)).ok()?;
    for _ in 0..MAX_JPEG_SEGMENTS {
        let mut b = [0u8; 1];
        // a marker is 0xFF then a non-0xFF, non-zero byte; extra 0xFF are padding
        loop {
            r.read_exact(&mut b).ok()?;
            if b[0] == 0xFF {
                break;
            }
        }
        let marker = loop {
            r.read_exact(&mut b).ok()?;
            if b[0] != 0xFF {
                break b[0];
            }
        };
        match marker {
            0x00 | 0x01 | 0xD0..=0xD7 => continue, // stuffed zero, TEM, RSTn: no payload
            0xD8..=0xDA => return None,
            _ => {}
        }
        let mut len = [0u8; 2];
        r.read_exact(&mut len).ok()?;
        let len = be16(&len) as usize;
        if len < 2 {
            return None;
        }
        if matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
            let mut sof = [0u8; 5]; // precision, height, width
            r.read_exact(&mut sof).ok()?;
            return Some((be16(&sof[3..5]), be16(&sof[1..3])));
        }
        r.seek(SeekFrom::Current(len as i64 - 2)).ok()?;
    }
    None
}

/// Reads IFD0's ImageWidth (256) and ImageLength (257) tags, SHORT or LONG, in the byte order the
/// header names. The IFD may sit anywhere (often after the pixels), so it is sought, not scanned.
fn tiff<R: Read + Seek>(r: &mut R, head: &[u8]) -> Option<(u32, u32)> {
    let le = head[0] == b'I';
    let u16_of = |b: &[u8]| if le { le16(b) } else { be16(b) };
    let u32_of = |b: &[u8]| if le { le32(b) } else { be32(b) };
    r.seek(SeekFrom::Start(u64::from(u32_of(&head[4..8]))))
        .ok()?;
    let mut n = [0u8; 2];
    r.read_exact(&mut n).ok()?;
    let count = (u16_of(&n) as usize).min(MAX_TABLE_READ as usize / 12);
    let mut ifd = vec![0u8; count * 12];
    r.read_exact(&mut ifd).ok()?;
    let (mut w, mut h) = (None, None);
    for e in ifd.as_chunks::<12>().0 {
        let value = match u16_of(&e[2..4]) {
            3 => u16_of(&e[8..10]),
            4 => u32_of(&e[8..12]),
            _ => continue,
        };
        match u16_of(&e[0..2]) {
            256 => w = Some(value),
            257 => h = Some(value),
            _ => {}
        }
    }
    Some((w?, h?))
}

fn be64(b: &[u8]) -> u64 {
    u64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])
}

/// The `(type, payload)` boxes laid end to end in `b`; stops at the first one that does not fit.
fn boxes(mut b: &[u8]) -> impl Iterator<Item = ([u8; 4], &[u8])> {
    std::iter::from_fn(move || {
        let kind: [u8; 4] = b.get(4..8)?.try_into().ok()?;
        let (start, size) = match be32(&b[0..4]) {
            0 => (8, b.len() as u64), // runs to the end of its parent
            1 => (16, be64(b.get(8..16)?)),
            s => (8, u64::from(s)),
        };
        if size < start as u64 || size > b.len() as u64 {
            return None;
        }
        let (this, rest) = b.split_at(size as usize);
        b = rest;
        Some((kind, &this[start..]))
    })
}

/// Walks the top-level boxes: `ftyp` must name a HEIF brand, then the `meta` box is read (at most
/// `MAX_TABLE_READ`) and its primary item's size taken.
fn heif<R: Read + Seek>(r: &mut R) -> Option<(u32, u32)> {
    let mut at = 0u64;
    for i in 0..MAX_HEIF_BOXES {
        r.seek(SeekFrom::Start(at)).ok()?;
        let mut hdr = [0u8; 16];
        r.read_exact(&mut hdr[..8]).ok()?;
        let (start, size) = match be32(&hdr[0..4]) {
            0 => (8, u64::MAX), // runs to the end of the file
            1 => {
                r.read_exact(&mut hdr[8..16]).ok()?;
                (16, be64(&hdr[8..16]))
            }
            s => (8, u64::from(s)),
        };
        if size < start {
            return None;
        }
        let mut body = Vec::new();
        let kind = &hdr[4..8];
        if i == 0 || kind == b"meta" {
            r.by_ref()
                .take((size - start).min(MAX_TABLE_READ))
                .read_to_end(&mut body)
                .ok()?;
        }
        if i == 0 {
            // major brand, minor version, then the compatible brands
            let heif_brand = |(j, b): (usize, &[u8])| j != 1 && HEIF_BRANDS.iter().any(|h| *h == b);
            if kind != b"ftyp"
                || !body
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(<[u8; 4]>::as_slice)
                    .enumerate()
                    .any(heif_brand)
            {
                return None;
            }
        } else if kind == b"meta" {
            return heif_meta(&body);
        }
        at = at.checked_add(size)?;
    }
    None
}

/// The primary item's (`pitm`) size from the `ispe` that `ipma` associates with it; a grid's
/// tiles each carry their own `ispe`, so the first one in `ipco` is not the picture's. An
/// associated `irot` of 90 or 270 degrees swaps the two, as Explorer and Finder show it.
fn heif_meta(meta: &[u8]) -> Option<(u32, u32)> {
    let (mut primary, mut ipco, mut ipma) = (None, None, Vec::new());
    for (kind, p) in boxes(meta.get(4..)?) {
        match &kind {
            b"pitm" if *p.first()? == 0 => primary = Some(be16(p.get(4..6)?)),
            b"pitm" => primary = Some(be32(p.get(4..8)?)),
            b"iprp" => {
                for (kind, q) in boxes(p) {
                    match &kind {
                        b"ipco" => ipco = Some(q),
                        b"ipma" => ipma.push(q),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    let primary = primary?;
    let props: Vec<_> = boxes(ipco?).collect();
    let (mut size, mut turned) = (None, false);
    for i in ipma.iter().find_map(|m| associations(m, primary))? {
        // index 0 means "no property"; past the end is a broken file, skipped
        let Some(&(kind, p)) = i.checked_sub(1).and_then(|i| props.get(i)) else {
            continue;
        };
        match &kind {
            b"ispe" => size = Some((be32(p.get(4..8)?), be32(p.get(8..12)?))),
            b"irot" => turned = *p.first()? & 1 == 1, // quarter turns anticlockwise
            _ => {}
        }
    }
    let (w, h) = size?;
    Some(if turned { (h, w) } else { (w, h) })
}

/// The 1-based `ipco` indexes `ipma` associates with `item`, or `None` when it lists none.
fn associations(m: &[u8], item: u32) -> Option<Vec<usize>> {
    let (version, wide) = (*m.first()?, *m.get(3)? & 1 == 1);
    let width = if wide { 2 } else { 1 };
    let mut at = 8;
    for _ in 0..be32(m.get(4..8)?) {
        let id = if version < 1 {
            at += 2;
            be16(m.get(at - 2..at)?)
        } else {
            at += 4;
            be32(m.get(at - 4..at)?)
        };
        let n = *m.get(at)? as usize;
        let list = m.get(at + 1..at + 1 + n * width)?;
        at += 1 + n * width;
        if id == item {
            // the top bit of each entry is the "essential" flag, not part of the index
            let index = |c: &[u8]| {
                if wide {
                    be16(c) & 0x7FFF
                } else {
                    u32::from(c[0] & 0x7F)
                }
            };
            return Some(
                list.chunks_exact(width)
                    .map(|c| index(c) as usize)
                    .collect(),
            );
        }
    }
    None
}

/// The dimensions of the image file at `path`; `None` when it cannot be opened or read as one.
pub fn image_dimensions(path: &Path) -> Option<(u32, u32)> {
    read_dimensions(&mut File::open(path).ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn dims(bytes: &[u8]) -> Option<(u32, u32)> {
        read_dimensions(&mut Cursor::new(bytes))
    }

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0]);
        b
    }

    /// SOI, an APP1 of `exif` bytes, a DHT, then a frame header of `marker`.
    fn jpeg_with(marker: u8, w: u16, h: u16, exif: usize) -> Vec<u8> {
        let mut b = vec![0xFF, 0xD8, 0xFF, 0xE1];
        b.extend_from_slice(&((exif + 2) as u16).to_be_bytes());
        b.extend(std::iter::repeat_n(0xFF, exif)); // payload bytes that look like markers
        b.extend_from_slice(&[0xFF, 0xFF, 0xC4, 0x00, 0x04, 0, 0]); // padding + DHT
        b.extend_from_slice(&[0xFF, marker, 0x00, 0x11, 8]);
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
        b
    }

    #[test]
    fn reads_png_gif_and_bmp_headers() {
        assert_eq!(dims(&png(640, 480)), Some((640, 480)));
        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&[0x2C, 0x01, 0x90, 0x00, 0, 0, 0]);
        assert_eq!(dims(&gif), Some((300, 144)));
        let mut bmp = vec![0u8; 26];
        bmp[..2].copy_from_slice(b"BM");
        bmp[18..22].copy_from_slice(&100i32.to_le_bytes());
        bmp[22..26].copy_from_slice(&(-50i32).to_le_bytes()); // top-down
        assert_eq!(dims(&bmp), Some((100, 50)));
    }

    #[test]
    fn reads_a_jpeg_past_exif_padding_and_a_huffman_table() {
        assert_eq!(
            dims(&jpeg_with(0xC0, 6000, 4000, 40_000)),
            Some((6000, 4000))
        );
        // progressive (SOF2) and the C4 DHT must not be taken for a frame header
        assert_eq!(dims(&jpeg_with(0xC2, 12, 34, 0)), Some((12, 34)));
    }

    #[test]
    fn reads_the_three_webp_flavours() {
        let riff = |fourcc: &[u8; 4], body: &[u8]| {
            let mut b = b"RIFF\0\0\0\0WEBP".to_vec();
            b.extend_from_slice(fourcc);
            b.extend_from_slice(&(body.len() as u32).to_le_bytes());
            b.extend_from_slice(body);
            b
        };
        // lossy: 3-byte frame tag, start code, 14-bit sizes
        let mut lossy = vec![0u8; 3];
        lossy.extend_from_slice(&[0x9D, 0x01, 0x2A]);
        lossy.extend_from_slice(&320u16.to_le_bytes());
        lossy.extend_from_slice(&200u16.to_le_bytes());
        assert_eq!(dims(&riff(b"VP8 ", &lossy)), Some((320, 200)));
        // lossless: signature then width-1 and height-1 in 14 bits each
        let bits: u32 = 799 | (599 << 14);
        let mut ll = vec![0x2F];
        ll.extend_from_slice(&bits.to_le_bytes());
        assert_eq!(dims(&riff(b"VP8L", &ll)), Some((800, 600)));
        // extended: flags, then 24-bit canvas width-1 and height-1
        let mut x = vec![0u8; 4];
        x.extend_from_slice(&[0x7F, 0x07, 0x00, 0x37, 0x04, 0x00]);
        assert_eq!(dims(&riff(b"VP8X", &x)), Some((1920, 1080)));
    }

    /// A TIFF header then, after `gap` bytes standing in for pixels, IFD0 with width and height
    /// as `kind` (3 SHORT, 4 LONG), plus an unrelated tag before them.
    fn tiff_with(le: bool, kind: u16, w: u32, h: u32, gap: usize) -> Vec<u8> {
        let u16b = |v: u16| if le { v.to_le_bytes() } else { v.to_be_bytes() };
        let u32b = |v: u32| if le { v.to_le_bytes() } else { v.to_be_bytes() };
        let mut b = if le {
            b"II*\0".to_vec()
        } else {
            b"MM\0*".to_vec()
        };
        b.extend_from_slice(&u32b(8 + gap as u32));
        b.extend(std::iter::repeat_n(0xAB, gap));
        b.extend_from_slice(&u16b(3));
        for (tag, value) in [(254, 0), (256, w), (257, h)] {
            b.extend_from_slice(&u16b(tag));
            b.extend_from_slice(&u16b(kind));
            b.extend_from_slice(&u32b(1));
            match kind {
                3 => {
                    b.extend_from_slice(&u16b(value as u16));
                    b.extend_from_slice(&[0, 0]);
                }
                _ => b.extend_from_slice(&u32b(value)),
            }
        }
        b.extend_from_slice(&u32b(0)); // no next IFD
        b
    }

    #[test]
    fn reads_tiff_in_both_byte_orders_short_and_long() {
        assert_eq!(dims(&tiff_with(true, 3, 640, 480, 0)), Some((640, 480)));
        assert_eq!(dims(&tiff_with(false, 3, 640, 480, 0)), Some((640, 480)));
        assert_eq!(dims(&tiff_with(true, 4, 70_000, 9, 0)), Some((70_000, 9)));
        assert_eq!(dims(&tiff_with(false, 4, 70_000, 9, 0)), Some((70_000, 9)));
        // IFD0 after 200 KB of pixels is sought, not read through
        assert_eq!(
            dims(&tiff_with(false, 4, 8000, 6000, 200_000)),
            Some((8000, 6000))
        );
    }

    fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut b = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        b.extend_from_slice(kind);
        b.extend_from_slice(body);
        b
    }

    /// A full box: version and flags, then the body.
    fn full(kind: &[u8; 4], version: u8, flags: u8, body: &[u8]) -> Vec<u8> {
        let mut b = vec![version, 0, 0, flags];
        b.extend_from_slice(body);
        bx(kind, &b)
    }

    fn ispe(w: u32, h: u32) -> Vec<u8> {
        full(b"ispe", 0, 0, &[w.to_be_bytes(), h.to_be_bytes()].concat())
    }

    /// A HEIC laid out like a phone photo: ipco holds the 512px tile `ispe` first, then the
    /// primary grid's `ispe` (and an `irot` when `rot` is given); item 1 is the grid, items 2-3 are
    /// tiles. `mdat` sits before `meta` to show the walk seeks past it.
    fn heic(brand: &[u8; 4], w: u32, h: u32, rot: Option<u8>) -> Vec<u8> {
        let mut ipco = [ispe(512, 512), ispe(w, h)].concat();
        if let Some(r) = rot {
            ipco.extend(bx(b"irot", &[r]));
        }
        // version 0, 1-byte associations: tiles -> property 1, grid -> 2 (essential) and 3
        let mut ipma = 3u32.to_be_bytes().to_vec();
        ipma.extend_from_slice(&[0, 2, 1, 1]);
        ipma.extend_from_slice(&[0, 3, 1, 1]);
        ipma.extend_from_slice(&[0, 1, 2, 0x82, 3]);
        let iprp = bx(
            b"iprp",
            &[bx(b"ipco", &ipco), full(b"ipma", 0, 0, &ipma)].concat(),
        );
        let meta = full(
            b"meta",
            0,
            0,
            &[
                full(b"hdlr", 0, 0, &[0; 20]),
                full(b"pitm", 0, 0, &[0, 1]),
                iprp,
            ]
            .concat(),
        );
        let mut ftyp = brand.to_vec();
        ftyp.extend_from_slice(&[0, 0, 0, 0]);
        ftyp.extend_from_slice(b"mif1");
        [bx(b"ftyp", &ftyp), bx(b"mdat", &[0; 1000]), meta].concat()
    }

    #[test]
    fn reads_the_primary_item_of_a_heic_or_avif_not_a_tile() {
        assert_eq!(dims(&heic(b"heic", 4032, 3024, None)), Some((4032, 3024)));
        assert_eq!(dims(&heic(b"avif", 1920, 1080, None)), Some((1920, 1080)));
        // a 180 degree turn keeps the sides, 90 and 270 swap them
        assert_eq!(
            dims(&heic(b"heic", 4032, 3024, Some(2))),
            Some((4032, 3024))
        );
        assert_eq!(
            dims(&heic(b"heic", 4032, 3024, Some(1))),
            Some((3024, 4032))
        );
        assert_eq!(
            dims(&heic(b"heic", 4032, 3024, Some(3))),
            Some((3024, 4032))
        );
        // an MP4 also starts with ftyp but names no HEIF brand, so it is not walked
        let mut mp4 = heic(b"isom", 4032, 3024, None);
        mp4[16..20].copy_from_slice(b"mp41");
        assert_eq!(dims(&mp4), None);
    }

    #[test]
    fn a_cut_short_tiff_or_heic_is_none() {
        let tiff = tiff_with(true, 3, 640, 480, 0);
        let heic = heic(b"heic", 4032, 3024, None);
        // the last 4 bytes are the next-IFD offset, which is not needed
        for n in 0..tiff.len() - 4 {
            assert_eq!(dims(&tiff[..n]), None, "tiff cut at {n}");
        }
        for n in 0..heic.len() {
            assert_eq!(dims(&heic[..n]), None, "heic cut at {n}");
        }
        // an IFD offset past the end, and a meta box with no pitm
        assert_eq!(dims(b"II*\0\xff\xff\xff\x7f"), None);
        let no_pitm = [
            bx(b"ftyp", b"heic\0\0\0\0"),
            full(b"meta", 0, 0, &ispe(9, 9)),
        ]
        .concat();
        assert_eq!(dims(&no_pitm), None);
    }

    #[test]
    fn anything_else_or_cut_short_is_none() {
        assert_eq!(dims(b""), None);
        assert_eq!(dims(b"plain text, not a picture at all.."), None);
        assert_eq!(dims(&png(640, 480)[..20]), None);
        assert_eq!(dims(&png(0, 480)), None);
        assert_eq!(dims(&jpeg_with(0xC0, 10, 10, 0)[..12]), None);
        // a JPEG that reaches its scan without a frame header
        assert_eq!(dims(&[0xFF, 0xD8, 0xFF, 0xDA, 0, 2]), None);
        assert_eq!(image_dimensions(Path::new("/no/such/file.png")), None);
    }
}
