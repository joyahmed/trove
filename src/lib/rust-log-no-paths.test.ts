import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Plan 15 D.8.2 and `src-tauri/src/core/logging.rs` (A.4): a release build logs at info, and
// full paths are personal, so a path goes to `log::debug!` only. The 2026-10-21 Mac run found
// `launch argv [...]` at info and 39 `read_dir /tmp/...` warnings. This scans every
// info!/warn!/error! call in the Rust for the shapes that print a path or argv.
const PATH_SHAPES = [
  /\.display\(\)/,
  /\{path\b/,
  /\{argv\b/,
  /\{(old|l|urls|paths|roots|protected):\?\}/,
  /\bsaid\(/,
];

const rustFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return rustFiles(path);
    return path.endsWith('.rs') ? [path] : [];
  });

/** Every `log::info!(…)` / `warn!` / `error!` call, to its closing `);` or `)` + `,`. */
const calls = rustFiles('src-tauri/src').flatMap((file) => {
  const src = readFileSync(file, 'utf8');
  // tests are free to log whatever they like
  const code = src.split(/\n#\[cfg\(test\)\]\nmod tests/)[0];
  const found: { file: string; call: string }[] = [];
  const re = /log::(info|warn|error)!\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < code.length && depth > 0) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') depth--;
      i++;
    }
    found.push({ file, call: code.slice(m.index, i) });
  }
  return found;
});

describe('release log carries no paths (plan 15 D.8.2)', () => {
  it('finds the log calls (the scan itself works)', () => {
    expect(calls.length).toBeGreaterThan(100);
    expect(calls.some((c) => c.call.includes('launch: {} arg(s)'))).toBe(true);
  });

  it('no info!/warn!/error! prints a path or argv', () => {
    const bad = calls
      .filter((c) => PATH_SHAPES.some((p) => p.test(c.call)))
      .map((c) => `${c.file}: ${c.call.replace(/\s+/g, ' ')}`);
    expect(bad).toEqual([]);
  });
});
