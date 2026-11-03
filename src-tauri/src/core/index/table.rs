//! The name table (plan 21C): every file and folder under one root, one row each, searched in
//! memory.
//!
//! Names live lowercased in ONE buffer, `\n` after each, so a search is a `memmem` scan of one
//! long byte slice rather than a million small strings. A row is a slot in a few parallel
//! vectors (`parent`, the name slot); no size or date — the ~20 rows shown fetch those themselves
//! (`entry_from`).
//!
//! The buffer only grows: a rename appends the new name and marks the old one dead, a remove
//! marks it dead. That keeps the name starts in increasing order, which is what lets a match
//! position be turned back into its row by a binary search. The dead bytes are the cost; the
//! table is rebuilt by every walk, so they never pile up for long.
//!
//! Memory (plan 21C budget, ~2.2M rows on one machine): nothing is allocated per row. A name
//! whose case differs keeps its real spelling in the same buffer, after a NUL; a folder's name
//! ends in `/` instead of `\n`, a removed row's parent is `FREE`, so there is no flags vector;
//! a file id is 6 bytes (NTFS record number and sequence); row r owns name
//! slot r until a rename or a reused row breaks that, and only the exceptions are stored; the
//! two lookups (folder + name → row, file id → row) are open-addressing tables of bare row
//! numbers whose keys are read back from the rows themselves.

use std::collections::hash_map::RandomState;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::hash::{BuildHasher, Hasher};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use memchr::memmem;

/// The `parent` of a row directly inside the root.
pub const TOP: u32 = u32::MAX;
/// A name slot whose row was renamed or removed.
const DEAD: u32 = u32::MAX;

/// The `parent` of a removed row, waiting in `free` for reuse.
const FREE: u32 = u32::MAX - 1;

/// What ends a name slot: a folder's `/` (no file system allows it in a name), else `\n`.
const END_DIR: u8 = b'/';
const END_FILE: u8 = b'\n';

/// Between a name and its real spelling in `names`. No file system allows NUL in a name.
const CASE_SEP: u8 = 0;

/// `id_lo`/`id_seq` hold this when the id does not fit their 48 bits (kept in `wide_ids`).
/// An NTFS id is a 32-bit-sized record number and a 16-bit sequence, so it always fits.
const WIDE: (u32, u16) = (u32::MAX, u16::MAX);

/// Below this many names one thread is quicker than starting eight.
const SPLIT_FROM: usize = 50_000;

/// How good a hit is, best first (plan 21C "Ranking").
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Tier {
    Exact,
    Prefix,
    Word,
    Any,
}

pub struct Table {
    root: PathBuf,
    /// Each name slot: the lowercased name, then — only when the real spelling differs —
    /// `CASE_SEP` and the real spelling, then `END_DIR` or `END_FILE`. Searches look only
    /// before the `CASE_SEP`.
    names: Vec<u8>,
    /// Where each name slot starts in `names`; increasing.
    name_at: Vec<u32>,
    /// Row r's name is slot r unless `row_moved` has bit r; then it is `row_slot[r]`.
    row_moved: Bits,
    row_slot: HashMap<u32, u32>,
    /// Slot s belongs to row s unless `slot_moved` has bit s; then to `slot_row[s]` (or `DEAD`).
    slot_moved: Bits,
    slot_row: HashMap<u32, u32>,
    /// `TOP`, a folder's row, or `FREE`.
    parent: Vec<u32>,
    /// Live rows whose real spelling is kept beside the lowercased one.
    cased: usize,
    /// (parent, name) → row: how a watcher's path finds its row without a scan. The key is
    /// compared against the row itself, so there are no false hits.
    by_name: RowIndex,
    free: Vec<u32>,
    live: usize,
    /// Each row's file id: bits 0..32 and 48..64 (0 = none known, `WIDE` = see `wide_ids`);
    /// bits 32..48 are 0 on NTFS. Grow only once an id is set.
    id_lo: Vec<u32>,
    id_seq: Vec<u16>,
    wide_ids: HashMap<u32, u128>,
    /// file id → row, for the rows that have one.
    by_id: RowIndex,
}

/// One bit per index, grown on demand.
#[derive(Default)]
struct Bits(Vec<u64>);

impl Bits {
    fn get(&self, i: usize) -> bool {
        self.0.get(i / 64).is_some_and(|w| w >> (i % 64) & 1 == 1)
    }

    fn set(&mut self, i: usize, on: bool) {
        if on {
            if self.0.len() <= i / 64 {
                self.0.resize(i / 64 + 1, 0);
            }
            self.0[i / 64] |= 1 << (i % 64);
        } else if let Some(w) = self.0.get_mut(i / 64) {
            *w &= !(1 << (i % 64));
        }
    }

    fn bytes(&self) -> usize {
        self.0.capacity() * 8
    }
}

/// An empty `RowIndex` slot.
const EMPTY: u32 = u32::MAX;

/// A hash set of row numbers, linear probing, keyed by whatever the caller hashes a row to.
/// 4 bytes a slot where a `HashMap<(u32, u64), u32>` took 24 + 1, and it grows by half, not
/// to the next power of two. The caller hands in the row → hash function on every change,
/// since moving a row means re-hashing its neighbours.
#[derive(Default)]
struct RowIndex {
    slots: Vec<u32>,
    len: usize,
}

impl RowIndex {
    /// Where `hash` starts probing: its top bits scaled to the capacity.
    fn home(&self, hash: u64) -> usize {
        ((hash as u128 * self.slots.len() as u128) >> 64) as usize
    }

    fn next(&self, i: usize) -> usize {
        if i + 1 == self.slots.len() {
            0
        } else {
            i + 1
        }
    }

    /// The slot holding the first row that `hit` accepts, probing from `hash`.
    fn find(&self, hash: u64, mut hit: impl FnMut(u32) -> bool) -> Option<usize> {
        if self.slots.is_empty() {
            return None;
        }
        let mut i = self.home(hash);
        loop {
            let r = self.slots[i];
            if r == EMPTY {
                return None;
            }
            if hit(r) {
                return Some(i);
            }
            i = self.next(i);
        }
    }

    fn insert(&mut self, row: u32, hash: u64, hash_of: impl Fn(u32) -> u64) {
        // grown at 70% full: linear probing slows sharply past that
        if (self.len + 1) * 10 > self.slots.len() * 7 {
            let old = std::mem::take(&mut self.slots);
            self.slots = vec![EMPTY; (old.len() + old.len() / 2).max(16)];
            for r in old.into_iter().filter(|&r| r != EMPTY) {
                self.place(r, hash_of(r));
            }
        }
        self.place(row, hash);
        self.len += 1;
    }

    fn place(&mut self, row: u32, hash: u64) {
        let mut i = self.home(hash);
        while self.slots[i] != EMPTY {
            i = self.next(i);
        }
        self.slots[i] = row;
    }

    /// Empty slot `at`, shifting later rows of its run back so no search stops short.
    fn remove_at(&mut self, at: usize, hash_of: impl Fn(u32) -> u64) {
        let cap = self.slots.len();
        let back = |from: usize, to: usize| (to + cap - from) % cap;
        let (mut hole, mut j) = (at, at);
        loop {
            j = self.next(j);
            let r = self.slots[j];
            if r == EMPTY {
                break;
            }
            let home = self.home(hash_of(r));
            // `r` may fill the hole only if its home is not between the hole and it
            if back(home, j) >= back(hole, j) {
                self.slots[hole] = r;
                hole = j;
            }
        }
        self.slots[hole] = EMPTY;
        self.len -= 1;
    }

    fn bytes(&self) -> usize {
        self.slots.capacity() * 4
    }
}

/// A per-process seed, so file names cannot be picked to pile into one probe run.
fn seed() -> u64 {
    static SEED: OnceLock<u64> = OnceLock::new();
    *SEED.get_or_init(|| RandomState::new().build_hasher().finish())
}

const K: u64 = 0x9e37_79b9_7f4a_7c15;

fn finish(mut h: u64) -> u64 {
    h ^= h >> 33;
    h = h.wrapping_mul(0xff51_afd7_ed55_8ccd);
    h ^= h >> 33;
    h = h.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
    h ^ (h >> 33)
}

/// How (folder, name) is keyed in `by_name`. The name is already the key form (`key_name`).
fn name_hash(parent: u32, name: &[u8]) -> u64 {
    let mut h = seed() ^ (parent as u64).wrapping_mul(K) ^ (name.len() as u64);
    for chunk in name.chunks(8) {
        let mut w = [0u8; 8];
        w[..chunk.len()].copy_from_slice(chunk);
        h = (h.rotate_left(23) ^ u64::from_le_bytes(w)).wrapping_mul(K);
    }
    finish(h)
}

fn id_hash(id: u128) -> u64 {
    finish(seed() ^ (id as u64).wrapping_mul(K) ^ ((id >> 64) as u64).rotate_left(29))
}

/// A name as `by_name` keys it: NTFS folds case, a Linux or Mac disk need not.
fn key_name(name: &str) -> std::borrow::Cow<'_, str> {
    if cfg!(windows)
        && !name
            .bytes()
            .all(|b| b.is_ascii() && !b.is_ascii_uppercase())
    {
        name.to_lowercase().into()
    } else {
        name.into()
    }
}

/// Make room for `more` items, growing by a quarter rather than doubling: the vectors here
/// run to tens of MB, and doubling leaves up to half of that unused.
fn room<T>(v: &mut Vec<T>, more: usize) {
    if v.capacity() - v.len() < more {
        v.reserve_exact(more.max(v.len() / 4).max(64));
    }
}

/// Whether `at` begins a word: the start, or after a byte that is not a letter or digit.
fn word_start(name: &[u8], at: usize) -> bool {
    at == 0 || !name[at - 1].is_ascii_alphanumeric()
}

fn tier_of(name: &[u8], text: &[u8]) -> Tier {
    if name == text {
        return Tier::Exact;
    }
    if name.starts_with(text) {
        return Tier::Prefix;
    }
    if memmem::find_iter(name, text).any(|at| word_start(name, at)) {
        return Tier::Word;
    }
    Tier::Any
}

/// Folder names that hold tool caches, not anything a person made (lowercased). A dot-folder
/// is one too; the palette's `inCacheFolder` judges by the same list.
const CACHE_FOLDERS: [&[u8]; 5] = [
    b"node_modules",
    b"cache",
    b"caches",
    b"appdata",
    b"coresimulator",
];

/// A candidate while scanning: compared worst-last so a max-heap drops the worst.
#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct Cand {
    /// Under a dot-folder or a cache folder: below every other hit, whatever its tier.
    cache: bool,
    tier: Tier,
    len: u32,
    file: bool,
    row: u32,
}

/// Fewest letters a fuzzy query needs: two letters are a subsequence of nearly every name.
const FUZZY_MIN: usize = 3;

/// A fuzzy candidate, worst-last for the max-heap.
#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct FuzzyCand {
    /// Letters skipped between the first and last matched letter: tighter is better.
    gaps: u32,
    /// The match does not begin at the name's first letter.
    late: bool,
    len: u32,
    row: u32,
}

/// Leftmost subsequence match of `query` in `name`: (start, gaps) or `None`.
fn subsequence(name: &[u8], query: &[u8]) -> Option<(usize, u32)> {
    let first = memchr::memchr(query[0], name)?;
    let mut at = first + 1;
    for &c in &query[1..] {
        at += memchr::memchr(c, &name[at..])? + 1;
    }
    Some((first, (at - first - query.len()) as u32))
}

impl Table {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Table {
            root: root.into(),
            names: Vec::new(),
            name_at: Vec::new(),
            row_moved: Bits::default(),
            row_slot: HashMap::new(),
            slot_moved: Bits::default(),
            slot_row: HashMap::new(),
            parent: Vec::new(),
            cased: 0,
            by_name: RowIndex::default(),
            free: Vec::new(),
            live: 0,
            id_lo: Vec::new(),
            id_seq: Vec::new(),
            wide_ids: HashMap::new(),
            by_id: RowIndex::default(),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Rows in use.
    pub fn len(&self) -> usize {
        self.live
    }

    pub fn is_empty(&self) -> bool {
        self.live == 0
    }

    /// Names whose real case is kept on the side (plan 21C asks how many).
    pub fn cased(&self) -> usize {
        self.cased
    }

    /// Bytes held by everything in the table: every vector at its capacity, both lookup
    /// tables, and an estimate for the small exception maps (8 bytes a key + 1 control byte,
    /// at capacity). Not counted: the allocator's own overhead, which is small per allocation
    /// and there are only a dozen.
    pub fn bytes(&self) -> usize {
        let map = |cap: usize, entry: usize| cap * (entry + 1);
        self.names.capacity()
            + self.name_at.capacity() * 4
            + self.parent.capacity() * 4
            + self.free.capacity() * 4
            + self.id_lo.capacity() * 4
            + self.id_seq.capacity() * 2
            + self.row_moved.bytes()
            + self.slot_moved.bytes()
            + map(self.row_slot.capacity(), 8)
            + map(self.slot_row.capacity(), 8)
            + map(self.wide_ids.capacity(), 32)
            + self.by_name.bytes()
            + self.by_id.bytes()
    }

    /// Give back the room kept for growth. Worth calling once a walk or a load is done: up
    /// to a fifth of the vectors is spare until then.
    pub fn shrink_to_fit(&mut self) {
        self.names.shrink_to_fit();
        self.name_at.shrink_to_fit();
        self.parent.shrink_to_fit();
        self.free.shrink_to_fit();
        self.id_lo.shrink_to_fit();
        self.id_seq.shrink_to_fit();
        self.row_slot.shrink_to_fit();
        self.slot_row.shrink_to_fit();
        self.wide_ids.shrink_to_fit();
    }

    /// Where `bytes` goes, for the measurement test.
    #[cfg(all(test, windows))]
    pub(super) fn breakdown(&self) -> String {
        let real: usize = (0..self.name_at.len())
            .map(|s| self.span(s))
            .filter(|&(_, l, e)| l < e)
            .map(|(_, l, e)| e - l)
            .sum();
        format!(
            "names {} (real case {real}, {} cased) name_at {} parent {} ids {} by_name {} by_id {} moved {}+{}",
            self.names.capacity(),
            self.cased,
            self.name_at.capacity() * 4,
            self.parent.capacity() * 4,
            self.id_lo.capacity() * 6,
            self.by_name.bytes(),
            self.by_id.bytes(),
            self.row_slot.len(),
            self.slot_row.len()
        )
    }

    pub fn is_dir(&self, row: u32) -> bool {
        self.alive(row) && self.names[self.span(self.slot_of(row)).2] == END_DIR
    }

    fn alive(&self, row: u32) -> bool {
        self.parent.get(row as usize).is_some_and(|&p| p != FREE)
    }

    /// The name slot of a live row.
    fn slot_of(&self, row: u32) -> usize {
        if self.row_moved.get(row as usize) {
            self.row_slot
                .get(&row)
                .map_or(row as usize, |&s| s as usize)
        } else {
            row as usize
        }
    }

    /// The row a name slot belongs to, or `DEAD`.
    fn row_at(&self, slot: usize) -> u32 {
        if self.slot_moved.get(slot) {
            self.slot_row.get(&(slot as u32)).copied().unwrap_or(DEAD)
        } else {
            slot as u32
        }
    }

    fn set_slot_of(&mut self, row: u32, slot: usize) {
        let moved = slot != row as usize;
        self.row_moved.set(row as usize, moved);
        if moved {
            self.row_slot.insert(row, slot as u32);
        } else {
            self.row_slot.remove(&row);
        }
    }

    fn set_row_at(&mut self, slot: usize, row: u32) {
        let moved = row as usize != slot;
        self.slot_moved.set(slot, moved);
        if moved {
            self.slot_row.insert(slot as u32, row);
        } else {
            self.slot_row.remove(&(slot as u32));
        }
    }

    /// (start, end of the lowercased name, the slot's `\n`) of a name slot.
    fn span(&self, slot: usize) -> (usize, usize, usize) {
        let start = self.name_at[slot] as usize;
        // the byte before the next name start ends this name
        let end = self
            .name_at
            .get(slot + 1)
            .map_or(self.names.len(), |&n| n as usize)
            - 1;
        let lower = memchr::memchr(CASE_SEP, &self.names[start..end]).map_or(end, |p| start + p);
        (start, lower, end)
    }

    fn lower_name(&self, row: u32) -> &str {
        let (start, lower, _) = self.span(self.slot_of(row));
        // built from `&str` by `push_name`, so always UTF-8
        std::str::from_utf8(&self.names[start..lower]).unwrap_or_default()
    }

    /// Every live row as (row, parent, name as on disk, is a folder), in row order. A row
    /// directly in the root has parent `TOP`. Parents are NOT guaranteed to come first: a
    /// reused slot can hold a child below its parent's row.
    pub fn rows(&self) -> impl Iterator<Item = (u32, u32, &str, bool)> + '_ {
        (0..self.parent.len() as u32)
            .filter(|&r| self.alive(r))
            .map(|r| (r, self.parent[r as usize], self.name(r), self.is_dir(r)))
    }

    /// Record `row`'s file id (replacing any it had). Ignored for a dead row or id 0.
    pub fn set_id(&mut self, row: u32, id: u128) {
        if id == 0 || !self.alive(row) {
            return;
        }
        self.clear_id(row);
        if self.id_lo.len() <= row as usize {
            let more = self.parent.len() - self.id_lo.len();
            room(&mut self.id_lo, more);
            room(&mut self.id_seq, more);
            self.id_lo.resize(self.parent.len(), 0);
            self.id_seq.resize(self.parent.len(), 0);
        }
        let short = (id as u32, (id >> 48) as u16);
        let fits = id >> 64 == 0 && (id >> 32) as u16 == 0 && short != WIDE;
        let (lo, seq) = if fits { short } else { WIDE };
        self.id_lo[row as usize] = lo;
        self.id_seq[row as usize] = seq;
        if !fits {
            self.wide_ids.insert(row, id);
        }
        let hash = id_hash(id);
        // a hard link shares its file's id: the last row given it answers, as before
        if let Some(at) = self
            .by_id
            .find(hash, |r| self.id_of(r) == Some(id) && r != row)
        {
            self.by_id.slots[at] = row;
            return;
        }
        let mut index = std::mem::take(&mut self.by_id);
        index.insert(row, hash, |r| id_hash(self.id_of(r).unwrap_or(0)));
        self.by_id = index;
    }

    fn clear_id(&mut self, row: u32) {
        let Some(old) = self.id_of(row) else {
            return;
        };
        if let Some(at) = self.by_id.find(id_hash(old), |r| r == row) {
            let mut index = std::mem::take(&mut self.by_id);
            index.remove_at(at, |r| id_hash(self.id_of(r).unwrap_or(0)));
            self.by_id = index;
        }
        self.id_lo[row as usize] = 0;
        self.id_seq[row as usize] = 0;
        self.wide_ids.remove(&row);
    }

    /// The file id recorded for `row`, if any.
    pub fn id_of(&self, row: u32) -> Option<u128> {
        let (lo, seq) = (*self.id_lo.get(row as usize)?, self.id_seq[row as usize]);
        match (lo, seq) {
            (0, 0) => None,
            WIDE => self.wide_ids.get(&row).copied(),
            _ => Some(lo as u128 | (seq as u128) << 48),
        }
    }

    /// The row holding file id `id`.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn row_by_id(&self, id: u128) -> Option<u32> {
        if id == 0 {
            return None;
        }
        let at = self
            .by_id
            .find(id_hash(id), |r| self.id_of(r) == Some(id))?;
        let row = self.by_id.slots[at];
        self.alive(row).then_some(row)
    }

    /// The name as it is on disk.
    pub fn name(&self, row: u32) -> &str {
        let (start, lower, end) = self.span(self.slot_of(row));
        let bytes = if lower < end {
            &self.names[lower + 1..end]
        } else {
            &self.names[start..lower]
        };
        std::str::from_utf8(bytes).unwrap_or_default()
    }

    /// The name `by_name` keys a row by (see `key_name`).
    fn row_key(&self, row: u32) -> &[u8] {
        if cfg!(windows) {
            self.lower_name(row).as_bytes()
        } else {
            self.name(row).as_bytes()
        }
    }

    fn row_hash(&self, row: u32) -> u64 {
        name_hash(self.parent[row as usize], self.row_key(row))
    }

    /// Give `row` a new name slot holding `name`. The old slot, if any, is the caller's.
    fn push_name(&mut self, row: u32, name: &str, is_dir: bool) {
        let lower = name.to_lowercase();
        let cased = lower != name;
        let need = lower.len() + 1 + if cased { name.len() + 1 } else { 0 };
        room(&mut self.names, need);
        room(&mut self.name_at, 1);
        let slot = self.name_at.len();
        self.name_at.push(self.names.len() as u32);
        self.names.extend_from_slice(lower.as_bytes());
        if cased {
            self.names.push(CASE_SEP);
            self.names.extend_from_slice(name.as_bytes());
            self.cased += 1;
        }
        self.names.push(if is_dir { END_DIR } else { END_FILE });
        self.set_row_at(slot, row);
        self.set_slot_of(row, slot);
    }

    /// Mark a live row's current name slot dead.
    fn kill_name(&mut self, row: u32) {
        let slot = self.slot_of(row);
        let (_, lower, end) = self.span(slot);
        if lower < end {
            self.cased -= 1;
        }
        self.set_row_at(slot, DEAD);
    }

    fn index_name(&mut self, row: u32) {
        let hash = self.row_hash(row);
        let mut index = std::mem::take(&mut self.by_name);
        index.insert(row, hash, |r| self.row_hash(r));
        self.by_name = index;
    }

    /// Take `row` out of `by_name`; call while its parent and name are still the ones it was
    /// indexed under.
    fn unindex_name(&mut self, row: u32) {
        if let Some(at) = self.by_name.find(self.row_hash(row), |r| r == row) {
            let mut index = std::mem::take(&mut self.by_name);
            index.remove_at(at, |r| self.row_hash(r));
            self.by_name = index;
        }
    }

    /// The row of `name` inside `parent`, if there is one.
    pub fn find(&self, parent: u32, name: &str) -> Option<u32> {
        let key = key_name(name);
        let key = key.as_bytes();
        let at = self.by_name.find(name_hash(parent, key), |r| {
            self.parent[r as usize] == parent && self.row_key(r) == key
        })?;
        let row = self.by_name.slots[at];
        self.alive(row).then_some(row)
    }

    /// Add `name` inside `parent` and return its row. Already there: the same row, its
    /// folder flag brought up to date. ⛔ A name holding `\n` or NUL is refused (`None`): it
    /// would split in two in the buffer. Only a Linux disk can have one.
    pub fn insert(&mut self, parent: u32, name: &str, is_dir: bool) -> Option<u32> {
        if name.is_empty() || name.contains(['\n', '\0']) {
            return None;
        }
        if parent != TOP && !self.alive(parent) {
            return None;
        }
        if let Some(row) = self.find(parent, name) {
            let end = self.span(self.slot_of(row)).2;
            self.names[end] = if is_dir { END_DIR } else { END_FILE };
            return Some(row);
        }
        let row = match self.free.pop() {
            Some(row) => {
                self.parent[row as usize] = parent;
                row
            }
            None => {
                room(&mut self.parent, 1);
                self.parent.push(parent);
                (self.parent.len() - 1) as u32
            }
        };
        self.push_name(row, name, is_dir);
        self.index_name(row);
        self.live += 1;
        Some(row)
    }

    /// Remove a row and, for a folder, everything under it.
    pub fn remove(&mut self, row: u32) {
        if !self.alive(row) {
            return;
        }
        let mut gone: HashSet<u32> = HashSet::from([row]);
        if self.is_dir(row) {
            // repeat until nothing new: a moved folder can sit at a lower row than its parent
            loop {
                let before = gone.len();
                for r in 0..self.parent.len() as u32 {
                    if self.alive(r) && gone.contains(&self.parent[r as usize]) {
                        gone.insert(r);
                    }
                }
                if gone.len() == before {
                    break;
                }
            }
        }
        for r in gone {
            self.drop_row(r);
        }
    }

    fn drop_row(&mut self, row: u32) {
        self.clear_id(row);
        self.unindex_name(row);
        self.kill_name(row);
        self.parent[row as usize] = FREE;
        self.free.push(row);
        self.live -= 1;
    }

    /// The row a path names: `Some(TOP)` for the root itself, `None` when it is not in here.
    pub fn row_of(&self, path: &Path) -> Option<u32> {
        let rest = path.strip_prefix(&self.root).ok()?;
        let mut row = TOP;
        for part in rest.components() {
            let Component::Normal(name) = part else {
                return None;
            };
            row = self.find(row, &name.to_string_lossy())?;
        }
        Some(row)
    }

    /// Add a path whose parent folder is already in the table.
    pub fn insert_path(&mut self, path: &Path, is_dir: bool) -> Option<u32> {
        let parent = self.row_of(path.parent()?)?;
        let name = path.file_name()?.to_string_lossy();
        self.insert(parent, &name, is_dir)
    }

    pub fn remove_path(&mut self, path: &Path) -> bool {
        match self.row_of(path) {
            Some(row) if row != TOP => {
                self.remove(row);
                true
            }
            _ => false,
        }
    }

    /// A rename or move inside the root. The row keeps its number, so a folder's children
    /// follow it with no re-walk. `false` when `from` is unknown or `to`'s folder is.
    pub fn rename_path(&mut self, from: &Path, to: &Path) -> bool {
        let (Some(row), Some(new_parent), Some(new_name)) = (
            self.row_of(from).filter(|&r| r != TOP),
            to.parent().and_then(|p| self.row_of(p)),
            to.file_name().map(|n| n.to_string_lossy().into_owned()),
        ) else {
            return false;
        };
        if new_name.contains(['\n', '\0']) {
            self.remove(row);
            return false;
        }
        // something already at `to` is replaced, as the file system just did
        if let Some(old) = self.find(new_parent, &new_name).filter(|&r| r != row) {
            self.remove(old);
        }
        let is_dir = self.is_dir(row);
        self.unindex_name(row);
        self.kill_name(row);
        self.parent[row as usize] = new_parent;
        self.push_name(row, &new_name, is_dir);
        self.index_name(row);
        true
    }

    /// The full path of a row, built by following `parent` up to the root.
    pub fn path_of(&self, row: u32) -> PathBuf {
        let mut parts = Vec::new();
        let mut at = row;
        while at != TOP {
            parts.push(self.name(at));
            at = self.parent[at as usize];
        }
        let mut path = self.root.clone();
        for part in parts.iter().rev() {
            path.push(part);
        }
        path
    }

    /// Bytes of the path below the root: the "shorter path first" tie-break.
    fn path_len(&self, row: u32) -> usize {
        let mut len = 0;
        let mut at = row;
        while at != TOP {
            len += self.lower_name(at).len() + 1;
            at = self.parent[at as usize];
        }
        len
    }

    /// Whether a folder above `row` (below the root) is a dot-folder or a cache folder.
    fn in_cache_folder(&self, row: u32) -> bool {
        let mut at = self.parent[row as usize];
        while at != TOP {
            let name = self.lower_name(at).as_bytes();
            if (name.len() > 1 && name[0] == b'.') || CACHE_FOLDERS.contains(&name) {
                return true;
            }
            at = self.parent[at as usize];
        }
        false
    }

    /// Every name that holds each word of `text` (case folded). Returns the best `max` rows —
    /// anything under a dot-folder or cache folder last (BUG-S2: `readme` gave 20 `.config` /
    /// `.vscode` / `.cargo` READMEs, all short paths); then exact name, then name starts with
    /// it, then a word starts with it, then anywhere; ties to the shorter path, then folders
    /// before files — and how many matched in all.
    pub fn search(&self, text: &str, max: usize) -> (Vec<u32>, usize) {
        let text = text.trim().to_lowercase();
        let words: Vec<&str> = text.split_whitespace().collect();
        if words.is_empty() || max == 0 || self.name_at.is_empty() {
            return (Vec::new(), 0);
        }
        // the longest word drives the scan: it matches the fewest names
        let lead = (0..words.len())
            .max_by_key(|&i| words[i].len())
            .unwrap_or(0);
        let finder = memmem::Finder::new(words[lead].as_bytes());
        let others: Vec<memmem::Finder> = words
            .iter()
            .enumerate()
            .filter(|&(i, _)| i != lead)
            .map(|(_, w)| memmem::Finder::new(w.as_bytes()))
            .collect();
        // kept wider than `max` so the path tie-break below has rows to choose between
        let keep = (max * 4).max(64);
        let scan =
            |from: usize, to: usize| self.scan(from, to, &finder, &others, text.as_bytes(), keep);

        let slots = self.name_at.len();
        let threads = if slots < SPLIT_FROM {
            1
        } else {
            std::thread::available_parallelism().map_or(1, |n| n.get().min(8))
        };
        let (mut cands, total) = if threads == 1 {
            scan(0, slots)
        } else {
            let step = slots.div_ceil(threads);
            std::thread::scope(|s| {
                let parts: Vec<_> = (0..threads)
                    .map(|t| {
                        let scan = &scan;
                        s.spawn(move || scan(t * step, ((t + 1) * step).min(slots)))
                    })
                    .collect();
                parts.into_iter().fold((Vec::new(), 0), |(mut all, n), h| {
                    let (c, k) = h.join().unwrap_or_default();
                    all.extend(c);
                    (all, n + k)
                })
            })
        };
        let mut ranked: Vec<(bool, Tier, usize, bool, u32)> = cands
            .drain(..)
            .map(|c| (c.cache, c.tier, self.path_len(c.row), c.file, c.row))
            .collect();
        ranked.sort_unstable();
        ranked.truncate(max);
        (ranked.into_iter().map(|r| r.4).collect(), total)
    }

    /// `search`, and only when it finds nothing, `fuzzy`. The flag says which one answered.
    pub fn search_or_fuzzy(&self, text: &str, max: usize) -> (Vec<u32>, usize, bool) {
        let (rows, total) = self.search(text, max);
        if total > 0 {
            return (rows, total, false);
        }
        let (rows, total) = self.fuzzy(text, max);
        (rows, total, true)
    }

    /// Names that hold every letter of `text` (spaces ignored, case folded) in order but not
    /// side by side: `rprt` finds `report`. Fewer skipped letters first, a match from the
    /// first letter before a later one, cache folders last, then shorter names. Needs
    /// `FUZZY_MIN` letters. One pass of `memchr` hops per name, split over threads like
    /// `search`.
    pub fn fuzzy(&self, text: &str, max: usize) -> (Vec<u32>, usize) {
        let query: Vec<u8> = text
            .to_lowercase()
            .bytes()
            .filter(|b| !b.is_ascii_whitespace())
            .collect();
        if query.len() < FUZZY_MIN || max == 0 || self.name_at.is_empty() {
            return (Vec::new(), 0);
        }
        let keep = (max * 4).max(64);
        let scan = |from: usize, to: usize| self.fuzzy_scan(from, to, &query, keep);
        let slots = self.name_at.len();
        let threads = if slots < SPLIT_FROM {
            1
        } else {
            std::thread::available_parallelism().map_or(1, |n| n.get().min(8))
        };
        let (cands, total) = if threads == 1 {
            scan(0, slots)
        } else {
            let step = slots.div_ceil(threads);
            std::thread::scope(|s| {
                let parts: Vec<_> = (0..threads)
                    .map(|t| {
                        let scan = &scan;
                        s.spawn(move || scan(t * step, ((t + 1) * step).min(slots)))
                    })
                    .collect();
                parts.into_iter().fold((Vec::new(), 0), |(mut all, n), h| {
                    let (c, k) = h.join().unwrap_or_default();
                    all.extend(c);
                    (all, n + k)
                })
            })
        };
        let mut ranked: Vec<(bool, u32, bool, u32, usize, u32)> = cands
            .into_iter()
            .map(|c| {
                let cache = self.in_cache_folder(c.row);
                (cache, c.gaps, c.late, c.len, self.path_len(c.row), c.row)
            })
            .collect();
        ranked.sort_unstable();
        ranked.truncate(max);
        (ranked.into_iter().map(|r| r.5).collect(), total)
    }

    fn fuzzy_scan(
        &self,
        from: usize,
        to: usize,
        query: &[u8],
        keep: usize,
    ) -> (Vec<FuzzyCand>, usize) {
        let mut heap: BinaryHeap<FuzzyCand> = BinaryHeap::new();
        let mut total = 0;
        for slot in from..to.min(self.name_at.len()) {
            let row = self.row_at(slot);
            if row == DEAD {
                continue;
            }
            let (start, lower, _) = self.span(slot);
            let name = &self.names[start..lower];
            let Some((first, gaps)) = subsequence(name, query) else {
                continue;
            };
            total += 1;
            heap.push(FuzzyCand {
                gaps,
                late: first > 0,
                len: name.len() as u32,
                row,
            });
            if heap.len() > keep {
                heap.pop();
            }
        }
        (heap.into_vec(), total)
    }

    /// One thread's share: names `from..to`, the best `keep` of them and the match count.
    fn scan(
        &self,
        from: usize,
        to: usize,
        finder: &memmem::Finder,
        others: &[memmem::Finder],
        text: &[u8],
        keep: usize,
    ) -> (Vec<Cand>, usize) {
        if from >= to {
            return (Vec::new(), 0);
        }
        let lo = self.name_at[from] as usize;
        let hi = self
            .name_at
            .get(to)
            .map_or(self.names.len(), |&n| n as usize);
        let mut heap: BinaryHeap<Cand> = BinaryHeap::new();
        let mut total = 0;
        let mut pos = lo;
        while pos < hi {
            let Some(found) = finder.find(&self.names[pos..hi]) else {
                break;
            };
            let at = pos + found;
            let slot = self.name_at.partition_point(|&n| n as usize <= at) - 1;
            let (start, lower, end) = self.span(slot);
            // one look per name, however many times it matches
            pos = end + 1;
            // the leftmost hit is past the lowercased name: only the real spelling holds it
            if at + finder.needle().len() > lower {
                continue;
            }
            let row = self.row_at(slot);
            if row == DEAD {
                continue;
            }
            let name = &self.names[start..lower];
            if !others.iter().all(|f| f.find(name).is_some()) {
                continue;
            }
            total += 1;
            let mut cand = Cand {
                cache: false,
                tier: tier_of(name, text),
                len: name.len() as u32,
                file: !self.is_dir(row),
                row,
            };
            // the parent walk only for a name that could get in even at its best (not cache)
            if heap.len() >= keep && heap.peek().is_some_and(|worst| cand >= *worst) {
                continue;
            }
            cand.cache = self.in_cache_folder(row);
            heap.push(cand);
            if heap.len() > keep {
                heap.pop();
            }
        }
        (heap.into_vec(), total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(names: &[(&str, bool)]) -> Table {
        let mut t = Table::new("/r");
        for &(n, d) in names {
            t.insert(TOP, n, d);
        }
        t
    }

    fn names(t: &Table, rows: &[u32]) -> Vec<String> {
        rows.iter().map(|&r| t.name(r).to_string()).collect()
    }

    #[test]
    fn table_search_ranks_exact_then_prefix_then_word_then_any() {
        let t = table(&[
            ("myreport.txt", false),
            ("old report.txt", false),
            ("Report.txt", false),
            ("report", false),
            ("unrelated.md", false),
        ]);
        let (rows, total) = t.search("REPORT", 20);
        assert_eq!(total, 4);
        assert_eq!(
            names(&t, &rows),
            ["report", "Report.txt", "old report.txt", "myreport.txt"]
        );
        assert_eq!(t.search("zz", 5), (Vec::new(), 0));
    }

    #[test]
    fn every_word_must_match_and_the_total_counts_past_the_cap() {
        let t = table(&[
            ("rep 2024.pdf", false),
            ("rep 2023.pdf", false),
            ("2024 report", false),
            ("a1", false),
            ("a2", false),
            ("a3", false),
        ]);
        let (rows, _) = t.search("rep 2024", 20);
        // the whole text starts one name: that one first
        assert_eq!(names(&t, &rows), ["rep 2024.pdf", "2024 report"]);
        let (rows, total) = t.search("a", 2);
        assert_eq!((rows.len(), total), (2, 3));
    }

    #[test]
    fn folders_win_a_tie_and_shorter_paths_win_too() {
        let mut t = Table::new("/r");
        let deep = t.insert(TOP, "deep", true).unwrap();
        t.insert(deep, "todo", false);
        t.insert(TOP, "todo", true);
        let (rows, _) = t.search("todo", 5);
        assert_eq!(t.path_of(rows[0]), Path::new("/r/todo"));
        assert_eq!(t.path_of(rows[1]), Path::new("/r/deep/todo"));
        // same tier and length: the folder first
        let mut t = Table::new("/r");
        t.insert(TOP, "plan", false);
        t.insert(TOP, "plan2", false);
        let dir = t.insert(TOP, "plan1", true).unwrap();
        let (rows, _) = t.search("plan", 5);
        assert_eq!(rows[1], dir);
    }

    #[test]
    fn a_dot_folder_or_cache_readme_ranks_after_a_user_readme() {
        let mut t = Table::new("/r");
        let cargo = t.insert(TOP, ".cargo", true).unwrap();
        let x = t.insert(cargo, "x", true).unwrap();
        t.insert(x, "README.md", false);
        let lib = t.insert(TOP, "Library", true).unwrap();
        let caches = t.insert(lib, "Caches", true).unwrap();
        t.insert(caches, "README.md", false);
        let nm = t.insert(TOP, "node_modules", true).unwrap();
        t.insert(nm, "README.md", false);
        let projects = t.insert(TOP, "projects", true).unwrap();
        let mine = t.insert(projects, "a-much-longer-folder", true).unwrap();
        t.insert(mine, "README.md", false);
        // the dot-folder's own name is not under a dot-folder
        let (rows, total) = t.search("readme", 1);
        assert_eq!(total, 4);
        assert_eq!(
            t.path_of(rows[0]),
            Path::new("/r/projects/a-much-longer-folder/README.md")
        );
        let (rows, _) = t.search("cargo", 5);
        assert_eq!(t.path_of(rows[0]), Path::new("/r/.cargo"));
    }

    #[test]
    fn rows_list_live_rows_and_ids_follow_them() {
        let mut t = Table::new(if cfg!(windows) { r"C:\h" } else { "/h" });
        let a = t.insert(TOP, "A", true).unwrap();
        let b = t.insert(a, "b.txt", false).unwrap();
        let c = t.insert(TOP, "c", false).unwrap();
        t.set_id(b, 7);
        t.set_id(c, 9);
        assert_eq!(t.row_by_id(7), Some(b));
        t.remove(c);
        assert_eq!((t.row_by_id(9), t.id_of(c)), (None, None));
        let d = t.insert(TOP, "d", false).unwrap(); // reuses c's slot
        assert_eq!(t.id_of(d), None);
        let rows: Vec<_> = t.rows().collect();
        assert_eq!(rows.len(), t.len());
        assert!(rows.contains(&(b, a, "b.txt", false)));
        assert!(rows.contains(&(a, TOP, "A", true)));
    }

    #[test]
    fn rename_keeps_children_and_remove_takes_them() {
        let mut t = Table::new("/r");
        let a = t.insert(TOP, "a", true).unwrap();
        t.insert(a, "inner.txt", false);
        assert!(t.rename_path(Path::new("/r/a"), Path::new("/r/b")));
        let (rows, _) = t.search("inner", 5);
        assert_eq!(t.path_of(rows[0]), Path::new("/r/b/inner.txt"));
        assert!(t.search("a", 5).0.iter().all(|&r| t.name(r) != "a"));
        assert!(t.remove_path(Path::new("/r/b")));
        assert_eq!(t.len(), 0);
        assert_eq!(t.search("inner", 5).1, 0);
        // a freed row is reused and found again
        t.insert(TOP, "again", false);
        assert_eq!(t.search("again", 5).1, 1);
    }

    #[test]
    fn a_name_with_a_newline_or_nul_is_refused() {
        let mut t = Table::new("/r");
        assert_eq!(t.insert(TOP, "two\nlines", false), None);
        assert_eq!(t.insert(TOP, "nul\0byte", false), None);
        assert_eq!(t.len(), 0);
    }

    #[test]
    fn the_real_spelling_is_kept_but_never_searched() {
        let mut t = Table::new("/r");
        let a = t.insert(TOP, "ReadMe.TXT", false).unwrap();
        let b = t.insert(TOP, "plain.md", false).unwrap();
        assert_eq!(
            (t.name(a), t.name(b), t.cased()),
            ("ReadMe.TXT", "plain.md", 1)
        );
        // found once, through the lowercased name
        assert_eq!(t.search("dme.t", 5), (vec![a], 1));
        assert_eq!(t.search("readme.txt", 5).0, [a]);
        // the real spelling sits after the lowercased one: nothing may match across the two
        assert_eq!(t.search("txt\0re", 5).1, 0);
        assert_eq!(t.fuzzy("rdmtxt", 5).0, [a]);
        t.remove(a);
        assert_eq!(t.cased(), 0);
        assert_eq!(t.search("readme", 5).1, 0);
    }

    #[test]
    fn find_folds_case_on_windows_only() {
        let mut t = Table::new("/r");
        let a = t.insert(TOP, "Docs", true).unwrap();
        assert_eq!(t.find(TOP, "Docs"), Some(a));
        if cfg!(windows) {
            assert_eq!(t.find(TOP, "DOCS"), Some(a));
            assert_eq!(t.insert(TOP, "docs", true), Some(a));
        } else {
            assert_eq!(t.find(TOP, "DOCS"), None);
        }
        // a case-only rename keeps the row and is found under the new spelling
        assert!(t.rename_path(Path::new("/r/Docs"), Path::new("/r/DOCS")));
        assert_eq!(t.find(TOP, "DOCS"), Some(a));
        assert_eq!(t.name(a), "DOCS");
    }

    #[test]
    fn hard_links_share_an_id_and_the_last_row_answers() {
        let mut t = Table::new("/r");
        let a = t.insert(TOP, "a", false).unwrap();
        let b = t.insert(TOP, "b", false).unwrap();
        t.set_id(a, 5);
        t.set_id(b, 5);
        assert_eq!(t.row_by_id(5), Some(b));
        assert_eq!(t.id_of(a), Some(5));
        // an id past 64 bits (ReFS) round-trips, and so does the marker value itself
        let wide = (7u128 << 64) | 3;
        t.set_id(a, wide);
        assert_eq!((t.id_of(a), t.row_by_id(wide)), (Some(wide), Some(a)));
        t.set_id(a, u64::MAX as u128);
        assert_eq!(t.row_by_id(u64::MAX as u128), Some(a));
        assert_eq!(t.row_by_id(wide), None);
    }

    /// Thousands of inserts, renames and removes checked against a plain map: the probe
    /// tables' back-shift on delete and the row/slot exceptions must never lose a row.
    #[test]
    fn lookups_survive_heavy_churn() {
        let mut t = Table::new("/r");
        let mut want: HashMap<(u32, String), u32> = HashMap::new();
        let mut ids: HashMap<u32, u128> = HashMap::new();
        let dirs: Vec<u32> = (0..8)
            .map(|i| t.insert(TOP, &format!("D{i}"), true).unwrap())
            .collect();
        let mut x: u64 = 0x2545_f491_4f6c_dd1d;
        for step in 0..20_000u32 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let r = x;
            let d = dirs[(r % 8) as usize];
            let name = format!("F{}", (r >> 8) % 3000);
            match step % 4 {
                0 | 1 => {
                    let row = t.insert(d, &name, false).unwrap();
                    want.insert((d, name), row);
                    let id = (r >> 20) as u128 % 5000 + 1;
                    if !ids.contains_key(&row) && ids.values().all(|&v| v != id) {
                        t.set_id(row, id);
                        ids.insert(row, id);
                    }
                }
                2 => {
                    if let Some(row) = want.remove(&(d, name)) {
                        t.remove(row);
                        ids.remove(&row);
                    }
                }
                _ => {
                    let to = dirs[((r >> 40) % 8) as usize];
                    let new_name = format!("G{step}");
                    let (from, onto) = (t.path_of(d).join(&name), t.path_of(to).join(&new_name));
                    if let Some(row) = want.remove(&(d, name)) {
                        assert!(t.rename_path(&from, &onto));
                        want.insert((to, new_name), row);
                    }
                }
            }
        }
        assert_eq!(t.len(), want.len() + dirs.len());
        for ((p, n), &row) in &want {
            assert_eq!(t.find(*p, n), Some(row), "{n}");
            assert_eq!(t.name(row), n);
            assert_eq!(t.parent[row as usize], *p);
            assert!(t.search(&n.to_lowercase(), 1).1 >= 1);
        }
        for (&row, &id) in &ids {
            assert_eq!((t.row_by_id(id), t.id_of(row)), (Some(row), Some(id)));
        }
        assert_eq!(t.rows().count(), t.len());
    }

    #[test]
    fn fuzzy_only_runs_when_substring_finds_nothing() {
        let t = table(&[("report.txt", false), ("rapport final", false)]);
        // a substring hit: answered by search, fuzzy never ran
        let (rows, total, fuzzy) = t.search_or_fuzzy("report", 5);
        assert!(!fuzzy);
        assert_eq!(
            (names(&t, &rows), total),
            (vec!["report.txt".to_string()], 1)
        );
        // nothing holds "rprt" side by side: fuzzy answers
        let (rows, total, fuzzy) = t.search_or_fuzzy("rprt", 5);
        assert!(fuzzy);
        assert_eq!(total, 2);
        assert_eq!(names(&t, &rows), ["report.txt", "rapport final"]);
        // nothing at all
        assert_eq!(t.search_or_fuzzy("qqq", 5), (Vec::new(), 0, true));
    }

    #[test]
    fn fuzzy_ranks_tight_and_early_matches_first() {
        let t = table(&[
            ("a long budget plan.xls", false),
            ("bdgt", false),
            ("b_d_g_t.txt", false),
            ("my bdgt", false),
            ("xyz", false),
        ]);
        let (rows, total) = t.fuzzy("BDGT", 10);
        assert_eq!(total, 4);
        assert_eq!(
            names(&t, &rows),
            ["bdgt", "my bdgt", "a long budget plan.xls", "b_d_g_t.txt"]
        );
    }

    #[test]
    fn fuzzy_needs_three_letters_and_puts_cache_folders_last() {
        let mut t = Table::new("/r");
        assert_eq!(t.fuzzy("ab", 5), (Vec::new(), 0));
        let nm = t.insert(TOP, "node_modules", true).unwrap();
        t.insert(nm, "readme", false);
        let docs = t.insert(TOP, "documents-folder", true).unwrap();
        t.insert(docs, "reading me", false);
        let (rows, _) = t.fuzzy("rdme", 5);
        assert_eq!(
            t.path_of(rows[0]),
            Path::new("/r/documents-folder/reading me")
        );
        assert_eq!(t.path_of(rows[1]), Path::new("/r/node_modules/readme"));
    }

    /// Plan 21C.7: a fuzzy pass over a million rows. Release only:
    /// `cargo test --release --lib fuzzy_1m_rows -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn fuzzy_1m_rows() {
        let mut t = Table::new("/r");
        let words = [
            "report", "photo", "invoice", "notes", "draft", "budget", "img", "readme",
        ];
        for i in 0..1_000_000u32 {
            let w = words[(i as usize) % words.len()];
            let n = format!("{w}_{i:07}_{}.txt", i.wrapping_mul(2654435761) % 9973);
            t.insert(TOP, &n, false);
        }
        for q in ["zqxj", "rprt", "bdgt 99", "iinvc"] {
            let started = std::time::Instant::now();
            let (rows, total, fuzzy) = t.search_or_fuzzy(q, 200);
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            eprintln!(
                "{q:?}: fuzzy {fuzzy}, {total} hits, {} shown, {ms:.1} ms",
                rows.len()
            );
        }
    }

    /// Plan 21C.1e. Release only, and timed, so `#[ignore]`d:
    /// `cargo test --release --lib search_1m_rows_under_50ms -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn search_1m_rows_under_50ms() {
        let mut t = Table::new("/r");
        let words = [
            "report", "photo", "invoice", "notes", "draft", "budget", "img", "readme",
        ];
        let mut dirs = vec![TOP];
        for i in 0..1_000_000u32 {
            let parent = dirs[(i as usize * 7919) % dirs.len()];
            let w = words[(i as usize) % words.len()];
            let name = format!("{w}_{i:07}_{}.txt", i.wrapping_mul(2654435761) % 9973);
            if i % 50 == 0 {
                if let Some(r) = t.insert(
                    parent,
                    &format!("{}folder {i}", if i % 1000 == 0 { "." } else { "" }),
                    true,
                ) {
                    dirs.push(r);
                }
            } else {
                t.insert(parent, &name, false);
            }
        }
        eprintln!(
            "rows {} bytes {} ({:.1} B/row)",
            t.len(),
            t.bytes(),
            t.bytes() as f64 / t.len() as f64
        );
        // the palette asks for 200 (BUG-S2), so time that too
        for max in [20, 200] {
            for q in ["report", "zzqx", "a", "notes 0123", "_0999999_"] {
                let started = std::time::Instant::now();
                let (rows, total) = t.search(q, max);
                let ms = started.elapsed().as_secs_f64() * 1000.0;
                eprintln!(
                    "search {q:?} max {max}: {total} hits, {} shown, {ms:.1} ms",
                    rows.len()
                );
                assert!(ms < 50.0, "{q:?} max {max} took {ms:.1} ms");
            }
        }
    }
}
