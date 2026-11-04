# Archive fixtures

- `basic.rar` — RAR5, stored: `hello.txt`, `docs/`, `docs/readme.md`, `docs/notes.txt`.
  Used by `rar_lists_and_extracts_fixture` (`src/core/archive/rar_fmt.rs`).
- `slip.rar` — RAR5, stored: `good.txt` and `../slip.txt`. Used by
  `rar_slip_fixture_is_refused`: the `../` entry must be refused by `safe_path`.

Origin: written on macOS on 2026-11-04 by `make_rar_fixtures.py` (this folder),
byte-for-byte from the RAR5 format spec, with a fresh CRC32 for each header and each file.
RARLAB `rar` could not be used: its Homebrew cask has been disabled since 2026-09-01
(it fails Gatekeeper), and `rar` will not store a `../` name anyway. Checked with
bsdtar 3.5.3 (libarchive 3.7.4): it lists both files and extracts `basic.rar` with the
CRCs checked. The `unrar` crate reads both in the tests. Re-run the script to rebuild them.
