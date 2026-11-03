// Copies scripts/pre-commit and scripts/pre-push into this clone's hooks folder (runs on `bun install`).
// Not `--git-path hooks`: that follows core.hooksPath to the global folder, and the global
// ~/.git-hooks/pre-commit and pre-push chain to these. A hook someone else wrote is left alone.
import { execSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const HOOKS = ['pre-commit', 'pre-push'];

try {
  const hooks = join(
    execSync('git rev-parse --git-common-dir', { encoding: 'utf8' }).trim(),
    'hooks',
  );
  for (const name of HOOKS) {
    const target = join(hooks, name);
    if (existsSync(target) && !readFileSync(target, 'utf8').includes(`Trove ${name}`)) {
      console.log(`install-git-hook: ${target} is not ours, left alone`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(`scripts/${name}`, target);
    chmodSync(target, 0o755);
  }
} catch {
  // not a git clone (a tarball or a CI copy): nothing to install
}
