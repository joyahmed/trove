# Trove

Trove is a fast file explorer for Windows, Mac and Linux (Ubuntu and Debian). It has real tabs, stays quick in folders with 100,000 files, and has a search that finds files by name at once. It is built with Rust, Tauri 2 and Svelte 5, and looks the same on every system.

## Screenshots

Placeholders. Add the images under `docs/screenshots/` and link them here.

- [ ] Home (places and drives), light and dark
- [ ] Details view with the preview pane
- [ ] Cards view grouped by date
- [ ] Ctrl K search and Spotlight
- [ ] Applications place
- [ ] Windows stacked / snapped
- [ ] Settings (theme, accent, "I'm coming from")

## What it does

- Many folders in tabs; cards, list and details views; a preview pane.
- A name index (can be turned off) and Spotlight, a small window with a shortcut you choose: finds files and apps, does sums, searches the web.
- Opens zip, 7z and tar files like folders, extracts and creates them. RAR is not supported yet.
- Shows folder sizes, lets you pin folders, "Open with", drag files in and out, and shows what is holding a file open when Delete fails.
- Light, dark or system theme, an accent colour, and a setting that makes names and keys match the system you are used to.

## Install

Download from the Releases page. Not signed by a known publisher yet, so your system warns the first time.

- Windows: run `Trove_<version>_x64-setup.exe`. Click "More info", then "Run anyway".
- Mac: open the `.dmg`, drag Trove to Applications, then System Settings, Privacy & Security, "Open Anyway". Steps: [docs/install/mac.md](docs/install/mac.md).
  The Mac app is not notarized yet. The first time it is blocked, open System Settings > Privacy & Security and click Open Anyway. (On macOS 14 and older, right-click Trove.app and choose Open also works.)
- Linux: `sudo apt install ./Trove_<version>_amd64.deb`, or make the `.AppImage` executable and run it. Steps: [docs/install/linux.md](docs/install/linux.md).

No automatic updates yet; install a new version over the old one.

## Build from source

Needs [Rust](https://rustup.rs), [Bun](https://bun.sh) 1.2 and Node 24. On Linux you also need the Tauri 2 system libraries (WebKitGTK 4.1, GTK 3, libayatana-appindicator, librsvg, patchelf); see the Tauri prerequisites page.

```
bun install --frozen-lockfile
bun run tauri dev                      # run in development
bun run tauri build --bundles deb,appimage   # Linux installers
bun run build:installer                # Windows installer
bun run tauri build                    # Mac (app + dmg)
```

Checks: `bun run gate` runs type check, lint, tests and the Rust checks (fmt, clippy, cargo test).

The release workflow sets `RUSTFLAGS` through `scripts/remap-flags.ts` so build-machine paths are not embedded in the binaries.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the code conventions and the gate.

## License

MIT. See [LICENSE](LICENSE).
