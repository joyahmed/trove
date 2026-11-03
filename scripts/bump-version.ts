// One place to change Trove's version.
//   bun scripts/bump-version.ts 1.2.3          set all four files to 1.2.3
//   bun scripts/bump-version.ts --check        exit 1 if the files disagree
// The four: package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json and the "trove" entry
// in src-tauri/Cargo.lock. Edits are text replacements so formatting and comments stay intact.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export type VersionFile = { path: string; pattern: RegExp };

// Each pattern captures (prefix)(version)(suffix) so only the version text is swapped.
export const FILES: VersionFile[] = [
  { path: 'package.json', pattern: /^(\s*"version":\s*")([^"]+)(")/m },
  { path: 'src-tauri/Cargo.toml', pattern: /^(version\s*=\s*")([^"]+)(")/m },
  { path: 'src-tauri/tauri.conf.json', pattern: /^(\s*"version":\s*")([^"]+)(")/m },
  {
    path: 'src-tauri/Cargo.lock',
    pattern: /(\[\[package\]\]\r?\nname = "trove"\r?\nversion = ")([^"]+)(")/,
  },
];

export function readVersion(text: string, f: VersionFile): string {
  const m = f.pattern.exec(text);
  if (!m) throw new Error(`no version found in ${f.path}`);
  return m[2];
}

export function setVersion(text: string, f: VersionFile, version: string): string {
  if (!f.pattern.test(text)) throw new Error(`no version found in ${f.path}`);
  return text.replace(f.pattern, (_all, a: string, _v: string, c: string) => a + version + c);
}

/** True when every given version string is identical. */
export function versionsMatch(versions: string[]): boolean {
  return versions.length > 0 && versions.every((v) => v === versions[0]);
}

export function run(argv: string[], root: string): number {
  const read = (f: VersionFile) => readFileSync(resolve(root, f.path), 'utf8');
  const arg = argv[0];
  if (arg === '--check') {
    const found = FILES.map((f) => ({ path: f.path, version: readVersion(read(f), f) }));
    for (const x of found) console.log(`${x.path}: ${x.version}`);
    if (!versionsMatch(found.map((x) => x.version))) {
      console.error('Versions disagree. Run: bun scripts/bump-version.ts <x.y.z>');
      return 1;
    }
    return 0;
  }
  if (!arg || !SEMVER.test(arg)) {
    console.error(`Usage: bump-version.ts <x.y.z> | --check   (got: ${arg ?? 'nothing'})`);
    return 2;
  }
  for (const f of FILES) {
    const p = resolve(root, f.path);
    writeFileSync(p, setVersion(readFileSync(p, 'utf8'), f, arg));
    console.log(`${f.path} -> ${arg}`);
  }
  return 0;
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(run(process.argv.slice(2), resolve(here, '..')));
}
