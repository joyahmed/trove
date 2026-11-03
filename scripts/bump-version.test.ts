import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILES, SEMVER, run, versionsMatch } from './bump-version';

const repo = join(import.meta.dir, '..');

function sandbox(): string {
  const d = mkdtempSync(join(tmpdir(), 'bump-'));
  mkdirSync(join(d, 'src-tauri'));
  for (const f of FILES) cpSync(join(repo, f.path), join(d, f.path));
  return d;
}

test('versions_match fails when they differ', () => {
  expect(versionsMatch(['1.0.0', '1.0.0', '1.0.0', '1.0.0'])).toBe(true);
  expect(versionsMatch(['1.0.0', '1.0.1', '1.0.0', '1.0.0'])).toBe(false);
  expect(versionsMatch([])).toBe(false);
});

test('semver check refuses junk', () => {
  for (const bad of ['1.2', 'v1.2.3', '1.2.x', '', '1.2.3.4']) expect(SEMVER.test(bad)).toBe(false);
  for (const ok of ['0.1.0', '10.20.30', '1.0.0-rc.1']) expect(SEMVER.test(ok)).toBe(true);
});

test('bump sets all four files, then --check passes; one hand edit makes --check fail', () => {
  const d = sandbox();
  expect(run(['7.8.9'], d)).toBe(0);
  for (const f of FILES) expect(readFileSync(join(d, f.path), 'utf8')).toContain('7.8.9');
  expect(run(['--check'], d)).toBe(0);
  const p = join(d, 'package.json');
  writeFileSync(p, readFileSync(p, 'utf8').replace('7.8.9', '7.8.8'));
  expect(run(['--check'], d)).toBe(1);
});

test('non-semver changes nothing', () => {
  const d = sandbox();
  const before = readFileSync(join(d, 'package.json'), 'utf8');
  expect(run(['banana'], d)).toBe(2);
  expect(readFileSync(join(d, 'package.json'), 'utf8')).toBe(before);
});

test('bump only touches the version line (diff is the version text)', () => {
  const d = sandbox();
  run(['9.9.9'], d);
  const a = readFileSync(join(repo, 'src-tauri/Cargo.toml'), 'utf8').split('\n');
  const b = readFileSync(join(d, 'src-tauri/Cargo.toml'), 'utf8').split('\n');
  expect(b.filter((l, i) => l !== a[i]).length).toBe(1);
});
