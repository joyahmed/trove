// Checks a Linux release .deb before it ships (plan 22.3.1). One call replaces the CI steps.
// Use:  bun scripts/linux-package-check.ts src-tauri/target/release/bundle/deb/Trove_0.1.0_amd64.deb
//       bun scripts/linux-package-check.ts src-tauri/target/release/trove --max 2.35
// Checks, each printed as one line:
//   - glibc floor: the highest GLIBC_x.y symbol version the binary needs (`objdump -T`) is at most
//     --max (default 2.35, Ubuntu 22.04). A binary built on a newer distro cannot start on an older one.
//   - ldd: 0 "not found" libraries.
//   - (.deb only) desktop-file-validate exit 0 on every .desktop file in the package.
//   - (.deb only) control fields Package, Version, Architecture, Depends, Description are present.
//   - (.deb only) exactly one AppStream file under /usr/share/metainfo.
// Exit 0 when every check passes, 1 when one fails, 2 on bad usage.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MAX = '2.35';
export const CONTROL_FIELDS = ['Package', 'Version', 'Architecture', 'Depends', 'Description'];

/** -1, 0 or 1, comparing dotted numeric versions ("2.9" < "2.35"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Highest GLIBC_x.y named in `objdump -T` output, or null when there is none. */
export function maxGlibc(objdump: string): string | null {
  let max: string | null = null;
  for (const m of objdump.matchAll(/GLIBC_(\d+(?:\.\d+)+)/g)) {
    if (max === null || compareVersions(m[1], max) > 0) max = m[1];
  }
  return max;
}

/** Lines of `ldd` output that say a library was not found. */
export function notFound(ldd: string): string[] {
  return ldd
    .split('\n')
    .filter((l) => l.includes('not found'))
    .map((l) => l.trim());
}

/** The wanted control fields that `dpkg-deb -f` did not print with a value. */
export function missingFields(control: string, wanted = CONTROL_FIELDS): string[] {
  const have = new Set(
    control
      .split('\n')
      .map((l) => /^([A-Za-z-]+):\s*\S/.exec(l)?.[1])
      .filter(Boolean),
  );
  return wanted.filter((f) => !have.has(f));
}

/** Paths in `dpkg-deb -c` output that sit under /usr/share/metainfo/ (files, not the folder). */
export function metainfoFiles(listing: string): string[] {
  return listing
    .split('\n')
    .map((l) => l.trim().split(/\s+/).pop() ?? '')
    .filter((p) => /(^|\/)usr\/share\/metainfo\/[^/]+$/.test(p));
}

export function parseArgs(argv: string[]): { file: string; max: string } | null {
  let file = '';
  let max = DEFAULT_MAX;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--max') {
      max = argv[++i] ?? '';
      if (!/^\d+(\.\d+)+$/.test(max)) return null;
    } else if (!file) file = argv[i];
    else return null;
  }
  return file ? { file, max } : null;
}

function run(cmd: string, args: string[]): { code: number; out: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.error) return { code: 127, out: `${cmd}: ${r.error.message}` };
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error('usage: bun scripts/linux-package-check.ts <file.deb | binary> [--max 2.35]');
    process.exit(2);
  }
  const isDeb = args.file.endsWith('.deb');
  const fails: string[] = [];
  const check = (ok: boolean, line: string) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}\t${line}`);
    if (!ok) fails.push(line);
  };

  let dir = '';
  let binary = args.file;
  if (isDeb) {
    dir = mkdtempSync(join(tmpdir(), 'trove-deb-'));
    const x = run('dpkg-deb', ['-x', args.file, dir]);
    if (x.code !== 0) {
      console.error(x.out);
      process.exit(1);
    }
    binary = join(dir, 'usr/bin/trove');
  }

  try {
    const glibc = maxGlibc(run('objdump', ['-T', binary]).out);
    check(
      glibc !== null && compareVersions(glibc, args.max) <= 0,
      `glibc: needs GLIBC_${glibc ?? '?'}, max allowed ${args.max}`,
    );

    const ldd = run('ldd', [binary]);
    const missing = notFound(ldd.out);
    check(ldd.code === 0 && missing.length === 0, `ldd: ${missing.length} not found`);
    for (const m of missing) console.log(`\t${m}`);

    if (isDeb) {
      const apps = join(dir, 'usr/share/applications');
      const desktops = (existsSync(apps) ? readdirSync(apps) : []).filter((f) =>
        f.endsWith('.desktop'),
      );
      check(desktops.length > 0, `desktop files: ${desktops.length}`);
      for (const d of desktops) {
        const v = run('desktop-file-validate', [join(apps, d)]);
        check(v.code === 0, `desktop-file-validate ${d}: exit ${v.code}`);
        if (v.out.trim()) console.log(v.out.trim());
      }

      const absent = missingFields(run('dpkg-deb', ['-f', args.file, ...CONTROL_FIELDS]).out);
      check(absent.length === 0, `control fields missing: ${absent.length} ${absent.join(' ')}`);

      const meta = metainfoFiles(run('dpkg-deb', ['-c', args.file]).out);
      check(meta.length === 1, `metainfo files: ${meta.length} ${meta.join(' ')}`);
    }
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }

  process.exit(fails.length ? 1 : 0);
}
