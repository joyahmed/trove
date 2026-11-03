//! Save and load the name table to disk, zstd-compressed (plan 21C.2b).
//!
//! Built on `Table::rows()`; the rows are written parents-first by a breadth-first pass.
//!
//! File = zstd( "TRVI", version u32, root, count u32, then per row in parents-first order:
//! parent index u32 (`NONE` = directly in the root), flags u8 (`F_DIR`, `F_ID`), name length
//! u16, name, and with `F_ID` the row's NTFS file id u128 ). Version 2 added the id: the change
//! journal finds a row by it (`Table::row_by_id`). Anything wrong with the bytes, or another
//! version, is an `Err`, never a panic; the caller then deletes the file and walks again.

use std::io::{self, Write};
use std::path::{Path, PathBuf};

use super::table::{Table, TOP};

const MAGIC: &[u8; 4] = b"TRVI";
/// Bump when the layout changes; an older file is then refused and the index walks again.
pub const VERSION: u32 = 2;
/// Row flags: a folder; a file id follows the name.
const F_DIR: u8 = 1;
const F_ID: u8 = 2;
const NONE: u32 = u32::MAX;
const LEVEL: i32 = 3;
/// A file that unpacks to more than this is not ours (1.6 M rows is about 60 MB).
const MAX_RAW: u64 = 4 << 30;

fn bad(why: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, format!("index file: {why}"))
}

/// The table as the bytes zstd packs.
fn encode(t: &Table) -> io::Result<Vec<u8>> {
    let rows: Vec<(u32, u32, &str, bool)> = t.rows().collect();
    if rows.len() != t.len() {
        return Err(bad("row count does not match the table"));
    }
    // children of each parent, as ranges of `kids` (slot 0 = directly in the root)
    let slot = |parent: u32| {
        if parent == TOP {
            0
        } else {
            parent as usize + 1
        }
    };
    let max_row = rows.last().map_or(0, |r| r.0 as usize);
    let mut start = vec![0u32; max_row + 3];
    for &(_, parent, _, _) in &rows {
        if parent != TOP && parent as usize > max_row {
            return Err(bad("a row lost its parent"));
        }
        start[slot(parent) + 1] += 1;
    }
    for i in 1..start.len() {
        start[i] += start[i - 1];
    }
    let mut fill = start.clone();
    let mut kids = vec![0u32; rows.len()];
    // position of a row in `rows`
    let mut pos = vec![u32::MAX; max_row + 1];
    for (i, &(r, parent, _, _)) in rows.iter().enumerate() {
        pos[r as usize] = i as u32;
        let f = &mut fill[slot(parent)];
        kids[*f as usize] = i as u32;
        *f += 1;
    }
    // breadth-first from the root: parents before children
    let mut order: Vec<u32> = Vec::with_capacity(rows.len());
    let mut at_in_order = vec![u32::MAX; rows.len()];
    order.extend_from_slice(&kids[start[0] as usize..start[1] as usize]);
    let mut head = 0;
    while head < order.len() {
        let i = order[head];
        at_in_order[i as usize] = head as u32;
        head += 1;
        let (row, ..) = rows[i as usize];
        let s = slot(row);
        order.extend_from_slice(&kids[start[s] as usize..start[s + 1] as usize]);
    }
    if order.len() != rows.len() {
        return Err(bad("a row lost its parent"));
    }
    let root = t.root().to_string_lossy();
    let mut out = Vec::with_capacity(rows.len() * 24 + 64);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&(root.len() as u32).to_le_bytes());
    out.extend_from_slice(root.as_bytes());
    out.extend_from_slice(&(order.len() as u32).to_le_bytes());
    for &i in &order {
        let (_, parent, name, is_dir) = rows[i as usize];
        let p = if parent == TOP {
            NONE
        } else {
            at_in_order[pos[parent as usize] as usize]
        };
        let name = name.as_bytes();
        let len = u16::try_from(name.len()).map_err(|_| bad("a name is too long"))?;
        let id = t.id_of(rows[i as usize].0);
        let flags = if is_dir { F_DIR } else { 0 } | if id.is_some() { F_ID } else { 0 };
        out.extend_from_slice(&p.to_le_bytes());
        out.push(flags);
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(name);
        if let Some(id) = id {
            out.extend_from_slice(&id.to_le_bytes());
        }
    }
    Ok(out)
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> io::Result<&'a [u8]> {
        if self.0.len() < n {
            return Err(bad("cut short"));
        }
        let (head, rest) = self.0.split_at(n);
        self.0 = rest;
        Ok(head)
    }
    fn u32(&mut self) -> io::Result<u32> {
        let b: [u8; 4] = self.take(4)?.try_into().map_err(|_| bad("cut short"))?;
        Ok(u32::from_le_bytes(b))
    }
    fn u16(&mut self) -> io::Result<u16> {
        let b: [u8; 2] = self.take(2)?.try_into().map_err(|_| bad("cut short"))?;
        Ok(u16::from_le_bytes(b))
    }
    fn u128(&mut self) -> io::Result<u128> {
        let b: [u8; 16] = self.take(16)?.try_into().map_err(|_| bad("cut short"))?;
        Ok(u128::from_le_bytes(b))
    }
}

fn decode(raw: &[u8]) -> io::Result<Table> {
    let mut rd = Reader(raw);
    if rd.take(4)? != MAGIC {
        return Err(bad("not a Trove index"));
    }
    if rd.u32()? != VERSION {
        return Err(bad("another version"));
    }
    let root_len = rd.u32()? as usize;
    let root = std::str::from_utf8(rd.take(root_len)?).map_err(|_| bad("root is not text"))?;
    let count = rd.u32()? as usize;
    // each row is at least 7 bytes; refuse a count the bytes cannot hold
    if count > rd.0.len() / 7 {
        return Err(bad("row count too big"));
    }
    let mut t = Table::new(PathBuf::from(root));
    let mut rows: Vec<u32> = Vec::with_capacity(count);
    for _ in 0..count {
        let p = rd.u32()?;
        let flags = rd.take(1)?[0];
        if flags & !(F_DIR | F_ID) != 0 {
            return Err(bad("bad flag"));
        }
        let dir = flags & F_DIR != 0;
        let len = rd.u16()? as usize;
        let name = std::str::from_utf8(rd.take(len)?).map_err(|_| bad("name is not text"))?;
        let id = if flags & F_ID != 0 { rd.u128()? } else { 0 };
        let parent = if p == NONE {
            TOP
        } else {
            *rows
                .get(p as usize)
                .ok_or_else(|| bad("parent out of order"))?
        };
        let row = t
            .insert(parent, name, dir)
            .ok_or_else(|| bad("row refused"))?;
        t.set_id(row, id);
        rows.push(row);
    }
    if !rd.0.is_empty() {
        return Err(bad("extra bytes"));
    }
    if t.len() != count {
        return Err(bad("duplicate rows"));
    }
    t.shrink_to_fit();
    Ok(t)
}

/// Write the table to `path` (compressed). Goes to a `.tmp` beside it first, then renames,
/// so a crash leaves the old file or none.
pub fn save(t: &Table, path: &Path) -> io::Result<()> {
    let raw = encode(t)?;
    let packed = zstd::stream::encode_all(&raw[..], LEVEL)?;
    let tmp = path.with_extension("tmp");
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut f = std::fs::File::create(&tmp)?;
    f.write_all(&packed)?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(&tmp, path)
}

/// Read a table back. Any damage or another version is an `Err`.
pub fn load(path: &Path) -> io::Result<Table> {
    let packed = std::fs::read(path)?;
    let dec = zstd::stream::read::Decoder::new(&packed[..])?;
    let mut raw = Vec::new();
    io::Read::read_to_end(&mut io::Read::take(dec, MAX_RAW), &mut raw)
        .map_err(|e| bad(&e.to_string()))?;
    decode(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::index::test_util::Scratch;
    use std::time::Instant;

    fn sample() -> Table {
        let mut t = Table::new(if cfg!(windows) { r"C:\h" } else { "/h" });
        let docs = t.insert(TOP, "Docs", true).unwrap();
        t.insert(docs, "Report.TXT", false).unwrap();
        let src = t.insert(TOP, "src", true).unwrap();
        let deep = t.insert(src, "deep", true).unwrap();
        t.insert(deep, "ünï.rs", false).unwrap();
        t.insert(TOP, "top.md", false).unwrap();
        // holes: a removed folder and its child, then a reused slot
        let gone = t.insert(TOP, "gone", true).unwrap();
        t.insert(gone, "x", false).unwrap();
        t.remove(gone);
        t.insert(docs, "later", false).unwrap();
        t
    }

    fn same(a: &Table, b: &Table) {
        assert_eq!(a.root(), b.root());
        assert_eq!(a.len(), b.len());
        for q in ["report", "rs", "docs", "x", "top", "later", "deep", "gone"] {
            let (ra, na) = a.search(q, 50);
            let (rb, nb) = b.search(q, 50);
            assert_eq!(na, nb, "{q}");
            let pa: Vec<_> = ra.iter().map(|&r| (a.path_of(r), a.is_dir(r))).collect();
            let pb: Vec<_> = rb.iter().map(|&r| (b.path_of(r), b.is_dir(r))).collect();
            assert_eq!(pa, pb, "{q}");
        }
    }

    #[test]
    fn store_round_trip_keeps_rows() {
        let dir = Scratch::new("store-rt");
        let file = dir.path().join("index.zst");
        let t = sample();
        assert_eq!(t.len(), 7);
        save(&t, &file).unwrap();
        let back = load(&file).unwrap();
        same(&t, &back);
        assert_eq!(back.len(), 7);
        assert!(back.row_of(&back.root().join("src").join("deep")).is_some());
        assert!(back.row_of(&back.root().join("gone")).is_none());
        let rep = back.row_of(&back.root().join("Docs").join("Report.TXT"));
        assert_eq!(back.name(rep.unwrap()), "Report.TXT");
    }

    #[test]
    fn store_round_trip_keeps_file_ids() {
        let dir = Scratch::new("store-ids");
        let file = dir.path().join("ids.zst");
        let mut t = sample();
        let docs = t.row_of(&t.root().join("Docs")).unwrap();
        let rep = t.row_of(&t.root().join("Docs").join("Report.TXT")).unwrap();
        // a 128-bit id (ReFS) and a 64-bit one (NTFS, zero-extended); `top.md` has none
        t.set_id(docs, u128::MAX - 5);
        t.set_id(rep, 0x1234_5678_9abc);
        save(&t, &file).unwrap();
        let back = load(&file).unwrap();
        same(&t, &back);
        let at = |p: &[&str]| {
            let path = p.iter().fold(back.root().to_path_buf(), |a, n| a.join(n));
            back.row_of(&path).unwrap()
        };
        assert_eq!(back.id_of(at(&["Docs"])), Some(u128::MAX - 5));
        assert_eq!(
            back.id_of(at(&["Docs", "Report.TXT"])),
            Some(0x1234_5678_9abc)
        );
        assert_eq!(
            back.row_by_id(0x1234_5678_9abc),
            Some(at(&["Docs", "Report.TXT"]))
        );
        assert_eq!(back.id_of(at(&["top.md"])), None);
    }

    #[test]
    fn store_refuses_a_version_1_file() {
        let mut raw = encode(&sample()).unwrap();
        raw[4..8].copy_from_slice(&1u32.to_le_bytes());
        assert!(decode(&raw).is_err());
    }

    #[test]
    fn store_round_trips_an_empty_table() {
        let dir = Scratch::new("store-empty");
        let file = dir.path().join("e.zst");
        save(&Table::new(dir.path()), &file).unwrap();
        let back = load(&file).unwrap();
        assert_eq!(back.len(), 0);
        assert_eq!(back.root(), dir.path());
    }

    #[test]
    fn store_refuses_damage_without_panicking() {
        let dir = Scratch::new("store-bad");
        let file = dir.path().join("i.zst");
        save(&sample(), &file).unwrap();
        let good = std::fs::read(&file).unwrap();
        assert!(load(&dir.path().join("none")).is_err());
        std::fs::write(&file, b"").unwrap();
        assert!(load(&file).is_err());
        std::fs::write(&file, b"not zstd at all").unwrap();
        assert!(load(&file).is_err());
        std::fs::write(&file, &good[..good.len() / 2]).unwrap();
        assert!(load(&file).is_err());
        for i in 0..good.len() {
            let mut b = good.clone();
            b[i] ^= 0xff;
            std::fs::write(&file, &b).unwrap();
            let _ = load(&file); // Ok or Err, never a panic
        }
    }

    #[test]
    fn store_refuses_another_version_and_bad_parents() {
        let mut raw = encode(&sample()).unwrap();
        assert!(decode(&raw).is_ok());
        raw[4] = 99;
        assert!(decode(&raw).is_err());
        // a row whose parent is itself
        let mut t2 = Table::new("/r");
        t2.insert(TOP, "a", false).unwrap();
        let mut raw = encode(&t2).unwrap();
        let first = raw.len() - (4 + 1 + 2 + 1);
        raw[first..first + 4].copy_from_slice(&0u32.to_le_bytes());
        assert!(decode(&raw).is_err());
    }

    /// 1 M synthetic rows: file size and load time. `cargo test --release --lib
    /// store_bench -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn store_bench_one_million_rows() {
        let mut t = Table::new(if cfg!(windows) {
            r"C:\Users\x"
        } else {
            "/home/x"
        });
        let mut n = 0;
        'o: for a in 0..100 {
            let da = t.insert(TOP, &format!("project-{a}"), true).unwrap();
            for b in 0..10 {
                let db = t.insert(da, &format!("src{b}"), true).unwrap();
                for c in 0..1000 {
                    let name = format!("Component_{a}_{b}_{c}.tsx");
                    t.insert(db, &name, false).unwrap();
                    n += 1;
                    if n >= 1_000_000 {
                        break 'o;
                    }
                }
            }
        }
        let dir = Scratch::new("store-bench");
        let file = dir.path().join("i.zst");
        let s = Instant::now();
        save(&t, &file).unwrap();
        let save_ms = s.elapsed().as_millis();
        let size = std::fs::metadata(&file).unwrap().len();
        let s = Instant::now();
        let back = load(&file).unwrap();
        eprintln!(
            "store: {} rows, {} bytes ({:.1} MB), save {save_ms} ms, load {} ms",
            back.len(),
            size,
            size as f64 / 1e6,
            s.elapsed().as_millis()
        );
        assert_eq!(back.len(), t.len());
    }
}
