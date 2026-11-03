// "I'm coming from" (plan 19, 1.1.1): the host map, 'native' resolving to it, and the
// first-paint mirror refusing junk and storage that throws.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMING_FROM_STORAGE_KEY,
  comingFrom,
  hostStyle,
  readMirror,
  toChoice,
} from './coming-from.svelte';

const on = (os: string) => ({ os, thisPcLabel: 'x' });

afterEach(() => {
  comingFrom.choice = 'native';
  vi.unstubAllGlobals();
});

describe('hostStyle', () => {
  it('maps the three OS names Rust injects, and nothing injected to Windows', () => {
    expect(hostStyle(on('macos'))).toBe('mac');
    expect(hostStyle(on('linux'))).toBe('linux');
    expect(hostStyle(on('windows'))).toBe('windows');
    expect(hostStyle(undefined)).toBe('windows');
    expect(hostStyle(on('freebsd'))).toBe('windows');
  });

  it('reads what Rust injected at call time by default', () => {
    expect(hostStyle()).toBe('windows');
    vi.stubGlobal('window', { __TROVE_PLATFORM__: on('macos') });
    expect(hostStyle()).toBe('mac');
  });
});

describe('comingFrom.style', () => {
  it("resolves 'native' to the host, on each host", () => {
    for (const [os, style] of [
      ['windows', 'windows'],
      ['macos', 'mac'],
      ['linux', 'linux'],
    ]) {
      vi.stubGlobal('window', { __TROVE_PLATFORM__: on(os) });
      expect(comingFrom.style).toBe(style);
    }
  });

  it('is the chosen style whatever the host', () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: on('windows') });
    comingFrom.choice = 'mac';
    expect(comingFrom.style).toBe('mac');
    comingFrom.choice = 'linux';
    expect(comingFrom.style).toBe('linux');
  });
});

describe('toChoice and the first-paint mirror', () => {
  it('keeps the three styles and native, anything else is native', () => {
    for (const c of ['native', 'windows', 'mac', 'linux'] as const) expect(toChoice(c)).toBe(c);
    for (const junk of ['beos', 'Mac', '', 7, null, undefined, {}]) {
      expect(toChoice(junk)).toBe('native');
    }
  });

  it('reads the stored choice, and junk or nothing as native', () => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null });
    expect(readMirror()).toBe('native');
    store[COMING_FROM_STORAGE_KEY] = 'mac';
    expect(readMirror()).toBe('mac');
    store[COMING_FROM_STORAGE_KEY] = 'beos';
    expect(readMirror()).toBe('native');
  });

  it('is native when storage throws (blocked site data)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
    });
    expect(readMirror()).toBe('native');
  });

  it('is native with no localStorage at all (node, Spotlight before load)', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(readMirror()).toBe('native');
  });
});
