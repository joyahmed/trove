//! Plan 21C measurement (run by hand): rows and memory of the name index over every fixed drive.
//! `cargo test --release --lib measure -- --ignored --nocapture`
//! Read-only on the drives; the store files go to a temp dir that is deleted afterwards.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use super::walk::{walk, Skip};
use super::{drives, store, WALK_THREADS};

#[repr(C)]
#[derive(Default)]
struct Counters {
    cb: u32,
    page_fault_count: u32,
    peak_working_set: usize,
    working_set: usize,
    quota_peak_paged: usize,
    quota_paged: usize,
    quota_peak_nonpaged: usize,
    quota_nonpaged: usize,
    pagefile: usize,
    peak_pagefile: usize,
    private_usage: usize,
}

#[link(name = "psapi")]
extern "system" {
    fn GetProcessMemoryInfo(process: isize, counters: *mut Counters, cb: u32) -> i32;
    fn GetCurrentProcess() -> isize;
}

/// (private bytes, working set) of this process.
fn mem() -> (usize, usize) {
    let mut c = Counters {
        cb: std::mem::size_of::<Counters>() as u32,
        ..Default::default()
    };
    // SAFETY: `c` is a correctly sized PROCESS_MEMORY_COUNTERS_EX and lives through the call.
    unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) };
    (c.private_usage, c.working_set)
}

fn mb(b: usize) -> f64 {
    b as f64 / 1_048_576.0
}

#[test]
#[ignore = "walks every fixed drive; run by hand"]
fn measure_all_drives() {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from);
    let tmp = std::env::temp_dir().join("trove-measure-store");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();
    let cancel = AtomicBool::new(false);
    let mut roots: Vec<(String, PathBuf, Skip)> = Vec::new();
    if let Some(h) = &home {
        roots.push(("home".into(), h.clone(), Skip::defaults()));
    }
    for d in drives::fixed_local() {
        let skip = match &home {
            Some(h) if h.starts_with(&d) => Skip::defaults().and_folder(h.clone()),
            _ => Skip::defaults(),
        };
        roots.push((d.display().to_string(), d, skip));
    }
    let (p0, w0) = mem();
    println!("START private {:.1} MB working {:.1} MB", mb(p0), mb(w0));
    println!("part | rows | walk s | priv before | priv after | MB added | ws added | table.bytes MB | saved MB");
    let (mut rows_all, mut added_all, mut saved_all) = (0usize, 0f64, 0f64);
    let mut keep = Vec::new();
    for (label, root, skip) in roots {
        let (pb, wb) = mem();
        let t0 = Instant::now();
        let table = walk(&root, &skip, WALK_THREADS, &cancel);
        let secs = t0.elapsed().as_secs_f64();
        let (pa, wa) = mem();
        let name: String = label
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect();
        let file = tmp.join(format!("{name}.bin"));
        store::save(&table, &file).unwrap();
        let saved = std::fs::metadata(&file).unwrap().len() as usize;
        println!(
            "{label} | {} | {secs:.1} | {:.1} | {:.1} | {:.1} | {:.1} | {:.1} | {:.1}",
            table.len(),
            mb(pb),
            mb(pa),
            mb(pa) - mb(pb),
            mb(wa) - mb(wb),
            mb(table.bytes()),
            mb(saved)
        );
        println!("    {}", table.breakdown());
        rows_all += table.len();
        added_all += mb(pa) - mb(pb);
        saved_all += mb(saved);
        keep.push((label, table));
    }
    let (pe, we) = mem();
    println!(
        "B/row by private growth {:.1}",
        (pe - p0) as f64 / rows_all.max(1) as f64
    );
    println!(
        "TOTAL rows {rows_all} | summed MB added {added_all:.1} | private growth {:.1} MB | working growth {:.1} MB | saved {saved_all:.1} MB | budget 150 MB",
        mb(pe) - mb(p0),
        mb(we) - mb(w0)
    );
    // what `Table::shrink_to_fit` after each walk would give back (walk now does it itself, so this should give back ~nothing)
    for (_, table) in keep.iter_mut() {
        table.shrink_to_fit();
    }
    let (ps, _) = mem();
    let bytes: usize = keep.iter().map(|(_, t)| t.bytes()).sum();
    println!(
        "after shrink_to_fit: private growth {:.1} MB ({:.1} B/row), table.bytes {:.1} MB",
        mb(ps) - mb(p0),
        (ps - p0) as f64 / rows_all.max(1) as f64,
        mb(bytes)
    );
    // rows by first two path segments below the root
    for (label, table) in &keep {
        if !(label == "home" || label.starts_with("C:") || label.starts_with("D:")) {
            continue;
        }
        let mut by: HashMap<String, usize> = HashMap::new();
        for row in 0..table.len() as u32 {
            let p = table.path_of(row);
            let rel = p.strip_prefix(table.root()).unwrap_or(&p);
            let key: Vec<_> = rel
                .components()
                .take(2)
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect();
            *by.entry(key.join("/")).or_default() += 1;
        }
        let mut v: Vec<_> = by.into_iter().collect();
        v.sort_by_key(|e| std::cmp::Reverse(e.1));
        println!("{label} TOP 10 by first two segments");
        for (k, n) in v.iter().take(10) {
            println!("  {n:>10}  {k}");
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);
}
