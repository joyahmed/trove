//! The preview pane's backend: the head of a text file, and the bytes of any file served over
//! the `preview` custom protocol (image, video, audio, PDF) with the content type the webview
//! needs and `Range` requests honoured — WebView2's `<video>` seeks with them.
//!
//! The extension → content-type table here is mirrored by `src/lib/data/preview-kinds.ts`,
//! which decides what the pane renders. Change both or neither.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;

/// Up to this many bytes of a text file are shown.
pub const TEXT_HEAD_BYTES: u64 = 65_536;
/// A NUL in the first this-many bytes marks a file as binary.
const BINARY_PROBE: usize = 8_192;
/// Files past this size are not served whole (the whole file would be read into memory); a
/// `Range` request for one is still answered, a chunk at a time.
pub const MAX_SERVED_BYTES: u64 = 512 * 1024 * 1024;
/// The most one `206` answer carries.
///
/// ⛔ A `<video>` opens with `Range: bytes=0-` — "from here to the end" — and the whole rest of
/// the file used to be read into memory to answer it: up to 512 MB per request, a thread
/// each, and a seek fires another before the last is done. A server may answer an open range
/// with less than asked; `Content-Range` says exactly which bytes came back, and the media
/// element simply asks for the next piece when it needs it. 8 MB is seconds of even 4K video.
pub const MAX_RANGE_CHUNK: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TextHead {
    pub text: String,
    pub truncated: bool,
    pub binary: bool,
}

/// The first `max_bytes` of `path`, UTF-8 (lossy, BOM stripped). A NUL in the first 8 KB
/// makes it `binary` with empty text.
pub fn read_text_head(path: &Path, max_bytes: u64) -> std::io::Result<TextHead> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let mut buf = Vec::with_capacity(usize::try_from(max_bytes.min(len)).unwrap_or(0));
    file.by_ref().take(max_bytes).read_to_end(&mut buf)?;
    let probe = &buf[..buf.len().min(BINARY_PROBE)];
    if probe.contains(&0) {
        return Ok(TextHead {
            text: String::new(),
            truncated: false,
            binary: true,
        });
    }
    let body = buf.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&buf);
    Ok(TextHead {
        text: String::from_utf8_lossy(body).into_owned(),
        truncated: len > max_bytes,
        binary: false,
    })
}

/// The `Content-Type` for an extension (lower-case, no dot). Mirrored in preview-kinds.ts.
pub fn content_type(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// The parsed `Range: bytes=a-b` header against a file of `len` bytes: the inclusive byte
/// range, or `None` when the header is absent or unsatisfiable. `bytes=a-` runs to the end;
/// `bytes=-n` is the last n bytes.
pub fn byte_range(header: Option<&str>, len: u64) -> Option<(u64, u64)> {
    let spec = header?.trim().strip_prefix("bytes=")?;
    let (a, b) = spec.split_once('-')?;
    if len == 0 {
        return None;
    }
    let (start, end) = match (a.trim(), b.trim()) {
        ("", n) => {
            let n: u64 = n.parse().ok()?;
            (len.saturating_sub(n), len - 1)
        }
        (a, "") => (a.parse().ok()?, len - 1),
        (a, b) => (a.parse().ok()?, b.parse::<u64>().ok()?.min(len - 1)),
    };
    (start <= end && start < len).then_some((start, end))
}

/// What the protocol answers: status, headers, body.
pub struct Served {
    pub status: u16,
    pub content_type: &'static str,
    pub content_range: Option<String>,
    pub body: Vec<u8>,
}

/// Serve `path`, whole or the requested `Range` (at most `MAX_RANGE_CHUNK` of it). 404 when
/// missing, 413 when too large to send whole, 416 on a bad range. The slice is read into
/// memory (a full read of a large file without a `Range` is the v1 trade-off).
pub fn serve(path: &Path, range: Option<&str>) -> Served {
    serve_chunked(path, range, MAX_RANGE_CHUNK)
}

fn serve_chunked(path: &Path, range: Option<&str>, chunk: u64) -> Served {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let content_type = content_type(&ext);
    let empty = |status| Served {
        status,
        content_type,
        content_range: None,
        body: Vec::new(),
    };
    let Ok(mut file) = std::fs::File::open(path) else {
        return empty(404);
    };
    let Ok(meta) = file.metadata() else {
        return empty(404);
    };
    if meta.is_dir() {
        return empty(404);
    }
    let len = meta.len();
    let (start, end, status) = match range {
        None if len > MAX_SERVED_BYTES => return empty(413),
        None => (0, len.saturating_sub(1), 200),
        // a chunk is bounded however big the file is, so a ranged read needs no size limit
        Some(_) => match byte_range(range, len) {
            Some((s, e)) => (s, e.min(s.saturating_add(chunk.max(1) - 1)), 206),
            None => return empty(416),
        },
    };
    let count = if len == 0 { 0 } else { end - start + 1 };
    let mut body = vec![0u8; usize::try_from(count).unwrap_or(0)];
    if count > 0
        && (file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut body).is_err())
    {
        return empty(404);
    }
    Served {
        status,
        content_type,
        content_range: (status == 206).then(|| format!("bytes {start}-{end}/{len}")),
        body,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("trove-preview-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
        fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let p = self.0.join(name);
            std::fs::write(&p, bytes).unwrap();
            p
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_small_text_file_is_read_whole() {
        let s = Scratch::new("small");
        let p = s.file("a.txt", "hello\nworld".as_bytes());
        let head = read_text_head(&p, TEXT_HEAD_BYTES).unwrap();
        assert_eq!(head.text, "hello\nworld");
        assert!(!head.truncated);
        assert!(!head.binary);
    }

    #[test]
    fn a_long_file_is_cut_and_flagged() {
        let s = Scratch::new("long");
        let p = s.file("b.txt", &[b'x'; 100]);
        let head = read_text_head(&p, 10).unwrap();
        assert_eq!(head.text.len(), 10);
        assert!(head.truncated);
    }

    #[test]
    fn a_nul_byte_marks_binary() {
        let s = Scratch::new("bin");
        let p = s.file("c.bin", b"MZ\0\0stuff");
        let head = read_text_head(&p, TEXT_HEAD_BYTES).unwrap();
        assert!(head.binary);
        assert_eq!(head.text, "");
    }

    #[test]
    fn a_utf8_bom_is_stripped() {
        let s = Scratch::new("bom");
        let p = s.file("d.txt", b"\xEF\xBB\xBFhi");
        assert_eq!(read_text_head(&p, TEXT_HEAD_BYTES).unwrap().text, "hi");
    }

    #[test]
    fn content_types_follow_the_extension() {
        assert_eq!(content_type("png"), "image/png");
        assert_eq!(content_type("jpeg"), "image/jpeg");
        assert_eq!(content_type("mp4"), "video/mp4");
        assert_eq!(content_type("pdf"), "application/pdf");
        assert_eq!(content_type("exe"), "application/octet-stream");
    }

    #[test]
    fn byte_ranges_parse_and_clamp() {
        assert_eq!(byte_range(Some("bytes=0-99"), 1000), Some((0, 99)));
        assert_eq!(byte_range(Some("bytes=500-"), 1000), Some((500, 999)));
        assert_eq!(byte_range(Some("bytes=-100"), 1000), Some((900, 999)));
        assert_eq!(byte_range(Some("bytes=0-5000"), 1000), Some((0, 999)));
        assert_eq!(byte_range(Some("bytes=2000-"), 1000), None);
        assert_eq!(byte_range(None, 1000), None);
        assert_eq!(byte_range(Some("items=0-1"), 1000), None);
    }

    #[test]
    fn serve_answers_whole_ranged_and_missing() {
        let s = Scratch::new("serve");
        let p = s.file("v.mp4", b"0123456789");
        let whole = serve(&p, None);
        assert_eq!((whole.status, whole.content_type), (200, "video/mp4"));
        assert_eq!(whole.body, b"0123456789");
        let part = serve(&p, Some("bytes=2-4"));
        assert_eq!(part.status, 206);
        assert_eq!(part.body, b"234");
        assert_eq!(part.content_range.as_deref(), Some("bytes 2-4/10"));
        assert_eq!(serve(&p, Some("bytes=50-")).status, 416);
        assert_eq!(serve(&s.0.join("nope.png"), None).status, 404);
    }

    #[test]
    fn an_open_or_huge_range_is_answered_one_chunk_at_a_time() {
        let s = Scratch::new("chunk");
        let p = s.file("v.mp4", b"0123456789");
        // `bytes=0-` from a <video>: four bytes, and Content-Range says which four
        let first = serve_chunked(&p, Some("bytes=0-"), 4);
        assert_eq!(first.status, 206);
        assert_eq!(first.body, b"0123");
        assert_eq!(first.content_range.as_deref(), Some("bytes 0-3/10"));
        // the element asks for the next piece where the last one ended
        let next = serve_chunked(&p, Some("bytes=4-"), 4);
        assert_eq!(next.body, b"4567");
        assert_eq!(next.content_range.as_deref(), Some("bytes 4-7/10"));
        // the tail is shorter than a chunk and ends at the file's end
        let tail = serve_chunked(&p, Some("bytes=8-"), 4);
        assert_eq!(tail.body, b"89");
        assert_eq!(tail.content_range.as_deref(), Some("bytes 8-9/10"));
        // a closed range within a chunk is served exactly
        assert_eq!(serve_chunked(&p, Some("bytes=1-2"), 4).body, b"12");
        // no Range: the whole file, as before
        assert_eq!(serve_chunked(&p, None, 4).body, b"0123456789");
    }

    #[test]
    fn the_real_chunk_bounds_what_one_answer_can_hold() {
        let s = Scratch::new("bigchunk");
        let len = MAX_RANGE_CHUNK as usize + 100;
        let p = s.file("v.webm", &vec![1u8; len]);
        let part = serve(&p, Some("bytes=0-"));
        assert_eq!(part.status, 206);
        assert_eq!(part.body.len() as u64, MAX_RANGE_CHUNK);
        assert_eq!(
            part.content_range,
            Some(format!("bytes 0-{}/{len}", MAX_RANGE_CHUNK - 1))
        );
    }
}
