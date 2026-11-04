//! File-type icons and type names from the Windows shell — the registered associations are
//! the only source that is right for this machine. One `SHGetFileInfoW` per **extension**
//! (`ext/<ext>`, on a fake `x.<ext>` with `FILE_ATTRIBUTE_NORMAL`, so no disk or per-file
//! registry hit); a per-file call only for what carries its own icon (`file/<path>`: exe, lnk,
//! ico, …). Every `HICON` is converted to PNG once and destroyed; PNGs live in a byte-capped
//! LRU in memory and under `<cache_dir>\icons\<size>\` (trimmed at startup, written
//! atomically). No tauri types here; `lib.rs` serves the bytes over the `icon://` protocol.

use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

pub const SMALL: u32 = 16;
pub const LARGE: u32 = 32;

/// Extensions whose icon is inside the file (or its target), not in the association.
const OWN_ICON_EXTS: [&str; 6] = ["exe", "lnk", "ico", "url", "scr", "cur"];

/// The two sizes the shell hands out cheaply: anything up to 24 is the small icon.
pub fn clamp_size(size: u32) -> u32 {
    if size <= 24 {
        SMALL
    } else {
        LARGE
    }
}

/// Which lookup an entry needs — decided here so the frontend never guesses.
pub fn icon_key(is_dir: bool, ext: Option<&str>, path: &str) -> String {
    if is_dir {
        return "folder".into();
    }
    match ext {
        Some(e) if OWN_ICON_EXTS.contains(&e) => format!("file/{path}"),
        Some(e) => format!("ext/{e}"),
        None => "ext/".into(),
    }
}

/// Explorer's Type column for an extension; the shell's name, else `<EXT> File` / `File`.
pub fn type_name(ext: Option<&str>) -> String {
    match ext {
        None | Some("") => "File".into(),
        Some(e) => shell_type_name(e).unwrap_or_else(|| fallback_type_name(e)),
    }
}

/// The name when the shell has none. Windows keeps its `<EXT> File`; a Mac and Linux have no such
/// habit, so plain text says so and any other extension reads `<EXT> file`.
fn fallback_type_name(ext: &str) -> String {
    if cfg!(windows) {
        return format!("{} File", ext.to_uppercase());
    }
    match ext.to_ascii_lowercase().as_str() {
        "txt" | "text" | "log" => {
            if cfg!(target_os = "macos") {
                "Plain Text".into()
            } else {
                "Text".into()
            }
        }
        _ => format!("{} file", ext.to_uppercase()),
    }
}

/// `ext/txt` → `ext_txt.png`; `file/<path>` → `file_<hash of path + mtime>.png`, so an updated
/// exe gets a new entry instead of a stale one.
pub fn cache_file_name(key: &str, mtime_ms: Option<u64>) -> String {
    if let Some(ext) = key.strip_prefix("ext/") {
        return format!("ext_{ext}.png");
    }
    let mut h = std::collections::hash_map::DefaultHasher::new();
    key.hash(&mut h);
    mtime_ms.hash(&mut h);
    format!("file_{:016x}.png", h.finish())
}

/// What a `thumb/` or `big/` key is cached under: the key itself, or — when its path is a
/// symlink — the key plus where the link points. A re-pointed link then gets a fresh picture,
/// and so does a link whose entry was drawn as the link itself (a Mac's `/Applications/Safari.app`
/// was a generic document before `quicklook.rs` resolved links). `exists` skips the extra
/// `readlink` for a path the stat already found missing.
fn link_aware_key(key: &str, exists: bool) -> std::borrow::Cow<'_, str> {
    let target = key
        .split_once('/')
        .filter(|(k, _)| exists && matches!(*k, "thumb" | "big"))
        .and_then(|(_, p)| std::fs::read_link(p).ok());
    match target {
        Some(t) => format!("{key}\n->{}", t.display()).into(),
        None => key.into(),
    }
}

/// Where a key's PNGs live under `<cache_dir>\icons`: the small icons by size, the big ones
/// and thumbnails under their own folders so a `file/` and a `big/` PNG never collide.
fn cache_subdir(key: &str, size: u32) -> PathBuf {
    match key.split_once('/').map(|(k, _)| k) {
        Some(kind @ ("thumb" | "big")) => PathBuf::from(kind).join(size.to_string()),
        _ => PathBuf::from(size.to_string()),
    }
}

/// The size a key is served at: the small icons snap to 16 / 32, the big ones to 48 / 96 / 256.
fn size_for(key: &str, size: u32) -> u32 {
    if super::thumbs::mode_of(key).is_some() {
        super::thumbs::clamp_big(size)
    } else {
        clamp_size(size)
    }
}

/// `/ext/txt` + `size=16` → (`ext/txt`, 16); `/file/C%3A%5Ca%20b.exe` + `size=32` →
/// (`file/C:\a b.exe`, 32); `/thumb/<path>` and `/big/<path>` at 48 / 96 / 256. A missing or
/// odd size snaps to the nearest the key serves; anything else is `None`.
pub fn parse_icon_request(path: &str, query: Option<&str>) -> Option<(String, u32)> {
    let rest = path.trim_start_matches('/');
    let (kind, arg) = rest.split_once('/')?;
    let arg = percent_decode(arg);
    let key = match kind {
        "ext" => format!("ext/{}", arg.to_lowercase()),
        "file" | "thumb" | "big" | "app" if !arg.is_empty() => format!("{kind}/{arg}"),
        // a shell menu item's bitmap, already a PNG in memory (core/shell_menu.rs)
        "menu" if !arg.is_empty() => format!("menu/{arg}"),
        _ => return None,
    };
    let size = query
        .and_then(|q| {
            q.split('&')
                .find_map(|kv| kv.strip_prefix("size="))
                .and_then(|v| v.parse::<u32>().ok())
        })
        .map_or(SMALL, |s| size_for(&key, s));
    Some((key, size))
}

pub(crate) fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// (cache file name, size) → PNG bytes; the file name carries the mtime for `file/` keys.
/// A cached PNG is keyed by its cache file name and the size it was rendered at.
type MemKey = (String, u32);

/// What the memory cache may hold in PNG bytes before it forgets the least recently used.
///
/// ⛔ It used to be a plain map that never let go: every thumbnail of every folder ever opened
/// stayed resident for the life of the process, and because a `thumb/` key carries the file's
/// mtime, an edited picture added a second entry beside the stale one rather than replacing
/// it. A long session in a photo folder at 256 px is hundreds of MB that way — part of the
/// "whole PC lags" report. 64 MB is a few thousand 96 px thumbnails, far more than a screen
/// shows; anything evicted is still one disk read away.
const MEMORY_CAP_BYTES: usize = 64 * 1024 * 1024;

/// A least-recently-used map bounded by the total size of its values, not their count — a
/// 16 px icon is ~300 bytes and a 256 px thumbnail ~100 KB, so a count cap would be either
/// useless or far too tight. `order` maps a use stamp to its key, so the oldest is
/// `order.first`; both lookups are O(log n), no scan per insert.
struct ByteLru {
    map: HashMap<MemKey, (Arc<[u8]>, u64)>,
    order: std::collections::BTreeMap<u64, MemKey>,
    stamp: u64,
    bytes: usize,
    cap: usize,
}

impl ByteLru {
    fn new(cap: usize) -> Self {
        ByteLru {
            map: HashMap::new(),
            order: std::collections::BTreeMap::new(),
            stamp: 0,
            bytes: 0,
            cap,
        }
    }

    fn next_stamp(&mut self) -> u64 {
        self.stamp += 1;
        self.stamp
    }

    /// A hit counts as a use, so a thumbnail on screen is never the one evicted.
    fn get(&mut self, k: &MemKey) -> Option<Arc<[u8]>> {
        let stamp = self.next_stamp();
        let (bytes, used) = self.map.get_mut(k)?;
        self.order.remove(used);
        *used = stamp;
        self.order.insert(stamp, k.clone());
        Some(bytes.clone())
    }

    fn insert(&mut self, k: MemKey, v: Arc<[u8]>) {
        // one value bigger than the whole cache would evict everything and then itself
        if v.len() > self.cap {
            return;
        }
        let stamp = self.next_stamp();
        if let Some((old, used)) = self.map.remove(&k) {
            self.order.remove(&used);
            self.bytes -= old.len();
        }
        self.bytes += v.len();
        self.order.insert(stamp, k.clone());
        self.map.insert(k, (v, stamp));
        while self.bytes > self.cap {
            let Some((_, oldest)) = self.order.pop_first() else {
                break;
            };
            if let Some((gone, _)) = self.map.remove(&oldest) {
                self.bytes -= gone.len();
            }
        }
    }
}

fn memory() -> &'static Mutex<ByteLru> {
    static MEM: OnceLock<Mutex<ByteLru>> = OnceLock::new();
    MEM.get_or_init(|| Mutex::new(ByteLru::new(MEMORY_CAP_BYTES)))
}

fn cached_in_memory(k: &MemKey) -> Option<Arc<[u8]>> {
    memory().lock().ok().and_then(|mut m| m.get(k))
}

type Gates = Mutex<HashMap<MemKey, Arc<Mutex<()>>>>;

fn gates() -> &'static Gates {
    static GATES: OnceLock<Gates> = OnceLock::new();
    GATES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// One lookup in flight per cache entry.
///
/// A folder of 500 `.txt` files asks for `ext/txt` 500 times in the same breath, and every one
/// of them misses the cache because the first answer has not landed yet. Without this gate all
/// 500 queue on the shell lock and repeat the *same* `SHGetFileInfoW`; a folder of installers
/// is worse, because `file/<path>` is per file. The first asker does the work, the rest wait
/// on its gate and then read what it left in the memory cache.
fn gate_for(k: &MemKey) -> Arc<Mutex<()>> {
    let mut g = gates().lock().unwrap_or_else(|e| e.into_inner());
    g.entry(k.clone()).or_default().clone()
}

/// Drop the gate once the last asker is through, so a 100k-entry folder of `file/` keys does
/// not leave 100k mutexes behind.
///
/// Our own handle goes first, and *under the map lock*: every clone (`gate_for`) and every drop
/// (here) then happens with the map held, so the count the map's own entry reports is exactly
/// one plus the askers still in flight — 1 means nobody is left and the entry is ours to remove.
/// Counting the handle instead let two askers leaving at once each see the other's handle,
/// which a caller does not drop until *after* it has let go of the map lock: both then decided
/// somebody was still waiting and the gate stayed in the map for the life of the process —
/// exactly the leak this function exists to prevent. The entry may also be a *newer* gate than
/// ours (removed and re-created while we were leaving); counting it is still the right answer,
/// and it is the reason we look the key up rather than trust what we were handed.
fn release_gate(k: &MemKey, held: Arc<Mutex<()>>) {
    let mut g = gates().lock().unwrap_or_else(|e| e.into_inner());
    drop(held);
    if g.get(k).is_some_and(|gate| Arc::strong_count(gate) == 1) {
        g.remove(k);
    }
}

/// The PNG for `key` at `size`, from memory, then the disk cache, then the shell (written
/// through). `None` when the shell has no icon for it.
#[cfg_attr(not(test), allow(dead_code))]
pub fn icon_png_cached(cache_dir: &Path, key: &str, size: u32) -> Option<Arc<[u8]>> {
    icon_png_answer(cache_dir, key, size).map(|(bytes, _)| bytes)
}

/// `icon_png_cached` plus whether the PNG is the real answer (`true`) or a stand-in for one
/// (`false`: a `thumb/` the shell could not fill, drawn as the file's icon). A stand-in is
/// returned but never put in the memory or disk cache, so the next ask renders again.
fn icon_png_answer(cache_dir: &Path, key: &str, size: u32) -> Option<(Arc<[u8]>, bool)> {
    let size = size_for(key, size);
    // ⚠️ A stat, and it can block: a dead network mapping holds this for 20-60 s. Only the
    // keys that name a file pay it — `ext/` and `app/` never touch the disk here — and those
    // keys run on the pool's slow lane (`lane_of`), so a hung stat can never sit in front of
    // the per-extension icons every list row needs.
    let meta = key
        .split_once('/')
        .filter(|(k, _)| matches!(*k, "file" | "thumb" | "big"))
        .and_then(|(_, p)| std::fs::metadata(p).ok());
    let mtime = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    let stamp = meta.as_ref().and_then(file_stamp);
    let name = cache_file_name(&link_aware_key(key, meta.is_some()), mtime);
    let mem_key = (name, size);
    if let Some(hit) = cached_in_memory(&mem_key) {
        return Some((hit, true));
    }
    if stamp.is_some_and(|s| is_remembered(&(mem_key.clone(), s.len))) {
        return None;
    }
    let gate = gate_for(&mem_key);
    let bytes = {
        let _held = gate.lock().unwrap_or_else(|e| e.into_inner());
        // the asker that held the gate before us has already answered this one
        cached_in_memory(&mem_key)
            .map(|b| (b, true))
            .or_else(|| load_through(cache_dir, key, size, &mem_key, stamp))
    };
    release_gate(&mem_key, gate);
    bytes
}

/// What the `icon://` route answers with: a PNG from the pipeline above, or — Linux app rows
/// only — an app's SVG icon passed through untouched for the webview to draw. ⛔ The SVG is
/// only ever an `<img src>`: never inlined, `{@html}`'d or fetched into the DOM, where its
/// scripts would run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IconBody {
    Png(Arc<[u8]>),
    Svg(Vec<u8>),
}

impl IconBody {
    /// The one content type this body is served as; nothing is guessed from the bytes.
    pub fn content_type(&self) -> &'static str {
        match self {
            IconBody::Png(_) => "image/png",
            IconBody::Svg(_) => "image/svg+xml",
        }
    }

    pub fn bytes(&self) -> &[u8] {
        match self {
            IconBody::Png(b) => b,
            IconBody::Svg(b) => b,
        }
    }
}

/// The largest SVG icon passed to the webview; a bigger one is not an icon, and the app row
/// falls back to the generic PNG.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const SVG_CAP: u64 = 1 << 20;

/// `path`'s bytes when it is an `.svg` file no larger than `cap`, else `None`. The read itself
/// is capped too, so a file that grows after the stat cannot slip past.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn read_svg(path: &Path, cap: u64) -> Option<Vec<u8>> {
    use std::io::Read;
    if !path
        .extension()
        .is_some_and(|x| x.eq_ignore_ascii_case("svg"))
    {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    if file.metadata().ok()?.len() > cap {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(cap + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= cap).then_some(bytes)
}

/// The SVG for a `file/<.desktop>` key whose app has an SVG icon and no PNG (Linux); `None`
/// for every other key, and everywhere else. Not cached here: the response's `max-age` is.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn icon_svg(key: &str, size: u32) -> Option<Vec<u8>> {
    let target = key
        .strip_prefix("file/")
        .filter(|t| t.to_ascii_lowercase().ends_with(".desktop"))?;
    let icon = super::apps_linux::env_desktop_icon(Path::new(target), clamp_size(size), true)?;
    read_svg(&icon, SVG_CAP)
}

#[cfg(not(all(unix, not(target_os = "macos"))))]
pub fn icon_svg(_key: &str, _size: u32) -> Option<Vec<u8>> {
    None
}

/// The icon for `key` at `size`: an SVG-only Linux app's SVG (`icon_svg`), else the PNG
/// (`icon_png_cached`). A PNG is always preferred: `icon_svg` answers only when there is none.
///
/// The flag is whether the webview may keep the answer for a day. `false` for anything that is
/// not the real thumbnail of a finished file: the icon standing in for a thumbnail the shell
/// could not make (a file still open for writing), and any `thumb/` of an empty or still-fresh
/// file (`SETTLE_MS`), whose picture may be of half a file (B.5.5).
pub fn icon_body(cache_dir: &Path, key: &str, size: u32) -> Option<(IconBody, bool)> {
    if key.starts_with("menu/") {
        return super::shell_menu::icon(key).map(|png| (IconBody::Png(png), true));
    }
    if let Some(svg) = icon_svg(key, size) {
        return Some((IconBody::Svg(svg), true));
    }
    let (png, real) = icon_png_answer(cache_dir, key, size)?;
    Some((IconBody::Png(png), real && thumb_has_settled(key)))
}

/// `false` for a `thumb/` key whose file is empty or changed less than `SETTLE_MS` ago, or
/// cannot be stat-ed; `true` for every other key.
fn thumb_has_settled(key: &str) -> bool {
    let Some(path) = key.strip_prefix("thumb/") else {
        return true;
    };
    std::fs::metadata(path)
        .ok()
        .and_then(|m| file_stamp(&m))
        .is_some_and(|s| s.len > 0 && is_settled(s, std::time::SystemTime::now()))
}

/// The cache miss itself: the disk cache, else the shell, written through to both caches.
/// Called with the key's gate held, so exactly one caller per key is ever in here. A stand-in
/// picture (`render`'s `false`) is handed back but written to neither cache.
fn load_through(
    cache_dir: &Path,
    key: &str,
    size: u32,
    mem_key: &MemKey,
    stamp: Option<FileStamp>,
) -> Option<(Arc<[u8]>, bool)> {
    let file: PathBuf = cache_dir
        .join("icons")
        .join(cache_subdir(key, size))
        .join(&mem_key.0);
    let bytes: Arc<[u8]> = match std::fs::read(&file) {
        Ok(b) if is_whole_png(&b) => b.into(),
        _ => {
            let fresh = match render(cache_dir, key, size, &mem_key.0, stamp) {
                Ok(fresh) => fresh,
                Err(miss) => {
                    if let (Miss::Lasting, Some(s)) = (miss, stamp) {
                        remember_failure((mem_key.clone(), s.len));
                    }
                    return None;
                }
            };
            let (fresh, real) = fresh;
            if !real {
                return Some((fresh.into(), false));
            }
            if let Some(dir) = file.parent() {
                let _ = std::fs::create_dir_all(dir).and_then(|()| write_atomically(&file, &fresh));
            }
            fresh.into()
        }
    };
    if let Ok(mut m) = memory().lock() {
        m.insert(mem_key.clone(), bytes.clone());
    }
    Some((bytes, true))
}

/// A file's modified time (ms since the epoch) and length: together, what says the file is
/// the same one that was tried before.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileStamp {
    pub mtime_ms: u64,
    pub len: u64,
}

/// The stamp of a file's metadata; `None` when the system gives no modified time.
pub fn file_stamp(meta: &std::fs::Metadata) -> Option<FileStamp> {
    let mtime = meta.modified().ok()?;
    let mtime_ms = mtime
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    Some(FileStamp {
        mtime_ms,
        len: meta.len(),
    })
}

/// How long after its last change a file counts as finished. Some file systems keep the
/// mtime to the whole second, so a file still being written can show the same mtime twice;
/// a miss on a file younger than this is never remembered.
const SETTLE_MS: u64 = 10_000;

/// Whether a file stamped `s` was last changed at least `SETTLE_MS` before `now`. A modified
/// time in the future (a clock moved back, a copy from a machine ahead) is not settled.
fn is_settled(s: FileStamp, now: std::time::SystemTime) -> bool {
    now.duration_since(std::time::UNIX_EPOCH)
        .is_ok_and(|d| d.as_millis() as u64 >= s.mtime_ms.saturating_add(SETTLE_MS))
}

/// Why a fresh render came back empty.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Miss {
    /// It could come out differently next time: never remembered.
    Passing,
    /// Off Windows only: the photo was read in full, had settled, and did not decode.
    #[cfg_attr(windows, allow(dead_code))]
    Lasting,
}

/// A cache miss drawn fresh. Windows asks the shell for every size, and its misses are all
/// `Passing` (its lock busy, `SHELL_WAIT`). Off Windows a photo is decoded in Rust
/// (`render_photo`).
fn render(
    cache_dir: &Path,
    key: &str,
    size: u32,
    name: &str,
    stamp: Option<FileStamp>,
) -> Result<(Vec<u8>, bool), Miss> {
    #[cfg(not(windows))]
    if let Some((super::thumbs::ImageMode::ThumbnailOrIcon, path)) = super::thumbs::mode_of(key) {
        return render_photo(cache_dir, key, Path::new(path), size, name, stamp)
            .map(|png| (png, true));
    }
    #[cfg(windows)]
    let _ = (cache_dir, name, stamp);
    icon_png_checked(key, size).ok_or(Miss::Passing)
}

/// The size off Windows' smaller photo thumbnails are shrunk from (`render_photo`).
#[cfg(not(windows))]
const DERIVE_FROM: u32 = 256;

/// Off Windows, a photo's thumbnail. The 48 and 96 px ones are shrunk from its 256 px one —
/// itself cached, so the photo is decoded at most once — instead of decoding the photo again
/// for every size the grid steps through; the 256 is a PNG of at most 256 × 256, so the shrink
/// is a few milliseconds where a decode of the photo is tens to hundreds.
///
/// A miss is `Lasting` only when the decoder read the file in full, it is the file
/// `icon_png_cached` stamped (same mtime, same length), and it has settled (`is_settled`). A
/// read error — an iCloud or Dropbox placeholder, a file still being copied — is `Passing`,
/// and so is a half-written file: it is tried again once it is older or longer.
#[cfg(not(windows))]
fn render_photo(
    cache_dir: &Path,
    key: &str,
    path: &Path,
    size: u32,
    name: &str,
    stamp: Option<FileStamp>,
) -> Result<Vec<u8>, Miss> {
    use super::image_thumbs::{decode_to_rgba, thumbnail_of_file, NoThumbnail};
    let size = super::thumbs::clamp_big(size);
    if size < DERIVE_FROM {
        // a different cache entry, so a different gate: no deadlock with the one we hold
        let Some(big) = icon_png_cached(cache_dir, key, DERIVE_FROM) else {
            // same file, same name: remembered at 256 is lasting here too
            let at_256 =
                stamp.is_some_and(|s| is_remembered(&((name.to_string(), DERIVE_FROM), s.len)));
            return Err(if at_256 { Miss::Lasting } else { Miss::Passing });
        };
        let (w, h, rgba) = decode_to_rgba(&big, size).ok_or(Miss::Passing)?;
        return encode_png(w, h, &rgba).ok_or(Miss::Passing);
    }
    let started = std::time::Instant::now();
    let out = thumbnail_of_file(path, size);
    if started.elapsed() >= SLOW_SHELL_IMAGE {
        log::warn!(
            "slow image decode at {size}px — {}ms",
            started.elapsed().as_millis()
        );
        log::debug!("slow image decode: {}", path.display());
    }
    match out {
        Ok((w, h, rgba)) => encode_png(w, h, &rgba).ok_or(Miss::Passing),
        Err(NoThumbnail::Undecodable(read))
            if Some(read) == stamp && is_settled(read, std::time::SystemTime::now()) =>
        {
            Err(Miss::Lasting)
        }
        Err(_) => Err(Miss::Passing),
    }
}

/// How many failed keys are remembered before the list starts over.
const FAILED_CAP: usize = 4096;

/// A remembered miss: the cache entry (file name from path + mtime, and pixel size) and the
/// file's length, so a file that is fixed, finished copying or replaced is a new key.
type FailKey = (MemKey, u64);

/// Off-Windows photos that were read in full and did not decode (`Miss::Lasting`): a broken
/// photo is decoded once, not on every scroll past it. Windows never adds to it.
fn failed() -> &'static Mutex<HashSet<FailKey>> {
    static FAILED: OnceLock<Mutex<HashSet<FailKey>>> = OnceLock::new();
    FAILED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn is_remembered(k: &FailKey) -> bool {
    failed().lock().is_ok_and(|f| f.contains(k))
}

fn remember_failure(k: FailKey) {
    if let Ok(mut f) = failed().lock() {
        note_failure(&mut f, k, FAILED_CAP);
    }
}

/// Add `k`, first forgetting them all once `cap` are held: a crude bound, but a forgotten
/// failure costs one more try, never a wrong answer.
fn note_failure(set: &mut HashSet<FailKey>, k: FailKey, cap: usize) {
    if set.len() >= cap {
        set.clear();
    }
    set.insert(k);
}

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// The last chunk of every PNG: a zero-length `IEND` and its fixed CRC.
const PNG_IEND: &[u8] = b"\0\0\0\0IEND\xAE\x42\x60\x82";

/// A PNG that was written to the end, not just started.
///
/// ⛔ Checking the signature alone let a write cut short — the app killed, the disk full —
/// leave a file that passed, and it was then served as a half-drawn or broken thumbnail on
/// every run after, because a "hit" is never re-rendered. The trailer is what a truncated
/// file is missing, and checking it costs nothing: the bytes are already in memory.
fn is_whole_png(b: &[u8]) -> bool {
    b.len() >= PNG_SIGNATURE.len() + PNG_IEND.len()
        && b.starts_with(PNG_SIGNATURE)
        && b.ends_with(PNG_IEND)
}

/// Write `bytes` to `file` so a reader sees either the old file, the whole new one, or none —
/// never a prefix. A temp file in the same folder, then a rename (which replaces on Windows).
/// The temp name carries the process and a counter, so two writers never share one.
fn write_atomically(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let tmp = file.with_extension(format!("{}-{n}.tmp", std::process::id()));
    let written = std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, file));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// What the on-disk cache under `<cache_dir>\icons` may grow to before startup trims it.
///
/// Nothing ever deleted from it: a `thumb/` entry is named by path *and* mtime, so every edit,
/// rename and deleted file left its PNG behind for good. 300 MB holds tens of thousands of
/// thumbnails — every folder a person actually returns to.
pub const DISK_CAP_BYTES: u64 = 300 * 1024 * 1024;

/// A temp file older than this is a write that never finished (the app died mid-write); a
/// younger one may be a write in flight right now, so it is left alone.
const STALE_TMP: std::time::Duration = std::time::Duration::from_secs(60);

/// Trim the disk cache to `cap` bytes, oldest-written first, and sweep dead temp files.
/// Returns how many files went. Meant for a background thread at startup: it walks the whole
/// cache folder, which is cheap but not free, and nothing waits on it.
pub fn prune_disk_cache(cache_dir: &Path, cap: u64) -> usize {
    let now = std::time::SystemTime::now();
    let mut removed = 0;
    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(cache_dir.join("icons"))
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
    {
        let Ok(meta) = entry.metadata() else { continue };
        let written = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        if entry.path().extension().is_some_and(|e| e == "tmp") {
            let age = now.duration_since(written).unwrap_or_default();
            if age >= STALE_TMP && std::fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
            continue;
        }
        files.push((entry.into_path(), written, meta.len()));
    }
    for victim in pick_victims(files, cap) {
        if std::fs::remove_file(victim).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// The files to delete so what is left fits in `cap`: the oldest-written first. Pure, so the
/// order is testable without a disk.
fn pick_victims(mut files: Vec<(PathBuf, std::time::SystemTime, u64)>, cap: u64) -> Vec<PathBuf> {
    let mut total: u64 = files.iter().map(|f| f.2).sum();
    if total <= cap {
        return Vec::new();
    }
    files.sort_by_key(|f| f.1);
    let mut out = Vec::new();
    for (path, _, len) in files {
        if total <= cap {
            break;
        }
        total -= len;
        out.push(path);
    }
    out
}

/// Which pool lane an `icon://` request belongs on — decided from the URL path alone, with no
/// I/O, because it runs on the webview's protocol thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IconLane {
    /// `ext/`, `app/`: no disk, a memory hit after the first. Never waits behind the others.
    Quick,
    /// `file/<path>`: stats the file and asks the shell per file. Slow lane, never dropped —
    /// a list row has no other picture to fall back to.
    File,
    /// `thumb/`, `big/`: a full `GetImage` per file. Slow lane, newest first, and the oldest
    /// queued are answered "busy" when a fast scroll piles up more than the screen can show.
    Image,
}

/// The file a `file/`, `thumb/` or `big/` key draws, for the deadline (`workers::guarded`):
/// those read the file itself, so on a share they wait for the server. `None` for the
/// file-less keys (`ext/`, `app/`).
pub fn key_path(key: &str) -> Option<&str> {
    ["file/", "thumb/", "big/"]
        .iter()
        .find_map(|prefix| key.strip_prefix(prefix))
}

pub fn lane_of(path: &str) -> IconLane {
    let rest = path.trim_start_matches('/');
    if rest.starts_with("thumb/") || rest.starts_with("big/") {
        IconLane::Image
    } else if rest.starts_with("file/") {
        IconLane::File
    } else {
        IconLane::Quick
    }
}

/// One shell call at a time: concurrent SHGetFileInfoW(SHGFI_ICON) calls on fresh threads
/// fail intermittently (seen in tests), and the webview asks for many icons at once. The
/// thumbnail factory shares the lock. Taken only through `lock_shell`.
static SHELL: Mutex<()> = Mutex::new(());

/// A thumbnail or big icon that takes longer than this to draw is logged.
const SLOW_SHELL_IMAGE: std::time::Duration = std::time::Duration::from_millis(500);

/// The longest anyone waits for the shell lock before giving up on that one icon.
///
/// ⛔ A thumbnail handler is third-party code (a codec pack, a PDF reader) running in our
/// process, and one that hangs inside `GetImage` holds `SHELL` forever — a plain `lock()`
/// then parked every later icon behind it, for good. We cannot kill a hung COM call; what we
/// can do is stop queueing on it. Five seconds is well past a legitimate wait (the slow lane
/// lets at most two image jobs contend), so a timeout means something is stuck, not busy.
const SHELL_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// `SHELL`, or `None` after `SHELL_WAIT` (logged). `what` names the icon for the log line.
fn lock_shell(what: &str) -> Option<std::sync::MutexGuard<'static, ()>> {
    let held = lock_within(&SHELL, SHELL_WAIT);
    if held.is_none() {
        log::warn!(
            "shell lock not free after {}s — a thumbnail handler may be hung; skipped {what}",
            SHELL_WAIT.as_secs()
        );
    }
    held
}

/// `m` within `wait`, polling. `std` has no timed mutex lock; a 5 ms poll with at most a
/// handful of waiters (the pool's size) costs nothing measurable. A poisoned lock is still
/// usable here — it guards no data, only the shell's one-at-a-time rule.
fn lock_within(m: &Mutex<()>, wait: std::time::Duration) -> Option<std::sync::MutexGuard<'_, ()>> {
    let asked = std::time::Instant::now();
    loop {
        match m.try_lock() {
            Ok(g) => return Some(g),
            Err(std::sync::TryLockError::Poisoned(e)) => return Some(e.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => {}
        }
        if asked.elapsed() >= wait {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

/// Ask the shell for the icon and encode it. `None` when there is none (or off Windows), and
/// when the shell lock is stuck (see `SHELL_WAIT`).
#[cfg_attr(not(all(test, windows)), allow(dead_code))] // only the Windows tests call it
pub fn icon_png(key: &str, size: u32) -> Option<Vec<u8>> {
    icon_png_checked(key, size).map(|(png, _)| png)
}

/// `icon_png` plus whether it is the real answer: `false` for a `thumb/` the shell could not
/// fill and drew the file's icon for instead (`thumbs::shell_image_checked`).
pub fn icon_png_checked(key: &str, size: u32) -> Option<(Vec<u8>, bool)> {
    if let Some((mode, path)) = super::thumbs::mode_of(key) {
        let asked = std::time::Instant::now();
        // ⚠️ Windows only: off Windows `shell_image` is a pure-Rust decode (`image_thumbs.rs`)
        // that needs no lock, and holding it there would decode one photo at a time while the
        // slow lane has two slots — and call a long decode a "hung handler" after 5 s.
        let _one_at_a_time = if cfg!(windows) {
            Some(lock_shell(key)?)
        } else {
            None
        };
        let waited = asked.elapsed();
        let image = super::thumbs::shell_image_checked(
            Path::new(path),
            super::thumbs::clamp_big(size),
            mode,
        );
        let worked = asked.elapsed() - waited;
        // The shell can start helper processes for a video or PDF, so a slow one is the
        // trail to follow when the machine drags. Fast ones stay out of the log.
        if worked >= SLOW_SHELL_IMAGE || waited >= SLOW_SHELL_IMAGE * 4 {
            log::warn!(
                "slow shell image at {size}px — {}ms drawing, {}ms queued behind others",
                worked.as_millis(),
                waited.as_millis()
            );
            log::debug!("slow shell image: {path}");
        }
        return image;
    }
    let size = clamp_size(size);
    // ⛔ `shell:AppsFolder\<aumid>` is a shell namespace path, not a file: SHGetFileInfoW below
    // returns nothing for it, so an app row with no `.lnk` needs the item factory instead.
    if let Some(aumid) = key.strip_prefix("app/") {
        if aumid.is_empty() {
            return None;
        }
        let path = format!(r"shell:AppsFolder\{aumid}");
        let _one_at_a_time = lock_shell(key)?;
        return super::thumbs::shell_image_sized(
            Path::new(&path),
            size,
            super::thumbs::ImageMode::IconOnly,
        )
        .map(|png| (png, true));
    }
    let (target, use_attributes) = match (key.strip_prefix("ext/"), key.strip_prefix("file/")) {
        (Some(ext), _) => (format!("x.{ext}"), true),
        (_, Some(path)) => (path.to_string(), false),
        _ => return None,
    };
    let (w, h, rgba) = {
        let _one_at_a_time = lock_shell(key)?;
        shell_icon_rgba(&target, use_attributes, size)?
    };
    encode_png(w, h, &rgba).map(|png| (png, true))
}

pub(crate) fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut enc = png::Encoder::new(&mut out, w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    let mut writer = enc.write_header().ok()?;
    writer.write_image_data(rgba).ok()?;
    writer.finish().ok()?;
    Some(out)
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(Some(0))
        .collect()
}

/// The shell wants COM on the calling thread; once per thread is enough, and a thread that
/// already initialised it differently (RPC_E_CHANGED_MODE) is fine too.
#[cfg(windows)]
pub(crate) fn ensure_com() {
    use windows_sys::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    thread_local! { static DONE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
    DONE.with(|done| {
        if !done.get() {
            // SAFETY: a null reserved pointer and a valid apartment flag; the result is
            // deliberately ignored (S_OK, S_FALSE or RPC_E_CHANGED_MODE all mean "usable").
            unsafe {
                CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
            }
            done.set(true);
        }
    });
}

#[cfg(windows)]
fn shell_type_name(ext: &str) -> Option<String> {
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
    use windows_sys::Win32::UI::Shell::{
        SHGetFileInfoW, SHFILEINFOW, SHGFI_TYPENAME, SHGFI_USEFILEATTRIBUTES,
    };
    ensure_com();
    let name = wide(&format!("x.{ext}"));
    // SAFETY: SHFILEINFOW is plain data; zeroed is a valid starting value.
    let mut info: SHFILEINFOW = unsafe { std::mem::zeroed() };
    // SAFETY: `name` is NUL-terminated, `info` is a live struct of the stated size.
    let ok = unsafe {
        SHGetFileInfoW(
            name.as_ptr(),
            FILE_ATTRIBUTE_NORMAL,
            &mut info,
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_TYPENAME | SHGFI_USEFILEATTRIBUTES,
        )
    };
    if ok == 0 {
        return None;
    }
    let end = info
        .szTypeName
        .iter()
        .position(|&c| c == 0)
        .unwrap_or(info.szTypeName.len());
    let s = String::from_utf16_lossy(&info.szTypeName[..end]);
    (!s.is_empty()).then_some(s)
}

#[cfg(not(windows))]
fn shell_type_name(_ext: &str) -> Option<String> {
    None
}

/// The icon as (width, height, RGBA rows top-down). Destroys the HICON and its bitmaps.
#[cfg(windows)]
fn shell_icon_rgba(target: &str, use_attributes: bool, size: u32) -> Option<(u32, u32, Vec<u8>)> {
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
    use windows_sys::Win32::UI::Shell::{
        SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGFI_SMALLICON,
        SHGFI_USEFILEATTRIBUTES,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon;

    ensure_com();
    let name = wide(target);
    let mut flags = SHGFI_ICON
        | if size == SMALL {
            SHGFI_SMALLICON
        } else {
            SHGFI_LARGEICON
        };
    if use_attributes {
        flags |= SHGFI_USEFILEATTRIBUTES;
    }
    // SAFETY: SHFILEINFOW is plain data; zeroed is a valid starting value.
    let mut info: SHFILEINFOW = unsafe { std::mem::zeroed() };
    // SAFETY: `name` is NUL-terminated, `info` is a live struct of the stated size.
    let ok = unsafe {
        SHGetFileInfoW(
            name.as_ptr(),
            if use_attributes {
                FILE_ATTRIBUTE_NORMAL
            } else {
                0
            },
            &mut info,
            std::mem::size_of::<SHFILEINFOW>() as u32,
            flags,
        )
    };
    if ok == 0 || info.hIcon.is_null() {
        return None;
    }
    let pixels = icon_to_rgba(info.hIcon);
    // SAFETY: the shell handed us this HICON with SHGFI_ICON; it is ours to destroy, once.
    unsafe {
        DestroyIcon(info.hIcon);
    }
    pixels
}

#[cfg(all(not(windows), not(all(unix, not(target_os = "macos")))))]
fn shell_icon_rgba(
    _target: &str,
    _use_attributes: bool,
    _size: u32,
) -> Option<(u32, u32, Vec<u8>)> {
    None
}

/// Linux has no shell to ask either, but a `.desktop` file names its icon: `file/<.desktop>`
/// (the palette's app rows) is the theme icon its `Icon=` line resolves to
/// (`apps_linux::env_desktop_icon`), decoded and fitted to `size`. Anything else has none.
#[cfg(all(unix, not(target_os = "macos")))]
fn shell_icon_rgba(target: &str, use_attributes: bool, size: u32) -> Option<(u32, u32, Vec<u8>)> {
    if use_attributes || !target.to_ascii_lowercase().ends_with(".desktop") {
        return None;
    }
    let png = super::apps_linux::env_desktop_icon(Path::new(target), size, false)?;
    let bytes = std::fs::read(png).ok()?;
    super::image_thumbs::decode_to_rgba(&bytes, size)
}

/// A 32 bpp bitmap's pixels as RGBA rows top-down — the read the icon path does, without a
/// mask: a bitmap whose alpha channel is all zero (a thumbnail drawn without one) is opaque.
/// The caller keeps ownership of the bitmap.
#[cfg(windows)]
pub(crate) fn bitmap_to_rgba(
    hbm: windows_sys::Win32::Graphics::Gdi::HBITMAP,
) -> Option<(u32, u32, Vec<u8>)> {
    use windows_sys::Win32::Graphics::Gdi::{
        GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS,
    };
    if hbm.is_null() {
        return None;
    }
    // SAFETY: BITMAP is plain data; zeroed is a valid starting value.
    let mut bm: BITMAP = unsafe { std::mem::zeroed() };
    // SAFETY: `hbm` is a live bitmap; `bm` is a live struct of the stated size.
    if unsafe {
        GetObjectW(
            hbm,
            std::mem::size_of::<BITMAP>() as i32,
            (&mut bm as *mut BITMAP).cast(),
        )
    } == 0
    {
        return None;
    }
    let (w, h) = (
        u32::try_from(bm.bmWidth).ok()?,
        u32::try_from(bm.bmHeight.abs()).ok()?,
    );
    if w == 0 || h == 0 || w > 2048 || h > 2048 {
        return None;
    }
    // SAFETY: a null window means the screen DC; released below on every path.
    let hdc = unsafe { GetDC(std::ptr::null_mut()) };
    if hdc.is_null() {
        return None;
    }
    let mut buf = vec![0u8; (w * h * 4) as usize];
    // SAFETY: BITMAPINFO is plain data; zeroed then filled below.
    let mut bmi: BITMAPINFO = unsafe { std::mem::zeroed() };
    bmi.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w as i32,
        biHeight: -(h as i32),
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB,
        biSizeImage: 0,
        biXPelsPerMeter: 0,
        biYPelsPerMeter: 0,
        biClrUsed: 0,
        biClrImportant: 0,
    };
    // SAFETY: `buf` holds exactly w*h*4 bytes, the size the 32 bpp header describes; `hbm`
    // is a live bitmap not selected into any DC.
    let lines = unsafe {
        GetDIBits(
            hdc,
            hbm,
            0,
            h,
            buf.as_mut_ptr().cast(),
            &mut bmi,
            DIB_RGB_COLORS,
        )
    };
    // SAFETY: `hdc` came from GetDC(null) above and is released exactly once.
    unsafe {
        ReleaseDC(std::ptr::null_mut(), hdc);
    }
    if lines != h as i32 {
        return None;
    }
    let (pixels, _) = buf.as_chunks_mut::<4>();
    if pixels.iter().all(|p| p[3] == 0) {
        pixels.iter_mut().for_each(|p| p[3] = 255);
    }
    for p in pixels.iter_mut() {
        p.swap(0, 2); // BGRA → RGBA
    }
    Some((w, h, buf))
}

/// GetIconInfo → GetDIBits on the colour bitmap (32 bpp, top-down); an icon without an alpha
/// channel gets its alpha from the mask. Both bitmaps are deleted here.
#[cfg(windows)]
fn icon_to_rgba(
    hicon: windows_sys::Win32::UI::WindowsAndMessaging::HICON,
) -> Option<(u32, u32, Vec<u8>)> {
    use windows_sys::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetIconInfo, ICONINFO};

    // SAFETY: ICONINFO is plain data; zeroed is a valid starting value.
    let mut ii: ICONINFO = unsafe { std::mem::zeroed() };
    // SAFETY: `hicon` is a live icon handle owned by the caller; `ii` is a live out-param.
    if unsafe { GetIconInfo(hicon, &mut ii) } == 0 {
        return None;
    }
    let result = (|| {
        if ii.hbmColor.is_null() {
            return None; // a monochrome icon: colour and mask share one bitmap; not worth it
        }
        // SAFETY: BITMAP is plain data; zeroed is a valid starting value.
        let mut bm: BITMAP = unsafe { std::mem::zeroed() };
        // SAFETY: `hbmColor` is a live bitmap; `bm` is a live struct of the stated size.
        if unsafe {
            GetObjectW(
                ii.hbmColor,
                std::mem::size_of::<BITMAP>() as i32,
                (&mut bm as *mut BITMAP).cast(),
            )
        } == 0
        {
            return None;
        }
        let (w, h) = (
            u32::try_from(bm.bmWidth).ok()?,
            u32::try_from(bm.bmHeight).ok()?,
        );
        if w == 0 || h == 0 || w > 1024 || h > 1024 {
            return None;
        }
        // SAFETY: a null window means the screen DC; released below on every path.
        let hdc = unsafe { GetDC(std::ptr::null_mut()) };
        if hdc.is_null() {
            return None;
        }
        let read = |hbm: HBITMAP| -> Option<Vec<u8>> {
            let mut buf = vec![0u8; (w * h * 4) as usize];
            // SAFETY: BITMAPINFO is plain data; zeroed then filled below.
            let mut bmi: BITMAPINFO = unsafe { std::mem::zeroed() };
            bmi.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w as i32,
                biHeight: -(h as i32), // negative: top-down rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            };
            // SAFETY: `buf` holds exactly w*h*4 bytes, the size the 32 bpp header describes;
            // `hbm` is a live bitmap not selected into any DC.
            let lines = unsafe {
                GetDIBits(
                    hdc,
                    hbm,
                    0,
                    h,
                    buf.as_mut_ptr().cast(),
                    &mut bmi,
                    DIB_RGB_COLORS,
                )
            };
            (lines == h as i32).then_some(buf)
        };
        let color = read(ii.hbmColor);
        let mask = if ii.hbmMask.is_null() {
            None
        } else {
            read(ii.hbmMask)
        };
        // SAFETY: `hdc` came from GetDC(null) above and is released exactly once.
        unsafe {
            ReleaseDC(std::ptr::null_mut(), hdc);
        }
        let mut px = color?;
        let (pixels, _) = px.as_chunks_mut::<4>();
        if pixels.iter().all(|p| p[3] == 0) {
            // no alpha channel: the mask says what is transparent (white = transparent)
            match mask.as_deref().map(|m| m.as_chunks::<4>().0) {
                Some(m) => {
                    for (p, mp) in pixels.iter_mut().zip(m) {
                        p[3] = if mp[0] == 0 { 255 } else { 0 };
                    }
                }
                None => pixels.iter_mut().for_each(|p| p[3] = 255),
            }
        }
        for p in pixels.iter_mut() {
            p.swap(0, 2); // BGRA → RGBA
        }
        Some((w, h, px))
    })();
    // SAFETY: GetIconInfo gave us these two bitmaps to own; delete each once (null is ignored).
    unsafe {
        if !ii.hbmColor.is_null() {
            DeleteObject(ii.hbmColor);
        }
        if !ii.hbmMask.is_null() {
            DeleteObject(ii.hbmMask);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A theme fixture with an SVG-only app icon and a PNG+SVG one: the first is served as its
    /// SVG bytes typed `image/svg+xml`, the second stays a PNG; oversized or non-SVG files are
    /// refused.
    #[test]
    fn an_svg_only_app_icon_is_served_as_svg_and_a_png_wins_when_both_exist() {
        use super::super::apps_linux::{desktop_icon, theme_chain, DesktopEntry};
        let dir = std::env::temp_dir().join(format!("trove-svg-serve-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let icons = dir.join("icons");
        let put = |rel: &str, body: &[u8]| {
            let p = icons.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, body).unwrap();
            p
        };
        let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>"#;
        put("hicolor/scalable/apps/only-svg.svg", svg);
        let png = put("hicolor/48x48/apps/both.png", b"png");
        put("hicolor/scalable/apps/both.svg", svg);
        let bases = vec![icons.clone()];
        let themes = theme_chain("hicolor", &bases);
        let serve = |icon: &str| {
            let entry = DesktopEntry {
                icon: Some(icon.into()),
                ..DesktopEntry::default()
            };
            let path = desktop_icon(&entry, &themes, &bases, &[], 16, true)?;
            Some(match read_svg(&path, SVG_CAP) {
                Some(b) => IconBody::Svg(b),
                None => IconBody::Png(std::fs::read(&path).ok()?.into()),
            })
        };

        let only = serve("only-svg").expect("an icon");
        assert_eq!(only.content_type(), "image/svg+xml");
        assert_eq!(only.bytes(), svg);
        let both = serve("both").expect("an icon");
        assert_eq!(both.content_type(), "image/png");
        assert_eq!(both.bytes(), b"png");
        assert_eq!(
            read_svg(&png, SVG_CAP),
            None,
            "only an .svg is passed through"
        );

        let big = put("big.svg", &vec![b' '; 2048]);
        assert_eq!(read_svg(&big, 1024), None, "over the cap");
        assert_eq!(
            read_svg(&big, 2048).map(|b| b.len()),
            Some(2048),
            "at the cap"
        );
        assert_eq!(read_svg(&icons.join("nope.svg"), SVG_CAP), None);
        assert_eq!(icon_svg("ext/svg", 16), None, "only .desktop app rows");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn icon_key_picks_the_lookup() {
        assert_eq!(icon_key(true, None, r"C:\x"), "folder");
        assert_eq!(icon_key(false, Some("txt"), r"C:\a.txt"), "ext/txt");
        assert_eq!(icon_key(false, Some("exe"), r"C:\a.exe"), r"file/C:\a.exe");
        assert_eq!(icon_key(false, None, r"C:\README"), "ext/");
    }

    /// ⭐ Deliberate, and measured: real Explorer's Details, List and Small icons views draw
    /// the **association** icon at 16 px — three different wallpapers side by side all get the
    /// identical generic "JPG File" glyph. So a thumbnail-capable file keeps the per-extension
    /// key, which is what lets one `SHGetFileInfoW` serve all 2,000 `.jpg` rows of a folder
    /// instead of 2,000 `IShellItemImageFactory` calls behind one mutex. The grid asks for
    /// `thumb/<path>` by path instead (see `tile-icon.ts`); it does not go through this key.
    #[test]
    fn a_thumbnail_capable_file_still_shares_one_small_icon_per_extension() {
        assert_eq!(icon_key(false, Some("jpg"), r"C:\pics\a.jpg"), "ext/jpg");
        assert_eq!(icon_key(false, Some("mp4"), r"C:\v\a.mp4"), "ext/mp4");
        assert_eq!(icon_key(false, Some("pdf"), r"C:\d\a.pdf"), "ext/pdf");
    }

    #[test]
    fn cache_file_names_are_stable_and_mtime_aware() {
        assert_eq!(cache_file_name("ext/txt", None), "ext_txt.png");
        assert_eq!(cache_file_name("ext/", None), "ext_.png");
        let a = cache_file_name(r"file/C:\a.exe", Some(1));
        let b = cache_file_name(r"file/C:\a.exe", Some(2));
        assert!(a.starts_with("file_") && a.ends_with(".png") && a.len() == 25);
        assert_ne!(a, b);
        assert_eq!(a, cache_file_name(r"file/C:\a.exe", Some(1)));
    }

    /// A linked picture is cached by where the link points, so a re-pointed link (or one drawn
    /// as the link itself before) is drawn fresh; a plain file and `file/` keys keep their name.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_thumb_is_cached_by_its_target() {
        let dir = std::env::temp_dir().join(format!("trove-linkkey-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (a, b, link) = (dir.join("a.png"), dir.join("b.png"), dir.join("l.png"));
        std::fs::write(&a, b"a").unwrap();
        std::fs::write(&b, b"b").unwrap();
        std::os::unix::fs::symlink(&a, &link).unwrap();
        let plain = format!("thumb/{}", a.display());
        let linked = format!("thumb/{}", link.display());
        assert_eq!(link_aware_key(&plain, true), plain);
        assert_eq!(
            link_aware_key(&format!("file/{}", link.display()), true),
            format!("file/{}", link.display())
        );
        assert_eq!(
            link_aware_key(&linked, false),
            linked,
            "no readlink for a missing path"
        );
        let to_a = link_aware_key(&linked, true).into_owned();
        assert_ne!(to_a, linked);
        std::fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(&b, &link).unwrap();
        assert_ne!(
            link_aware_key(&linked, true),
            to_a,
            "re-pointed link, new entry"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_icon_requests() {
        assert_eq!(
            parse_icon_request("/ext/TXT", Some("size=16")),
            Some(("ext/txt".into(), 16))
        );
        assert_eq!(
            parse_icon_request("/file/C%3A%5CProgram%20Files%5Ca.exe", Some("size=32")),
            Some((r"file/C:\Program Files\a.exe".into(), 32))
        );
        assert_eq!(
            parse_icon_request("/ext/png", None),
            Some(("ext/png".into(), 16))
        );
        assert_eq!(
            parse_icon_request("/ext/png", Some("size=20")),
            Some(("ext/png".into(), 16))
        );
        assert_eq!(
            parse_icon_request("/ext/png", Some("size=48")),
            Some(("ext/png".into(), 32))
        );
        assert_eq!(
            parse_icon_request("/thumb/C%3A%5Ca.png", Some("size=96")),
            Some((r"thumb/C:\a.png".into(), 96))
        );
        assert_eq!(
            parse_icon_request("/big/C%3A%5Cdir", Some("size=100")),
            Some((r"big/C:\dir".into(), 96))
        );
        assert_eq!(
            parse_icon_request("/big/C%3A%5Cdir", Some("size=300")),
            Some((r"big/C:\dir".into(), 256))
        );
        // The grid's Medium size is one of BIG_SIZES, so it is served as asked rather than
        // snapped up to 96 — a 48 px tile that fetched a 96 px PNG would cost four times the
        // pixels for a box that cannot show them.
        assert_eq!(
            parse_icon_request("/thumb/C%3A%5Ca.png", Some("size=48")),
            Some((r"thumb/C:\a.png".into(), 48))
        );
        assert_eq!(
            parse_icon_request("/big/C%3A%5Ca.txt", Some("size=48")),
            Some((r"big/C:\a.txt".into(), 48))
        );
        assert_eq!(parse_icon_request("/thumb/", Some("size=96")), None);
        assert_eq!(parse_icon_request("/other/x", Some("size=16")), None);
        assert_eq!(parse_icon_request("/file/", None), None);
    }

    #[cfg(windows)]
    #[test]
    fn a_text_file_icon_is_a_png() {
        let png = icon_png("ext/txt", 16).expect("the shell has a .txt icon");
        assert!(png.starts_with(PNG_SIGNATURE));
        let large = icon_png("ext/txt", 32).expect("large too");
        assert!(!large.is_empty());
    }

    #[cfg(not(windows))]
    #[test]
    fn off_windows_type_names_are_plain() {
        let txt = type_name(Some("txt"));
        assert_eq!(
            txt,
            if cfg!(target_os = "macos") {
                "Plain Text"
            } else {
                "Text"
            }
        );
        assert_eq!(type_name(Some("zz9qx")), "ZZ9QX file");
        assert_eq!(type_name(None), "File");
    }

    #[cfg(windows)]
    #[test]
    fn type_names_come_from_the_shell_with_a_fallback() {
        assert_eq!(type_name(None), "File");
        // whatever app owns .txt here, the shell has a name for it that is not the fallback
        let txt = type_name(Some("txt"));
        assert!(!txt.is_empty() && txt != "TXT File", "{txt}");
        assert_eq!(type_name(Some("zz9qx")), "ZZ9QX File");
    }

    #[cfg(windows)]
    #[test]
    fn the_memory_cache_returns_the_same_bytes_twice() {
        let dir = std::env::temp_dir().join(format!("trove-icons-{}", std::process::id()));
        let a = icon_png_cached(&dir, "ext/txt", 16).unwrap();
        let b = icon_png_cached(&dir, "ext/txt", 16).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        assert!(dir.join("icons").join("16").join("ext_txt.png").is_file());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn askers_racing_for_one_cold_key_do_the_work_once_and_leave_no_gate_behind() {
        // What a folder of 500 same-type files does the first time it is listed. A key of its
        // own: the memory cache is process-global, so sharing `ext/txt` with the test above
        // would hand whichever ran second a cache hit and no disk write.
        let dir = std::env::temp_dir().join(format!("trove-icons-race-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // ⛔ Off Windows there is no shell to draw `ext/log` (`shell_icon_rgba` is a `None`
        // stub), so every racer got `None` and the test died at its first `expect`. The race is
        // in the cache, not the shell: seed the DISK cache with a whole PNG and the cold key
        // still misses memory, so all 16 queue on one gate and one of them loads. Without the
        // gate each would read the file and cache its own Arc, and `ptr_eq` below would fail.
        if cfg!(not(windows)) {
            let file = dir
                .join("icons")
                .join(cache_subdir("ext/log", clamp_size(16)))
                .join(cache_file_name("ext/log", None));
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            let png = encode_png(1, 1, &[0, 0, 0, 255]).unwrap();
            assert!(is_whole_png(&png));
            std::fs::write(&file, png).unwrap();
        }
        let racers: Vec<_> = (0..16)
            .map(|_| {
                let dir = dir.clone();
                std::thread::spawn(move || icon_png_cached(&dir, "ext/log", 16))
            })
            .collect();
        let answers: Vec<_> = racers.into_iter().filter_map(|h| h.join().ok()).collect();
        assert_eq!(answers.len(), 16);
        let first = answers[0]
            .as_ref()
            .expect("the shell (or, off Windows, the seeded disk cache) answers for .log");
        for a in &answers {
            let a = a.as_ref().expect("every racer is answered");
            // one lookup, one Arc: the losers read what the winner cached, they do not redo it
            assert!(Arc::ptr_eq(first, a));
        }
        // Our key's gate, not the whole map: `cargo test` runs these in one process on many
        // threads, so a neighbour that is mid-`icon_png_cached` legitimately has a gate of its
        // own in there. The same mem_key `icon_png_cached` builds — `ext/` keys carry no mtime.
        let mem_key = (cache_file_name("ext/log", None), clamp_size(16));
        assert!(
            !gates()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key(&mem_key),
            "the gate is dropped once the last asker is through"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// ⛔ 86 of the 173 app rows on this machine have no `.lnk`, so `file/<lnk>` cannot draw
    /// them and an iconless row is what the person would actually see. The `app/` key exists
    /// for exactly those; if this fails, half the palette's app list renders blank.
    #[test]
    #[cfg(windows)]
    fn a_store_app_icon_comes_from_the_shell_namespace() {
        let calc = crate::core::spotlight::apps_folder()
            .into_iter()
            .find(|a| a.name.eq_ignore_ascii_case("Calculator"))
            .expect("Calculator is in AppsFolder");
        let png = icon_png(&format!("app/{}", calc.aumid), 16).expect("Calculator has a tile icon");
        assert!(png.starts_with(PNG_SIGNATURE), "not a PNG");
        // an empty aumid must not become `shell:AppsFolder\` (which resolves to the folder
        // itself and would draw the same generic tile for every broken row)
        assert!(icon_png("app/", 16).is_none());
    }

    /// A folder with one 300 x 200 PNG in it, last changed an hour ago (so it has settled).
    fn thumb_fixture(tag: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("trove-icons-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let photo = dir.join("photo.png");
        let rgba: Vec<u8> = (0..300 * 200).flat_map(|_| [30u8, 140, 200, 255]).collect();
        std::fs::write(&photo, encode_png(300, 200, &rgba).unwrap()).unwrap();
        set_age(&photo, 3600);
        (dir, photo)
    }

    fn set_age(path: &Path, secs: u64) {
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        let then = std::time::SystemTime::now() - std::time::Duration::from_secs(secs);
        file.set_modified(then).unwrap();
    }

    /// B.5.5: only the real thumbnail of a finished file is kept by the webview for a day.
    #[test]
    fn a_good_settled_thumbnail_is_kept_and_a_fresh_one_is_not() {
        let (dir, photo) = thumb_fixture("keep");
        let cache = dir.join("cache");
        let key = format!("thumb/{}", photo.display());
        let (body, keep) = icon_body(&cache, &key, 96).expect("a thumbnail");
        assert!(matches!(body, IconBody::Png(_)));
        assert!(keep, "a real thumbnail of a settled file keeps its max-age");
        // the same file, changed just now: maybe still being written
        std::fs::write(&photo, std::fs::read(&photo).unwrap()).unwrap();
        let (_, keep) = icon_body(&cache, &key, 96).expect("a thumbnail");
        assert!(!keep, "a file younger than SETTLE_MS is not kept");
        // an empty file is never kept (it may be about to be written)
        std::fs::write(&photo, b"").unwrap();
        set_age(&photo, 3600);
        assert!(icon_body(&cache, &key, 96).is_none_or(|(_, keep)| !keep));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// B.5.5: half a PNG that was just written may be a copy still arriving. The shell may draw
    /// the half it has, or the file's icon, or nothing, and the webview keeps none of those.
    #[test]
    fn a_half_written_png_is_never_kept() {
        let (dir, photo) = thumb_fixture("trunc");
        let cache = dir.join("cache");
        let key = format!("thumb/{}", photo.display());
        let whole = std::fs::read(&photo).unwrap();
        std::fs::write(&photo, &whole[..whole.len() / 2]).unwrap();
        assert!(icon_body(&cache, &key, 96).is_none_or(|(_, keep)| !keep));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// B.5.5: a file the writer still holds open (no sharing) cannot be thumbnailed. The shell
    /// answers with the file's icon; that answer is not kept and not remembered, so once the
    /// writer lets go the same URL gets the real thumbnail.
    #[cfg(windows)]
    #[test]
    fn a_file_locked_by_its_writer_is_not_kept_and_not_remembered() {
        use std::os::windows::fs::OpenOptionsExt;
        let (dir, photo) = thumb_fixture("locked");
        let cache = dir.join("cache");
        let key = format!("thumb/{}", photo.display());
        let writer = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&photo)
            .unwrap();
        assert!(icon_body(&cache, &key, 96).is_none_or(|(_, keep)| !keep));
        drop(writer);
        let (_, keep) = icon_body(&cache, &key, 96).expect("the thumbnail once it is free");
        assert!(keep, "the stand-in was not remembered");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Plan 14.2: off Windows a photo's `thumb/` key goes through the same cache as Windows'
    /// shell thumbnails — decoded once, written under `icons/thumb/<size>/`, and the second ask
    /// is the same bytes from memory. A non-image and a `big/` key are `None` (→ 404 → glyph).
    #[cfg(not(windows))]
    #[test]
    fn off_windows_a_photo_thumbnail_is_decoded_once_and_cached() {
        let dir = std::env::temp_dir().join(format!("trove-icons-decode-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let photo = dir.join("photo.png");
        let rgba: Vec<u8> = (0..300 * 200).flat_map(|_| [30u8, 140, 200, 255]).collect();
        std::fs::write(&photo, encode_png(300, 200, &rgba).unwrap()).unwrap();
        let cache = dir.join("cache");
        let key = format!("thumb/{}", photo.display());
        let a = icon_png_cached(&cache, &key, 96).expect("a decoded thumbnail");
        assert!(is_whole_png(&a));
        let b = icon_png_cached(&cache, &key, 96).unwrap();
        assert!(Arc::ptr_eq(&a, &b), "the second ask is the memory cache");
        let written: Vec<_> = std::fs::read_dir(cache.join("icons").join("thumb").join("96"))
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(written.len(), 1);
        assert!(written[0].starts_with("file_") && written[0].ends_with(".png"));
        let note = dir.join("note.txt");
        std::fs::write(&note, "not a picture").unwrap();
        assert!(icon_png_cached(&cache, &format!("thumb/{}", note.display()), 96).is_none());
        assert!(icon_png_cached(&cache, &format!("big/{}", photo.display()), 96).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Plan 14.2: the 48 px thumbnail is shrunk from the cached 256 px one, so asking for the
    /// small size first leaves the 256 on disk as well, and a broken photo is tried once.
    #[cfg(not(windows))]
    #[test]
    fn off_windows_small_thumbnails_come_from_the_256_and_a_broken_photo_is_tried_once() {
        let dir = std::env::temp_dir().join(format!("trove-icons-derive-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let photo = dir.join("photo.png");
        let rgba: Vec<u8> = (0..600 * 400).flat_map(|_| [30u8, 140, 200, 255]).collect();
        std::fs::write(&photo, encode_png(600, 400, &rgba).unwrap()).unwrap();
        let cache = dir.join("cache");
        let key = format!("thumb/{}", photo.display());
        let small = icon_png_cached(&cache, &key, 48).expect("a 48 px thumbnail");
        let img = image::load_from_memory(&small).unwrap();
        assert_eq!((img.width(), img.height()), (48, 32));
        let big_dir = cache.join("icons").join("thumb").join("256");
        assert_eq!(
            std::fs::read_dir(&big_dir).unwrap().count(),
            1,
            "the 256 it came from"
        );
        // a broken photo, settled: none, remembered at 96 and at the 256 it asked for, and
        // none again without a second decode
        let broken = dir.join("broken.jpg");
        std::fs::write(&broken, [0xFF, 0xD8, 0xFF, 0xE0, 0, 0]).unwrap();
        let stamp = age(&broken, 60);
        let key = format!("thumb/{}", broken.display());
        assert!(icon_png_cached(&cache, &key, 96).is_none());
        let name = cache_file_name(&key, Some(stamp.mtime_ms));
        for size in [96, 256] {
            assert!(
                is_remembered(&((name.clone(), size), stamp.len)),
                "remembered at {size}"
            );
        }
        assert!(icon_png_cached(&cache, &key, 96).is_none());
        // a broken photo written just now: not remembered, it may still be being written
        let fresh = dir.join("fresh.jpg");
        std::fs::write(&fresh, [0xFF, 0xD8, 0xFF, 0xE0, 0, 0]).unwrap();
        let key = format!("thumb/{}", fresh.display());
        assert!(icon_png_cached(&cache, &key, 256).is_none());
        let stamp = file_stamp(&std::fs::metadata(&fresh).unwrap()).unwrap();
        let name = cache_file_name(&key, Some(stamp.mtime_ms));
        assert!(!is_remembered(&((name, 256), stamp.len)));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Set `path`'s mtime `secs_ago` seconds back and return its stamp.
    #[cfg(not(windows))]
    fn age(path: &Path, secs_ago: u64) -> FileStamp {
        let then = std::time::SystemTime::now() - std::time::Duration::from_secs(secs_ago);
        set_mtime(path, then);
        file_stamp(&std::fs::metadata(path).unwrap()).unwrap()
    }

    #[cfg(not(windows))]
    fn set_mtime(path: &Path, t: std::time::SystemTime) {
        std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(t)
            .unwrap();
    }

    /// A file system that keeps the mtime to the second can show a half-written photo and the
    /// finished one with the same mtime. The miss on the half is keyed with its length too, so
    /// the finished photo is tried again and drawn.
    #[cfg(not(windows))]
    #[test]
    fn a_half_written_photo_finished_under_the_same_mtime_is_drawn() {
        let dir = std::env::temp_dir().join(format!("trove-icons-half-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let rgb: Vec<u8> = (0..320u32 * 240)
            .flat_map(|i| [(i % 251) as u8, (i % 127) as u8, (i % 61) as u8])
            .collect();
        let mut whole = Vec::new();
        image::ImageEncoder::write_image(
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut whole, 85),
            &rgb,
            320,
            240,
            image::ExtendedColorType::Rgb8,
        )
        .unwrap();
        let photo = dir.join("half.jpg");
        std::fs::write(&photo, &whole[..whole.len() / 2]).unwrap();
        let stamp = age(&photo, 60);
        let cache = dir.join("cache");
        let key = format!("thumb/{}", photo.display());
        assert!(icon_png_cached(&cache, &key, 256).is_none(), "half a JPEG");
        let name = cache_file_name(&key, Some(stamp.mtime_ms));
        assert!(is_remembered(&((name, 256), stamp.len)), "a settled miss");
        // finished, and its mtime put back to the same instant
        std::fs::write(&photo, &whole).unwrap();
        set_mtime(
            &photo,
            std::time::UNIX_EPOCH + std::time::Duration::from_millis(stamp.mtime_ms),
        );
        let after = file_stamp(&std::fs::metadata(&photo).unwrap()).unwrap();
        assert_eq!(after.mtime_ms, stamp.mtime_ms, "same mtime");
        assert!(
            icon_png_cached(&cache, &key, 256).is_some(),
            "the finished photo"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_file_counts_as_finished_ten_seconds_after_its_last_change() {
        let at = |ms: u64| std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms);
        let s = FileStamp {
            mtime_ms: 1_000_000,
            len: 1,
        };
        assert!(!is_settled(s, at(1_000_000)));
        assert!(!is_settled(s, at(1_009_999)));
        assert!(is_settled(s, at(1_010_000)));
        // a modified time ahead of the clock
        assert!(!is_settled(s, at(999_000)));
    }

    #[test]
    fn remembered_failures_are_bounded() {
        let mut set = HashSet::new();
        for i in 0..5 {
            note_failure(&mut set, ((format!("k{i}"), 96), 7), 3);
        }
        // three held, then cleared for the fourth, then the fifth
        assert_eq!(set.len(), 2);
        assert!(set.contains(&(("k4".to_string(), 96), 7)));
        assert!(!set.contains(&(("k0".to_string(), 96), 7)));
    }

    fn mk(name: &str) -> MemKey {
        (name.to_string(), 16)
    }

    fn val(len: usize) -> Arc<[u8]> {
        vec![0u8; len].into()
    }

    #[test]
    fn the_memory_cache_forgets_the_least_recently_used_once_over_its_byte_cap() {
        let mut lru = ByteLru::new(100);
        lru.insert(mk("a"), val(40));
        lru.insert(mk("b"), val(40));
        // a read is a use: `a` is now the newest, so `b` is the one to go
        assert!(lru.get(&mk("a")).is_some());
        lru.insert(mk("c"), val(40));
        assert!(
            lru.get(&mk("b")).is_none(),
            "the least recently used is evicted"
        );
        assert!(lru.get(&mk("a")).is_some() && lru.get(&mk("c")).is_some());
        assert_eq!(lru.bytes, 80);
        assert_eq!(
            lru.map.len(),
            lru.order.len(),
            "the use order never drifts from the map"
        );
    }

    #[test]
    fn replacing_an_entry_does_not_count_its_bytes_twice() {
        let mut lru = ByteLru::new(100);
        lru.insert(mk("a"), val(60));
        lru.insert(mk("a"), val(30));
        assert_eq!(lru.bytes, 30);
        assert_eq!((lru.map.len(), lru.order.len()), (1, 1));
    }

    #[test]
    fn a_value_bigger_than_the_whole_cache_is_not_kept_and_evicts_nothing() {
        let mut lru = ByteLru::new(100);
        lru.insert(mk("a"), val(50));
        lru.insert(mk("huge"), val(101));
        assert!(lru.get(&mk("huge")).is_none());
        assert!(lru.get(&mk("a")).is_some());
        assert_eq!(lru.bytes, 50);
    }

    #[test]
    fn only_a_png_written_to_its_end_counts_as_cached() {
        let png = encode_png(2, 2, &[7u8; 16]).unwrap();
        assert!(is_whole_png(&png), "what encode_png writes passes");
        // a write cut short keeps a valid signature — the case the old check let through
        assert!(png[..png.len() - 1].starts_with(PNG_SIGNATURE));
        assert!(!is_whole_png(&png[..png.len() - 1]));
        assert!(!is_whole_png(&png[..png.len() / 2]));
        assert!(!is_whole_png(b""));
        assert!(!is_whole_png(PNG_IEND));
    }

    #[test]
    fn an_atomic_write_replaces_the_file_whole_and_leaves_no_temp_behind() {
        let dir = std::env::temp_dir().join(format!("trove-icons-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("file_x.png");
        std::fs::write(&file, b"old, and truncated").unwrap();
        let png = encode_png(1, 1, &[1, 2, 3, 4]).unwrap();
        write_atomically(&file, &png).unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), png);
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().collect();
        assert_eq!(left.len(), 1, "the temp file was renamed, not copied");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_disk_cache_is_trimmed_oldest_first_to_its_cap() {
        let t = |s| std::time::UNIX_EPOCH + std::time::Duration::from_secs(s);
        let files = vec![
            (PathBuf::from("new"), t(30), 40),
            (PathBuf::from("old"), t(10), 40),
            (PathBuf::from("mid"), t(20), 40),
        ];
        assert_eq!(
            pick_victims(files.clone(), 80),
            vec![PathBuf::from("old")],
            "one file over: the oldest goes"
        );
        assert_eq!(
            pick_victims(files.clone(), 50),
            vec![PathBuf::from("old"), PathBuf::from("mid")]
        );
        assert!(
            pick_victims(files, 120).is_empty(),
            "under the cap nothing goes"
        );
    }

    #[test]
    fn pruning_a_real_cache_folder_removes_the_overflow_and_dead_temp_files() {
        let dir = std::env::temp_dir().join(format!("trove-icons-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sub = dir.join("icons").join("thumb").join("96");
        std::fs::create_dir_all(&sub).unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        for (name, age) in [("a.png", 3), ("b.png", 2), ("c.png", 1)] {
            let p = sub.join(name);
            std::fs::write(&p, [0u8; 100]).unwrap();
            let f = std::fs::File::options().write(true).open(&p).unwrap();
            f.set_modified(old - std::time::Duration::from_secs(age))
                .unwrap();
        }
        let dead = sub.join("x.1-0.tmp");
        std::fs::write(&dead, b"half").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&dead)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let live = sub.join("y.1-1.tmp");
        std::fs::write(&live, b"in flight").unwrap();
        assert_eq!(
            prune_disk_cache(&dir, 200),
            2,
            "the oldest PNG and the dead temp"
        );
        assert!(!sub.join("a.png").exists() && !dead.exists());
        assert!(sub.join("b.png").exists() && sub.join("c.png").exists());
        assert!(
            live.exists(),
            "a temp file that may still be mid-write is left alone"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_held_lock_is_given_up_on_after_the_wait_not_forever() {
        let m = Mutex::new(());
        let held = m.lock().unwrap();
        let t = std::time::Instant::now();
        assert!(lock_within(&m, std::time::Duration::from_millis(50)).is_none());
        assert!(t.elapsed() >= std::time::Duration::from_millis(50));
        drop(held);
        assert!(lock_within(&m, std::time::Duration::from_millis(50)).is_some());
    }

    #[test]
    fn a_lock_freed_during_the_wait_is_taken() {
        let m = Arc::new(Mutex::new(()));
        let holder = {
            let m = Arc::clone(&m);
            let (tx, rx) = std::sync::mpsc::channel();
            let h = std::thread::spawn(move || {
                let _g = m.lock().unwrap();
                tx.send(()).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(30));
            });
            rx.recv().unwrap();
            h
        };
        assert!(lock_within(&m, std::time::Duration::from_secs(5)).is_some());
        holder.join().unwrap();
    }

    #[test]
    fn requests_are_laned_by_kind_without_touching_the_disk() {
        assert_eq!(lane_of("/ext/txt"), IconLane::Quick);
        assert_eq!(lane_of("/app/X%21App"), IconLane::Quick);
        assert_eq!(lane_of("/file/C%3A%5Ca.exe"), IconLane::File);
        assert_eq!(lane_of("/thumb/C%3A%5Ca.jpg"), IconLane::Image);
        assert_eq!(lane_of("/big/C%3A%5Cdir"), IconLane::Image);
        assert_eq!(lane_of("/nonsense"), IconLane::Quick);
        // the deadline asks only the keys that read a file
        assert_eq!(key_path(r"file/\\nas\a.exe"), Some(r"\\nas\a.exe"));
        assert_eq!(key_path(r"thumb/Z:\a.jpg"), Some(r"Z:\a.jpg"));
        assert_eq!(key_path(r"big/C:\dir"), Some(r"C:\dir"));
        assert_eq!(key_path("ext/txt"), None);
        assert_eq!(key_path("app/X!App"), None);
    }

    /// The HTTP route has to admit the new kind, or the webview asks for a URL that 404s.
    #[test]
    fn the_icon_route_accepts_an_app_key_and_keeps_its_punctuation() {
        let (key, size) = parse_icon_request(
            "/app/Microsoft.WindowsCalculator_8wekyb3d8bbwe%21App",
            Some("size=16"),
        )
        .expect("an app key is a valid request");
        assert_eq!(key, "app/Microsoft.WindowsCalculator_8wekyb3d8bbwe!App");
        assert_eq!(size, 16);
        // an app key is a small icon, so it snaps to 16 / 32 and never to 48
        assert_eq!(
            parse_icon_request("/app/X", Some("size=200")).unwrap().1,
            32
        );
        assert_eq!(parse_icon_request("/app/", Some("size=16")), None);
    }
}
