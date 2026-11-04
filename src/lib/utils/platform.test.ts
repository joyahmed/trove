import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { paletteActions } from '$lib/data/palette-actions';
import { comingFrom } from '$lib/state/coming-from.svelte';
// ⚠️ static on purpose: a test below resets modules, and a fresh `platform` would read a fresh
// `comingFrom`, not the one these tests set
import {
  binName,
  inBinWords,
  launchLabel,
  onMac,
  onWindows,
  propertiesLabel,
  selfUpdates,
  readsRar,
  storeBuild,
  THIS_PC_LABELS,
  thisPcLabel,
} from '$lib/utils/platform';

afterEach(() => {
  comingFrom.choice = 'native';
});

describe('thisPcLabel', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is Windows' name when Rust set nothing (tests, a plain browser)", () => {
    expect(thisPcLabel()).toBe('This PC');
  });

  it('is what Rust injected while the choice is native, for each of the three platforms', () => {
    for (const label of THIS_PC_LABELS) {
      vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'x', thisPcLabel: label } });
      expect(thisPcLabel()).toBe(label);
    }
  });

  it("refuses a name the parser would not read back, and falls back to the host's", () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'linux', thisPcLabel: 'My Computer' } });
    expect(thisPcLabel()).toBe('This Computer');
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'x', thisPcLabel: 'My Computer' } });
    expect(thisPcLabel()).toBe('This PC');
  });

  // Plan 19, 1.1.2: the word follows the style, whatever the host
  it('names the place by the style: This PC / This Mac / This Computer', () => {
    expect(thisPcLabel('windows')).toBe('This PC');
    expect(thisPcLabel('mac')).toBe('This Mac');
    expect(thisPcLabel('linux')).toBe('This Computer');
    // every name a style gives is one the parser reads back (B.2.2)
    for (const style of ['windows', 'mac', 'linux'] as const) {
      expect(THIS_PC_LABELS).toContain(thisPcLabel(style));
    }
  });

  it('follows a chosen style over what Rust injected', () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'windows', thisPcLabel: 'This PC' } });
    comingFrom.choice = 'mac';
    expect(thisPcLabel()).toBe('This Mac');
    comingFrom.choice = 'linux';
    expect(thisPcLabel()).toBe('This Computer');
    comingFrom.choice = 'native';
    expect(thisPcLabel()).toBe('This PC');
  });
});

describe('a Mac build, end to end through the module-level label', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('names the place This Mac and still round-trips it through the parser', async () => {
    // what `platform_init_script` sets before any page script runs
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'macos', thisPcLabel: 'This Mac' } });
    vi.resetModules();
    const loc = await import('$lib/utils/location');
    const palette = await import('$lib/data/palette-actions');

    expect(loc.locationLabel(loc.THIS_PC)).toBe('This Mac');
    expect(loc.locationText(loc.THIS_PC)).toBe('This Mac');
    // ⛔ B.2.2: a detached tab carries the label in `?open=`; it must come back as the place
    expect(loc.parseLocation(loc.locationText(loc.THIS_PC))).toEqual(loc.THIS_PC);
    // the palette row is renamed, its key is not (B.2.1)
    const row = palette.paletteActions.find((a) => a.key === 'open-this-pc');
    expect(row?.label).toBe('Open This Mac');
  });
});

describe('protocolOrigin', () => {
  const on = (os: string) => ({ os, thisPcLabel: 'x' });

  it('keeps the Windows form on Windows and when nothing is injected', async () => {
    const { protocolOrigin } = await import('$lib/utils/platform');
    expect(protocolOrigin('icon', undefined)).toBe('http://icon.localhost');
    expect(protocolOrigin('icon', on('windows'))).toBe('http://icon.localhost');
    expect(protocolOrigin('preview', on('windows'))).toBe('http://preview.localhost');
  });

  it('uses scheme://localhost on macOS and Linux, where Tauri serves it that way', async () => {
    const { protocolOrigin } = await import('$lib/utils/platform');
    for (const os of ['macos', 'linux']) {
      expect(protocolOrigin('icon', on(os))).toBe('icon://localhost');
      expect(protocolOrigin('preview', on(os))).toBe('preview://localhost');
    }
  });
});

describe('binName and onWindows', () => {
  const on = (os: string) => ({ os, thisPcLabel: 'x' });
  afterEach(() => vi.unstubAllGlobals());

  it('is the Recycle Bin in Windows style and the Trash in Mac and Linux style', async () => {
    expect(binName('windows')).toBe('Recycle Bin');
    expect(binName('mac')).toBe('Trash');
    expect(binName('linux')).toBe('Trash');
  });

  it('follows the host by default: the Recycle Bin on Windows and with nothing injected', async () => {
    expect(binName()).toBe('Recycle Bin');
    for (const [os, word] of [
      ['windows', 'Recycle Bin'],
      ['macos', 'Trash'],
      ['linux', 'Trash'],
    ]) {
      vi.stubGlobal('window', { __TROVE_PLATFORM__: on(os) });
      expect(binName()).toBe(word);
    }
    vi.unstubAllGlobals();
    expect(onWindows(undefined)).toBe(true);
    expect(onWindows(on('linux'))).toBe(false);
  });

  it('follows the chosen style live, and onWindows stays the host', async () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: on('windows') });
    comingFrom.choice = 'mac';
    expect(binName()).toBe('Trash');
    expect(onWindows()).toBe(true);
    comingFrom.choice = 'native';
    expect(binName()).toBe('Recycle Bin');
  });
});

describe('propertiesLabel', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is Get Info only in Mac style', async () => {
    expect(propertiesLabel('windows')).toBe('Properties');
    expect(propertiesLabel('mac')).toBe('Get Info');
    expect(propertiesLabel('linux')).toBe('Properties');
  });

  it('follows the host by default and the chosen style when set', async () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'macos', thisPcLabel: 'This Mac' } });
    expect(propertiesLabel()).toBe('Get Info');
    comingFrom.choice = 'windows';
    expect(propertiesLabel()).toBe('Properties');
    expect(onMac()).toBe(true);
  });
});

describe('palette rows follow the style live (plan 19, 1.4.2)', () => {
  it('renames Open This PC and Open Recycle Bin without a reload', async () => {
    const label = (key: string) => paletteActions.find((a) => a.key === key)?.label;
    expect(label('open-this-pc')).toBe('Open This PC');
    expect(label('open-recycle-bin')).toBe('Open Recycle Bin');
    comingFrom.choice = 'mac';
    expect(label('open-this-pc')).toBe('Open This Mac');
    expect(label('open-recycle-bin')).toBe('Open Trash');
    comingFrom.choice = 'linux';
    expect(label('open-this-pc')).toBe('Open This Computer');
    expect(label('open-recycle-bin')).toBe('Open Trash');
  });
});

describe('onMac', () => {
  it('is a Mac build only, and not when nothing is injected', async () => {
    expect(onMac({ os: 'macos', thisPcLabel: 'This Mac' })).toBe(true);
    expect(onMac({ os: 'linux', thisPcLabel: 'This Computer' })).toBe(false);
    expect(onMac({ os: 'windows', thisPcLabel: 'This PC' })).toBe(false);
    expect(onMac(undefined)).toBe(false);
  });
});

describe('inBinWords: Rust sentences in the chosen bin word (plan 19 Q3)', () => {
  // the Mac's Full Disk Access sentence, as `recycle_mac.rs` NEEDS_FULL_DISK_ACCESS writes it
  const FDA =
    'Trove needs Full Disk Access to show the Trash. Open System Settings → Privacy & Security → Full Disk Access.';
  afterEach(() => vi.unstubAllGlobals());

  it('Windows picked on a Mac: the Full Disk Access sentence says Recycle Bin (Mac, 2026-10-08)', () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'macos', thisPcLabel: 'This Mac' } });
    comingFrom.choice = 'windows';
    expect(inBinWords(FDA)).toBe(
      'Trove needs Full Disk Access to show the Recycle Bin. Open System Settings → Privacy & Security → Full Disk Access.',
    );
    comingFrom.choice = 'mac';
    expect(inBinWords(FDA)).toBe(FDA);
  });

  it('rewrites the Windows notices to Trash in Mac and Linux style, keeping "The" capitalised', () => {
    for (const style of ['mac', 'linux'] as const) {
      expect(
        inBinWords('The Recycle Bin is turned off for C:, so nothing was deleted', style),
      ).toBe('The Trash is turned off for C:, so nothing was deleted');
      expect(inBinWords('D: has no Recycle Bin, so nothing was deleted', style)).toBe(
        'D: has no Trash, so nothing was deleted',
      );
      expect(inBinWords('Trove cannot tell whether D: has a Recycle Bin', style)).toBe(
        'Trove cannot tell whether D: has a Trash',
      );
    }
    expect(inBinWords('Not in the Trash any more: a.txt', 'windows')).toBe(
      'Not in the Recycle Bin any more: a.txt',
    );
  });

  it('leaves a file name alone: only the bin as a noun after the/a/no is renamed', () => {
    expect(inBinWords('Could not delete Trash.txt from the Trash.', 'windows')).toBe(
      'Could not delete Trash.txt from the Recycle Bin.',
    );
    expect(inBinWords('Copied Recycle Bin notes.docx', 'mac')).toBe(
      'Copied Recycle Bin notes.docx',
    );
  });

  it('the recycle view and every toast show Rust text through it', () => {
    const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
    expect(read('../hooks/use-recycle-view.svelte.ts')).toMatch(/inBinWords\(recycle\.error\)/);
    expect(read('../components/shell/shell-parts/Toast.svelte')).toMatch(
      /inBinWords\(notice\.message\)/,
    );
  });
});

describe('launchLabel: the Applications menu verb (plan 19)', () => {
  it('Start in Windows style, Open in Mac and Linux style', () => {
    expect(launchLabel('windows')).toBe('Start');
    expect(launchLabel('mac')).toBe('Open');
    expect(launchLabel('linux')).toBe('Open');
  });

  it('follows the chosen style live', () => {
    comingFrom.choice = 'mac';
    expect(launchLabel()).toBe('Open');
    comingFrom.choice = 'windows';
    expect(launchLabel()).toBe('Start');
  });
});

describe('storeBuild', () => {
  const at = (channel?: string) =>
    ({ os: 'windows', thisPcLabel: 'This PC', channel }) as Parameters<typeof storeBuild>[0];

  it('is the Microsoft Store build only when Rust says msstore', () => {
    expect(storeBuild(at('msstore'))).toBe(true);
    expect(storeBuild(at('direct'))).toBe(false);
    expect(storeBuild(at(undefined))).toBe(false);
    expect(storeBuild(at('MSSTORE'))).toBe(false);
  });

  it('is the direct build off Tauri (nothing injected)', () => {
    expect(storeBuild(undefined)).toBe(false);
  });
});

describe('selfUpdates', () => {
  const at = (updater?: boolean) =>
    ({ os: 'windows', thisPcLabel: 'This PC', updater }) as Parameters<typeof selfUpdates>[0];

  it('is a self-updating build only when Rust says updater: true', () => {
    expect(selfUpdates(at(true))).toBe(true);
    expect(selfUpdates(at(false))).toBe(false);
    expect(selfUpdates(at(undefined))).toBe(false);
  });

  it('never updates itself off Tauri (nothing injected)', () => {
    expect(selfUpdates(undefined)).toBe(false);
  });
});

describe('readsRar', () => {
  const at = (rar?: boolean) =>
    ({ os: 'windows', thisPcLabel: 'This PC', rar }) as Parameters<typeof readsRar>[0];

  it('reads RAR only when Rust says rar: true (the rar feature is built in)', () => {
    expect(readsRar(at(true))).toBe(true);
    expect(readsRar(at(false))).toBe(false);
    expect(readsRar(at(undefined))).toBe(false);
  });

  it('never reads RAR off Tauri (nothing injected)', () => {
    expect(readsRar(undefined)).toBe(false);
  });
});
