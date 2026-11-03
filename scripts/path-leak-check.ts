// Fails a release build that still carries a build-machine path (plan 22.0.4).
// Counts the repo folder and the home folder inside a built binary, in both slash forms.
// Use:  bun scripts/path-leak-check.ts src-tauri/target/release/trove.exe
// Exit 0 when every count is 0, exit 1 otherwise.
//
// Why a plain `cargo build --release` fails it: without the `tauri/custom-protocol` feature
// tauri-macros builds the context in dev mode and embeds the src-tauri folder as a string
// (`context.with_config_parent(...)`), which --remap-path-prefix cannot touch. `tauri build`
// turns that feature on, so release binaries must come from `tauri build`.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function countOf(haystack: Buffer, needle: string): number {
  if (!needle) return 0;
  const n = Buffer.from(needle, 'utf8');
  let count = 0;
  for (let i = haystack.indexOf(n); i !== -1; i = haystack.indexOf(n, i + n.length)) count++;
  return count;
}

/** Each path in its native form and with the other slash, without duplicates. */
export function needles(paths: string[]): string[] {
  const all = paths.flatMap((p) => [p, p.replaceAll('\\', '/'), p.replaceAll('/', '\\')]);
  return [...new Set(all.filter((p) => p.length > 3))];
}

export function leaks(binary: Buffer, paths: string[]): Record<string, number> {
  return Object.fromEntries(needles(paths).map((p) => [p, countOf(binary, p)]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: bun scripts/path-leak-check.ts <binary>');
    process.exit(2);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const counts = leaks(readFileSync(file), [root, homedir()]);
  for (const [p, c] of Object.entries(counts)) console.log(`${c}\t${p}`);
  process.exit(Object.values(counts).some((c) => c > 0) ? 1 : 0);
}
