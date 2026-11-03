// Prints the rustc flags that keep build-machine paths out of a release binary (plan 22.0.4).
// `trim-paths` in the release profile is still nightly-only, so we remap by hand instead:
//   the home folder (cargo registry, rustup) -> "~"      the repo folder -> "trove"
// Use:  RUSTFLAGS="$(bun scripts/remap-flags.ts)" bun run tauri build
// Not plain `cargo build --release`: that leaves tauri in dev mode, which embeds the src-tauri
// folder (see scripts/path-leak-check.ts). `cargo build --release --features tauri/custom-protocol`
// is the cargo-only equivalent.
// A path with spaces will not survive RUSTFLAGS splitting; pass --encoded to get the
// CARGO_ENCODED_RUSTFLAGS form (flags joined by the 0x1f byte) instead.
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function remapFlags(home: string, root: string): string[] {
  const flags = [`--remap-path-prefix=${root}=trove`];
  // Longest prefix first would matter if the repo sat inside home; rustc applies the LAST match
  // that fits, so list home first and the more specific repo root after it.
  flags.unshift(`--remap-path-prefix=${home}=~`);
  return flags;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const flags = remapFlags(homedir(), root);
  process.stdout.write(process.argv.includes('--encoded') ? flags.join('\x1f') : flags.join(' '));
}
