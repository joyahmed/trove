//! The IPC contract, Rust side (plan 07 phase F.1).
//!
//! Rust commands are tested in Rust and the frontend is tested with `$lib/api/*` mocked, so a
//! command whose JSON disagrees with the TypeScript type passes both suites. This test is the
//! bridge: it serializes a sample of every structured command response, exactly as Tauri does
//! (`serde_json`), and compares it with the committed files in `tests/ipc-fixtures/`. The
//! frontend half, `src/lib/api/ipc-contract.test.ts`, reads those same files and checks each
//! against the `$lib/api` type.
//!
//! A struct change that moves the JSON fails HERE until the fixtures are regenerated:
//!
//! ```text
//! UPDATE_IPC_FIXTURES=1 cargo test ipc_contract
//! ```
//!
//! and then the TS test fails until the `$lib/api` type follows. Each fixture file is a JSON
//! array of samples of one command's success response, one per variant worth showing
//! (an optional field both set and absent, every enum value).
//!
//! Not covered, on purpose: commands that answer `()`, a string, a number, a bool or
//! `Vec<String>` (nothing structural to drift), and `read_settings` (`serde_json::Value`, the
//! frontend types it `unknown`). Event and channel payloads are not command responses.

use std::path::PathBuf;

use serde::Serialize;
use serde_json::{json, Value};

use crate::commands::default_handler::HandlerInfo;
use crate::commands::fs::TrashError;
use crate::commands::index::{FillingRoot, IndexAnswer};
use crate::commands::index_settings::IndexDrive;
use crate::commands::pty::Followed;
use crate::commands::uninstall::Outcome;
use crate::core::clipboard::ClipboardPaths;
use crate::core::default_handler::Status;
use crate::core::drag_out::{DragEffect, DragOutcome};
use crate::core::folder_sizes::DriveKind;
use crate::core::fs::{CloudState, DirListing, FileEntry, PathKind};
use crate::core::keys::Held;
use crate::core::known_apps::{DetectedApp, Source};
use crate::core::launch::Launch;
use crate::core::lockers::{Ended, LockedPath, Locker, NoEnd};
use crate::core::net::SignIn;
use crate::core::open_with::OpenWithApp;
use crate::core::preview::TextHead;
use crate::core::props::Props;
use crate::core::recycle::RecycleItem;
use crate::core::session::{Bounds, Session, WindowTabs};
use crate::core::shell::{DriveInfo, KnownFolder};
use crate::core::shell_verbs::{ShellVerb, VerbScope};
use crate::core::spotlight::{AppEntry, FoundFiles, OpenWith};
use crate::core::sync_root::SyncStatus;
use crate::core::theme::SystemTheme;
use crate::core::transfer::{FailureKind, TransferFailure};
use crate::core::uninstall::{Removable, Uninstallable};
use crate::core::volume::FolderSpace;
use crate::core::wsl::WslDistro;

fn v<T: Serialize>(value: T) -> Value {
    serde_json::to_value(value).expect("a command response serializes")
}

fn entry(name: &str, is_dir: bool, link: bool) -> FileEntry {
    FileEntry {
        name: name.into(),
        path: format!("/home/alex/{name}"),
        is_dir,
        size: if is_dir { 0 } else { 2048 },
        modified_ms: Some(1_700_000_000_000),
        created_ms: if is_dir {
            None
        } else {
            Some(1_690_000_000_000)
        },
        ext: if is_dir { None } else { Some("txt".into()) },
        is_hidden: false,
        icon_key: if is_dir {
            "folder".into()
        } else {
            "ext/txt".into()
        },
        type_name: if is_dir {
            "Folder".into()
        } else {
            "Text Document".into()
        },
        is_link: link,
        cloud_state: None,
    }
}

fn listing() -> Value {
    v(DirListing {
        path: "/home/alex".into(),
        entries: vec![
            entry("notes.txt", false, false),
            entry("src", true, true),
            FileEntry {
                cloud_state: Some(CloudState::Online),
                ..entry("report.docx", false, false)
            },
        ],
    })
}

fn wsl_distro(name: &str, is_default: bool) -> WslDistro {
    WslDistro {
        name: name.into(),
        is_default,
        uid: 1000,
    }
}

/// command name -> samples of its success response.
fn samples() -> Vec<(&'static str, Vec<Value>)> {
    let hits = vec![entry("a.txt", false, false)];
    let bounds = Bounds {
        x: -8,
        y: 0,
        w: 1280,
        h: 800,
        maximized: true,
    };
    vec![
        ("read_dir", vec![listing()]),
        ("read_archive_dir", vec![listing()]),
        (
            "path_kind",
            vec![v(PathKind::File), v(PathKind::Dir), v(PathKind::Missing)],
        ),
        (
            "net_sign_in",
            vec![v(SignIn::Connected), v(SignIn::Cancelled)],
        ),
        (
            "cloud_sync_status",
            vec![
                v(Some(SyncStatus::UpToDate)),
                v(Some(SyncStatus::Syncing)),
                v(Some(SyncStatus::Offline)),
                v(Some(SyncStatus::Error)),
                v(None::<SyncStatus>),
            ],
        ),
        ("gallery_items", vec![v(&hits)]),
        ("recent_files", vec![v(&hits)]),
        (
            "spotlight_files",
            vec![
                v(FoundFiles {
                    entries: hits.clone(),
                    skipped_guarded: vec!["/Users/alex/Desktop".into()],
                }),
                v(FoundFiles::default()),
            ],
        ),
        (
            "index_search",
            vec![
                v(IndexAnswer {
                    ready: true,
                    roots: vec!["home".into()],
                    hits,
                    total: 1,
                    filling: vec![],
                    stale: vec!["D:".into()],
                    skipped_guarded: vec!["/Users/alex/Documents".into()],
                }),
                v(IndexAnswer {
                    ready: false,
                    roots: vec![],
                    hits: vec![],
                    total: 0,
                    filling: vec![FillingRoot {
                        label: "home".into(),
                        seen: 120,
                    }],
                    stale: vec![],
                    skipped_guarded: vec![],
                }),
            ],
        ),
        (
            "index_progress",
            vec![v(vec![FillingRoot {
                label: "D:".into(),
                seen: 7,
            }])],
        ),
        (
            "index_drives",
            vec![v(vec![IndexDrive {
                root: "D:\\".into(),
            }])],
        ),
        (
            "initial_launch",
            vec![
                v(Launch {
                    path: Some("/home/alex".into()),
                    select: Some("/home/alex/a.txt".into()),
                    hidden: false,
                }),
                v(Launch::default()),
            ],
        ),
        (
            "who_is_locking",
            vec![v(vec![LockedPath {
                path: "C:\\a.docx".into(),
                lockers: vec![
                    Locker {
                        pid: 4242,
                        app: "Word".into(),
                        exe: "C:\\Office\\WINWORD.EXE".into(),
                        can_end: true,
                        no_end: None,
                    },
                    Locker {
                        pid: 1,
                        app: "Trove".into(),
                        exe: "trove.exe".into(),
                        can_end: false,
                        no_end: Some(NoEnd::Trove),
                    },
                    Locker {
                        pid: 2,
                        app: "Terminal".into(),
                        exe: "wt.exe".into(),
                        can_end: false,
                        no_end: Some(NoEnd::Terminal),
                    },
                    Locker {
                        pid: 3,
                        app: "System".into(),
                        exe: "svc.exe".into(),
                        can_end: false,
                        no_end: Some(NoEnd::Windows),
                    },
                    Locker {
                        pid: 4,
                        app: "Other".into(),
                        exe: "x.exe".into(),
                        can_end: false,
                        no_end: Some(NoEnd::OtherSession),
                    },
                ],
            }])],
        ),
        (
            "end_locking_app",
            vec![v(Ended::Ended), v(Ended::StillRunning)],
        ),
        (
            "open_with_apps",
            vec![v(vec![
                OpenWithApp {
                    id: "gedit.desktop".into(),
                    name: "Text Editor".into(),
                    icon: Some("file/gedit".into()),
                    is_default: true,
                },
                OpenWithApp {
                    id: "code.desktop".into(),
                    name: "Code".into(),
                    icon: None,
                    is_default: false,
                },
            ])],
        ),
        (
            "read_text_head",
            vec![v(TextHead {
                text: "hello".into(),
                truncated: false,
                binary: false,
            })],
        ),
        (
            "file_props",
            vec![
                v(Props {
                    path: "/home/alex/a.txt".into(),
                    name: "a.txt".into(),
                    is_dir: false,
                    type_name: "Text Document".into(),
                    size: 10,
                    size_on_disk: 4096,
                    created_ms: Some(1),
                    modified_ms: Some(2),
                    accessed_ms: Some(3),
                    read_only: false,
                    hidden: false,
                    system: false,
                    archive: true,
                }),
                v(Props {
                    path: "/home/alex".into(),
                    name: "alex".into(),
                    is_dir: true,
                    type_name: "Folder".into(),
                    size: 0,
                    size_on_disk: 0,
                    created_ms: None,
                    modified_ms: None,
                    accessed_ms: None,
                    read_only: true,
                    hidden: true,
                    system: true,
                    archive: false,
                }),
            ],
        ),
        (
            "folder_drive_kind",
            vec![
                v(DriveKind::Local),
                v(DriveKind::Network),
                v(DriveKind::Removable),
                v(DriveKind::Wsl),
            ],
        ),
        (
            "pty_follow",
            vec![
                v(Followed::Typed),
                v(Followed::Busy),
                v(Followed::OtherShell),
            ],
        ),
        (
            "recycle_list",
            vec![v(vec![
                RecycleItem {
                    id: "r1".into(),
                    name: "old.txt".into(),
                    original_parent: Some("/home/alex".into()),
                    deleted_ms: 1_700_000_000_000,
                    is_dir: false,
                    size: Some(5),
                },
                RecycleItem {
                    id: "r2".into(),
                    name: "dir".into(),
                    original_parent: None,
                    deleted_ms: 1_700_000_000_001,
                    is_dir: true,
                    size: None,
                },
            ])],
        ),
        (
            "take_last_session",
            vec![
                Value::Null,
                v(Session {
                    windows: vec![
                        WindowTabs {
                            label: "main".into(),
                            tabs: vec!["/home/alex".into()],
                            active: 0,
                            bounds: Some(bounds),
                        },
                        WindowTabs {
                            label: "w2".into(),
                            tabs: vec![],
                            active: 0,
                            bounds: None,
                        },
                    ],
                }),
            ],
        ),
        (
            "drives",
            vec![v(vec![
                DriveInfo {
                    path: "/".into(),
                    label: "Root".into(),
                    total_bytes: Some(100),
                    free_bytes: Some(40),
                    network: false,
                },
                DriveInfo {
                    path: "/mnt/nas".into(),
                    label: "nas".into(),
                    total_bytes: None,
                    free_bytes: None,
                    network: true,
                },
            ])],
        ),
        (
            "known_folders",
            vec![v(vec![KnownFolder {
                key: "downloads",
                label: "Downloads",
                path: "/home/alex/Downloads".into(),
            }])],
        ),
        (
            "shell_verbs",
            vec![v([
                VerbScope::Directory,
                VerbScope::DirectoryBackground,
                VerbScope::File,
                VerbScope::Drive,
            ]
            .map(|scope| ShellVerb {
                key: "open".into(),
                label: "Open".into(),
                command: "x \"%1\"".into(),
                icon: None,
                scope,
            }))],
        ),
        (
            "shell_menu",
            vec![v(crate::core::shell_menu::ShellMenu {
                token: 1,
                items: vec![
                    crate::core::shell_menu::ShellMenuItem {
                        id: 3,
                        label: "Open with Code".into(),
                        verb: Some("vscode".into()),
                        enabled: true,
                        separator: false,
                        children: vec![],
                        icon_key: Some("menu/00000000000000ab".into()),
                    },
                    crate::core::shell_menu::ShellMenuItem {
                        id: 0,
                        label: String::new(),
                        verb: None,
                        enabled: false,
                        separator: true,
                        children: vec![],
                        icon_key: None,
                    },
                    crate::core::shell_menu::ShellMenuItem {
                        id: 0,
                        label: "Send to".into(),
                        verb: None,
                        enabled: true,
                        separator: false,
                        children: vec![crate::core::shell_menu::ShellMenuItem {
                            id: 9,
                            label: "Desktop (create shortcut)".into(),
                            verb: None,
                            enabled: true,
                            separator: false,
                            children: vec![],
                            icon_key: None,
                        }],
                        icon_key: None,
                    },
                ],
            })],
        ),
        (
            "detect_common_commands",
            vec![v([
                Source::AppPaths,
                Source::StartMenu,
                Source::Path,
                Source::KnownDir,
                Source::WslDistro,
                Source::DesktopEntry,
            ]
            .map(|source| DetectedApp {
                id: "code".into(),
                label: "VS Code".into(),
                program: "code".into(),
                args: "\"%1\"".into(),
                scope: vec!["file".into(), "folder".into()],
                source,
                certain: true,
            }))],
        ),
        (
            "spotlight_apps",
            vec![v(vec![
                AppEntry {
                    name: "Files".into(),
                    lnk_path: "C:\\Files.lnk".into(),
                    target: "C:\\files.exe".into(),
                    aumid: "Files.App".into(),
                    open_with: Some(OpenWith {
                        program: "files.exe".into(),
                        args: "-x".into(),
                    }),
                    path: "C:\\".into(),
                },
                AppEntry::default(),
            ])],
        ),
        (
            "system_theme",
            vec![v(SystemTheme {
                accent: "#0078d4".into(),
                transparency: true,
                text_scale: 1.25,
            })],
        ),
        (
            "remove_moved_originals",
            vec![v([
                FailureKind::File,
                FailureKind::Folder,
                FailureKind::NewFolder,
                FailureKind::NotRemoved,
            ]
            .map(|kind| TransferFailure {
                path: "/a".into(),
                destination: "/b".into(),
                error: "denied".into(),
                kind,
                copy: None,
            })
            .into_iter()
            .chain([TransferFailure {
                path: "/a".into(),
                destination: "/b".into(),
                error: "denied".into(),
                kind: FailureKind::NotRemoved,
                copy: Some("/b/a".into()),
            }])
            .collect::<Vec<_>>())],
        ),
        (
            "clipboard_read_paths",
            vec![
                Value::Null,
                v(ClipboardPaths {
                    paths: vec!["/a".into()],
                    cut: true,
                }),
            ],
        ),
        (
            "drag_out",
            vec![
                v(DragOutcome {
                    effect: DragEffect::None,
                }),
                v(DragOutcome {
                    effect: DragEffect::Copy,
                }),
                v(DragOutcome {
                    effect: DragEffect::Move,
                }),
            ],
        ),
        (
            "drop_modifiers",
            vec![v(Held {
                ctrl: true,
                shift: false,
            })],
        ),
        (
            "folder_space",
            vec![
                Value::Null,
                v(FolderSpace {
                    free_bytes: 123,
                    mount_root: "/".into(),
                }),
            ],
        ),
        (
            "uninstall_list",
            vec![v([
                Removable::Yes,
                Removable::System,
                Removable::Trove,
                Removable::NoUninstaller,
                Removable::Link,
                Removable::NotApp,
                Removable::Elsewhere,
            ]
            .map(|removable| Uninstallable {
                id: "id".into(),
                name: "App".into(),
                version: "1.0".into(),
                publisher: "Pub".into(),
                folder: "/opt/app".into(),
                path: "/opt/app/app".into(),
                removable,
                program: "app".into(),
                stamp: "2026-01-01".into(),
                typed: false,
                command: None,
                deb: None,
            }))],
        ),
        (
            "uninstall_app",
            vec![
                v(Outcome::Gone),
                v(Outcome::StillListed),
                v(Outcome::Unknown),
                v(Outcome::NoTrash),
                v(Outcome::TypedInTerminal),
            ],
        ),
        (
            "wsl_distros",
            vec![v(vec![
                wsl_distro("Ubuntu", true),
                wsl_distro("Debian", false),
            ])],
        ),
        (
            "default_handler_status",
            vec![
                v(Status::NotApplied),
                v(Status::Applied),
                v(Status::PartiallyApplied {
                    applied: vec!["folder".into()],
                }),
                v(Status::AppliedToOther {
                    exe: "/usr/bin/other".into(),
                }),
            ],
        ),
        (
            "default_handler_info",
            vec![v(HandlerInfo {
                exe_path: "/opt/trove/trove".into(),
                stable: true,
            })],
        ),
        ("image_dimensions", vec![v(vec![Some([640u32, 480]), None])]),
    ]
}

/// The error side of `trash_entries`, which the frontend reads field by field.
fn trash_errors() -> Vec<Value> {
    ["noBin", "off", "tooBig", "denied"]
        .into_iter()
        .map(|reason| {
            v(TrashError::NoBin {
                no_bin: "D:".into(),
                reason,
                paths: vec!["D:\\a".into()],
                message: "no bin".into(),
            })
        })
        .chain([v(TrashError::Other("denied".into()))])
        .collect()
}

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("ipc-fixtures")
}

fn pretty(samples: &[Value]) -> String {
    let mut text = serde_json::to_string_pretty(samples).unwrap();
    text.push('\n');
    text
}

#[test]
fn ipc_fixtures_match_what_the_commands_serialize() {
    let update = std::env::var_os("UPDATE_IPC_FIXTURES").is_some();
    let mut all: Vec<(String, Vec<Value>)> = samples()
        .into_iter()
        .map(|(name, s)| (name.to_string(), s))
        .collect();
    all.push(("trash_entries.error".into(), trash_errors()));
    all.sort_by(|a, b| a.0.cmp(&b.0));

    let dir = dir();
    if update {
        std::fs::create_dir_all(&dir).unwrap();
    }
    let mut stale = Vec::new();
    for (name, s) in &all {
        let file = dir.join(format!("{name}.json"));
        let want = pretty(s);
        if update {
            std::fs::write(&file, &want).unwrap();
        } else if std::fs::read_to_string(&file).ok().as_deref() != Some(want.as_str()) {
            stale.push(name.clone());
        }
    }
    // a fixture with no command behind it is a command that was removed or renamed
    let known: Vec<String> = all.iter().map(|(n, _)| format!("{n}.json")).collect();
    for f in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        let name = f.file_name().to_string_lossy().into_owned();
        if !known.contains(&name) {
            if update {
                std::fs::remove_file(f.path()).unwrap();
            } else {
                stale.push(name);
            }
        }
    }
    assert!(
        stale.is_empty(),
        "IPC fixtures out of date: {stale:?}. A command's JSON changed: run \
         `UPDATE_IPC_FIXTURES=1 cargo test ipc_contract`, then `bun run test` to see whether \
         the $lib/api types still agree"
    );
}

/// Every command in `generate_handler!` that is not in a fixture is named here with the reason,
/// so adding a structured command without a fixture is a deliberate choice, not an oversight.
#[test]
fn every_handler_is_covered_or_listed_as_unstructured() {
    let lib = include_str!("lib.rs");
    let start = lib.find("generate_handler![").expect("the handler list");
    let end = start + lib[start..].find(']').unwrap();
    let handlers: Vec<&str> = lib[start..end]
        .lines()
        .filter_map(|l| l.trim().strip_prefix("commands::"))
        .filter_map(|l| l.trim_end_matches(',').split("::").nth(1))
        .collect();
    assert!(handlers.len() > 100, "parsed {} handlers", handlers.len());

    let covered: Vec<&str> = samples().iter().map(|(n, _)| *n).collect();
    let unstructured = include_str!("../tests/ipc-unstructured.txt");
    let unstructured: Vec<&str> = unstructured
        .lines()
        .map(|l| l.split('#').next().unwrap().trim())
        .filter(|l| !l.is_empty())
        .collect();
    let mut missing: Vec<&str> = handlers
        .iter()
        .copied()
        .filter(|h| *h != "trash_entries" && !covered.contains(h) && !unstructured.contains(h))
        .collect();
    missing.sort();
    assert!(
        missing.is_empty(),
        "commands with no IPC fixture and not listed in tests/ipc-unstructured.txt: {missing:?}"
    );
    let ghosts: Vec<&&str> = unstructured
        .iter()
        .filter(|u| !handlers.contains(u))
        .collect();
    assert!(
        ghosts.is_empty(),
        "ipc-unstructured.txt names no command: {ghosts:?}"
    );
    let both: Vec<&&str> = unstructured
        .iter()
        .filter(|u| covered.contains(u))
        .collect();
    assert!(
        both.is_empty(),
        "both covered and listed unstructured: {both:?}"
    );
}

#[test]
fn json_shape_sanity() {
    // the helper really produces Tauri's wire shape: camelCase keys, a skipped `isLink`
    let e = v(entry("a", false, false));
    assert!(e.get("isLink").is_none());
    assert!(e.get("cloudState").is_none());
    assert_eq!(e["isDir"], json!(false));
}
