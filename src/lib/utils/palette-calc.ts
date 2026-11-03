// Arithmetic in the palette: `12*(3+4)` becomes a row that reads `= 84`. Hand-written
// tokenizer + recursive-descent parser, deliberately **not** `eval`/`new Function`: the text
// arrives from a global hotkey surface, and a grammar of numbers, `+ - * / ^` and parens
// cannot express identifiers, calls, property access or loops — there is nothing to sandbox.
//
//   expr    := term (('+' | '-') term)*
//   term    := unary (('*' | '/') unary)*
//   unary   := ('+' | '-') unary | power        — the sign binds looser than `^`: -2^2 = -4
//   power   := primary ('^' unary)?             — right-associative: 2^3^2 = 2^9
//   primary := number | '(' expr ')'
//
// No percentages, no units, no functions, no variables — see docs/plans/11 for why `%` waits.

/** The characters that turn a bare number into an expression. */
const OPERATORS = '+-*/^';

/**
 * What the guard tolerates. `%` is in here but is not an operator and has no meaning in the
 * grammar, so `50%` parses to nothing and shows no row — the "50% of 200" (percentage) versus
 * "50 % 200" (modulo) ambiguity is unresolved on purpose, and the character stays inert.
 */
const ARITHMETIC_ONLY = /^[\d\s+\-*/^%.()]+$/;

/** `12`, `12.5`, `12.`, `.5` — no exponents, no separators, no sign (that is `unary`'s job). */
const NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)/;

/** Significant digits kept when formatting; enough to be useful, few enough to hide the noise. */
const SIGNIFICANT_DIGITS = 12;

interface Token {
  kind: 'num' | 'op';
  /** the operator character, or '' for a number */
  op: string;
  /** the value, or 0 for an operator */
  value: number;
}

const tokenize = (text: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i += 1;
    } else if (OPERATORS.includes(c) || c === '(' || c === ')') {
      tokens.push({ kind: 'op', op: c, value: 0 });
      i += 1;
    } else {
      const n = NUMBER.exec(text.slice(i));
      if (!n) throw new Error(`not arithmetic: ${c}`);
      tokens.push({ kind: 'num', op: '', value: Number(n[0]) });
      i += n[0].length;
    }
  }
  return tokens;
};

/** Throws on anything the grammar cannot express; `evaluateExpression` turns that into undefined. */
const parse = (tokens: Token[]): number => {
  let i = 0;
  const eat = (op: string) => {
    const t = tokens[i];
    if (t && t.kind === 'op' && t.op === op) {
      i += 1;
      return true;
    }
    return false;
  };

  const expr = (): number => {
    let left = term();
    for (;;) {
      if (eat('+')) left += term();
      else if (eat('-')) left -= term();
      else return left;
    }
  };

  const term = (): number => {
    let left = unary();
    for (;;) {
      if (eat('*')) {
        left *= unary();
      } else if (eat('/')) {
        const right = unary();
        if (right === 0) throw new Error('division by zero');
        left /= right;
      } else {
        return left;
      }
    }
  };

  const unary = (): number => {
    if (eat('-')) return -unary();
    if (eat('+')) return unary();
    return power();
  };

  const power = (): number => {
    const base = primary();
    return eat('^') ? base ** unary() : base;
  };

  const primary = (): number => {
    const t = tokens[i];
    if (t && t.kind === 'num') {
      i += 1;
      return t.value;
    }
    if (eat('(')) {
      const value = expr();
      if (!eat(')')) throw new Error('unclosed (');
      return value;
    }
    throw new Error('expected a number');
  };

  const value = expr();
  if (i < tokens.length) throw new Error('trailing input');
  return value;
};

/**
 * Is this worth handing to the parser at all? Only arithmetic characters, and at least one
 * operator somewhere other than the front — so a bare number never produces a row, because
 * `2024` is a year and `911` is a phone number, not sums anybody asked to see.
 */
export const looksLikeExpression = (text: string): boolean => {
  const t = text.trim();
  if (!ARITHMETIC_ONLY.test(t)) return false;
  for (let i = 1; i < t.length; i += 1) if (OPERATORS.includes(t[i])) return true;
  return false;
};

/** The value, or undefined on any syntax or semantic error (unclosed paren, `12+`, `1/0`, ∞). */
export const evaluateExpression = (text: string): number | undefined => {
  try {
    const value = parse(tokenize(text.trim()));
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Plain digits for an exact integer; otherwise a round trip through 12 significant digits,
 * which drops binary noise (`0.1+0.2` reads `0.3`, not `0.30000000000000004`) and lets
 * `String` pick the shortest spelling that survives it (`1/3` reads `0.333333333333`).
 */
export const formatResult = (value: number): string =>
  Number.isInteger(value) && Math.abs(value) < 1e15
    ? String(value)
    : String(Number(value.toPrecision(SIGNIFICANT_DIGITS)));
