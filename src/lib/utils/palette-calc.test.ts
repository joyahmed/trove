import { describe, expect, it } from 'vitest';
import { evaluateExpression, formatResult, looksLikeExpression } from './palette-calc';

describe('looksLikeExpression', () => {
  it('needs an operator that is not the first character', () => {
    expect(looksLikeExpression('1+1')).toBe(true);
    expect(looksLikeExpression('12 * (3 + 4)')).toBe(true);
    expect(looksLikeExpression('2^8')).toBe(true);
    expect(looksLikeExpression('  7/2  ')).toBe(true);
  });

  it('never fires on a bare number — a year is not a sum', () => {
    expect(looksLikeExpression('2024')).toBe(false);
    expect(looksLikeExpression('911')).toBe(false);
    expect(looksLikeExpression('3.14')).toBe(false);
    expect(looksLikeExpression('(42)')).toBe(false);
    expect(looksLikeExpression('-5')).toBe(false);
    expect(looksLikeExpression('')).toBe(false);
  });

  it('rejects anything that is not arithmetic, so paths and words never reach the parser', () => {
    expect(looksLikeExpression('C:/Users')).toBe(false);
    expect(looksLikeExpression('notepad')).toBe(false);
    expect(looksLikeExpression('2 + two')).toBe(false);
    expect(looksLikeExpression('alert(1)')).toBe(false);
    expect(looksLikeExpression('1+1;process.exit()')).toBe(false);
  });

  it('tolerates % as a character but the grammar still refuses it', () => {
    expect(looksLikeExpression('50% + 1')).toBe(true);
    expect(evaluateExpression('50% + 1')).toBeUndefined();
    expect(evaluateExpression('50 % 200')).toBeUndefined();
  });
});

describe('evaluateExpression', () => {
  it('does the four operations and respects precedence', () => {
    expect(evaluateExpression('1+1')).toBe(2);
    expect(evaluateExpression('2 + 3 * 4')).toBe(14);
    expect(evaluateExpression('2 * 3 + 4')).toBe(10);
    expect(evaluateExpression('10 - 2 - 3')).toBe(5);
    expect(evaluateExpression('100 / 5 / 2')).toBe(10);
    expect(evaluateExpression('12*(3+4)')).toBe(84);
  });

  it('nests parentheses and lets them beat precedence', () => {
    expect(evaluateExpression('(2 + 3) * 4')).toBe(20);
    expect(evaluateExpression('((1+2)*(3+4))')).toBe(21);
    expect(evaluateExpression('2 * (3 + (4 - 1) * 2)')).toBe(18);
  });

  it('raises to a power, right-associatively, and below the unary sign', () => {
    expect(evaluateExpression('2^8')).toBe(256);
    expect(evaluateExpression('2^3^2')).toBe(512);
    expect(evaluateExpression('-2^2')).toBe(-4);
    expect(evaluateExpression('(-2)^2')).toBe(4);
    expect(evaluateExpression('2^-2')).toBe(0.25);
  });

  it('takes a leading sign and stacks it', () => {
    expect(evaluateExpression('-5+3')).toBe(-2);
    expect(evaluateExpression('3 * -2')).toBe(-6);
    expect(evaluateExpression('--5+0')).toBe(5);
    expect(evaluateExpression('+7-2')).toBe(5);
    expect(evaluateExpression('-(4+1)')).toBe(-5);
  });

  it('reads decimals with or without a leading digit', () => {
    expect(evaluateExpression('.5+.5')).toBe(1);
    expect(evaluateExpression('1.5*2')).toBe(3);
    expect(evaluateExpression('2.+1')).toBe(3);
  });

  it('is undefined on division by zero, however the zero is spelled', () => {
    expect(evaluateExpression('1/0')).toBeUndefined();
    expect(evaluateExpression('0/0')).toBeUndefined();
    expect(evaluateExpression('5/(2-2)')).toBeUndefined();
    expect(evaluateExpression('5/-0')).toBeUndefined();
  });

  it('is undefined on a result that is not a finite number', () => {
    expect(evaluateExpression('9^9^9')).toBeUndefined();
    expect(evaluateExpression('1e308*10')).toBeUndefined();
  });

  it('is undefined on malformed input rather than showing an error row', () => {
    expect(evaluateExpression('12+')).toBeUndefined();
    expect(evaluateExpression('12+*3')).toBeUndefined();
    expect(evaluateExpression(')(')).toBeUndefined();
    expect(evaluateExpression('(1+2')).toBeUndefined();
    expect(evaluateExpression('1+2)')).toBeUndefined();
    expect(evaluateExpression('1 2')).toBeUndefined();
    expect(evaluateExpression('()')).toBeUndefined();
    expect(evaluateExpression('*3')).toBeUndefined();
    expect(evaluateExpression('')).toBeUndefined();
    expect(evaluateExpression('^2')).toBeUndefined();
  });

  it('cannot express anything but arithmetic', () => {
    expect(evaluateExpression('1+1;2')).toBeUndefined();
    expect(evaluateExpression('alert(1)')).toBeUndefined();
    expect(evaluateExpression('(1).toString()')).toBeUndefined();
    expect(evaluateExpression('1e3')).toBeUndefined();
    expect(evaluateExpression('0x10')).toBeUndefined();
  });

  it('survives absurd nesting without taking the palette down with it', () => {
    const deep = '('.repeat(5000) + '1' + ')'.repeat(5000);
    expect(evaluateExpression(deep)).toBeUndefined();
  });
});

describe('formatResult', () => {
  it('prints an exact integer as digits', () => {
    expect(formatResult(84)).toBe('84');
    expect(formatResult(-4)).toBe('-4');
    expect(formatResult(0)).toBe('0');
    expect(formatResult(-0)).toBe('0');
  });

  it('hides binary noise at 12 significant digits', () => {
    expect(formatResult(0.1 + 0.2)).toBe('0.3');
    expect(formatResult(4.35 * 100)).toBe('435');
    expect(formatResult(1.1 * 3)).toBe('3.3');
  });

  it('caps a repeating fraction instead of printing all 17 digits', () => {
    expect(formatResult(1 / 3)).toBe('0.333333333333');
    expect(formatResult(2 / 3)).toBe('0.666666666667');
  });

  it('falls back to exponent notation only where digits would be unreadable', () => {
    expect(formatResult(1e21)).toBe('1e+21');
    expect(formatResult(1e-10)).toBe('1e-10');
  });
});
