// Fails when a tracked file carries a private word (a machine name, a real username, a personal
// address). The word list is NOT in this file: it lives in docs/ai-memory/private-words.txt, a
// folder the public export always drops. Without that file (the public repo) this prints a note
// and exits 0.
// Use:  bun scripts/private-words-check.ts
// List format, one per line:  `# comment`, `w:Word` = whole word, case-sensitive,
//   anything else = fixed text, case-insensitive.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LIST = 'docs/ai-memory/private-words.txt';
/** Paths the public export drops, so they may name private things. */
export const DROPPED = [
  'docs/ai-memory/',
  'docs/plans/',
  'docs/screenshots/',
  'docs/JOY-CHECKLIST.md',
  'PLAN.md',
];

export type Rule = { raw: string; test: (line: string) => boolean };

export function parseRules(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const line of text.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) continue;
    if (raw.startsWith('w:')) {
      const word = raw.slice(2);
      const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`);
      rules.push({ raw, test: (l) => re.test(l) });
    } else {
      const needle = raw.toLowerCase();
      rules.push({ raw, test: (l) => l.toLowerCase().includes(needle) });
    }
  }
  return rules;
}

export type Hit = { file: string; line: number; rule: string };

export function scan(file: string, content: string, rules: Rule[]): Hit[] {
  if (content.includes('\0')) return [];
  const hits: Hit[] = [];
  content.split('\n').forEach((text, i) => {
    for (const r of rules) if (r.test(text)) hits.push({ file, line: i + 1, rule: r.raw });
  });
  return hits;
}

export function isDropped(path: string): boolean {
  return DROPPED.some((d) => (d.endsWith('/') ? path.startsWith(d) : path === d));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const listPath = resolve(root, LIST);
  if (!existsSync(listPath)) {
    console.log(`private-words-check: ${LIST} not present (public repo?) - nothing to check`);
    process.exit(0);
  }
  const rules = parseRules(readFileSync(listPath, 'utf8'));
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 28 })
    .toString()
    .split('\0')
    .filter((f) => f && !isDropped(f) && existsSync(resolve(root, f)));
  const hits = files.flatMap((f) => scan(f, readFileSync(resolve(root, f), 'latin1'), rules));
  for (const h of hits) console.error(`${h.file}:${h.line}  matches "${h.rule}"`);
  console.log(
    `private-words-check: ${files.length} files, ${rules.length} rules, ${hits.length} hits`,
  );
  process.exit(hits.length ? 1 : 0);
}
