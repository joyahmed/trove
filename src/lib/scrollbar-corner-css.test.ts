import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/app.css', 'utf8');
const rule = (sel: string) => css.match(new RegExp(`${sel} \\{([^}]*)\\}`))?.[1].trim();

// B.1.13: where the two scrollbars meet, the engine paints a white square unless told otherwise.
describe('scrollbar corner', () => {
  it('has a rule, on the same surface as the track', () => {
    const corner = rule('::-webkit-scrollbar-corner');
    expect(corner).toBeTruthy();
    expect(corner).toBe(rule('::-webkit-scrollbar-track'));
  });
});
