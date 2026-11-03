import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPLICATIONS,
  GALLERY,
  HOME,
  HOME_MARK,
  MAX_ADDRESS_HISTORY,
  RECYCLE_BIN,
  THIS_PC,
  crumbTail,
  crumbsOfLocation,
  locationLabel,
  locationText,
  recentLocations,
  parentLocation,
  parseLocation,
  pathLocation,
  sameLocation,
  tabLocation,
  tabToken,
  urlScheme,
} from './location';
import { comingFrom } from '$lib/state/coming-from.svelte';

describe('sameLocation', () => {
  it('compares places by kind and folders by path', () => {
    expect(sameLocation(HOME, { kind: 'home' })).toBe(true);
    expect(sameLocation(HOME, THIS_PC)).toBe(false);
    expect(sameLocation(pathLocation('C:\\Users\\alex'), pathLocation('c:\\users\\ALEX'))).toBe(
      true,
    );
    expect(sameLocation(pathLocation('C:\\a'), pathLocation('C:\\a'))).toBe(true);
    expect(sameLocation(pathLocation('C:\\a'), pathLocation('C:\\b'))).toBe(false);
    expect(sameLocation(pathLocation('C:\\a'), THIS_PC)).toBe(false);
  });
});

describe('parentLocation', () => {
  it('walks a folder up to its parent', () => {
    expect(parentLocation(pathLocation('C:\\Users\\alex'))).toEqual(pathLocation('C:\\Users'));
    expect(parentLocation(pathLocation('C:\\Users'))).toEqual(pathLocation('C:\\'));
  });

  it('a drive root goes up to This PC', () => {
    expect(parentLocation(pathLocation('C:\\'))).toEqual(THIS_PC);
    expect(parentLocation(pathLocation('D:'))).toEqual(THIS_PC);
  });

  it('places and an empty tab have no parent', () => {
    expect(parentLocation(THIS_PC)).toBeNull();
    expect(parentLocation(HOME)).toBeNull();
    expect(parentLocation(pathLocation(''))).toBeNull();
  });
});

describe('locationLabel', () => {
  it('names places, folders and drive roots', () => {
    expect(locationLabel(HOME)).toBe('Home');
    expect(locationLabel(THIS_PC)).toBe('This PC');
    expect(locationLabel(pathLocation('C:\\Users\\alex'))).toBe('alex');
    expect(locationLabel(pathLocation('D:\\'))).toBe('D:');
    expect(locationLabel(pathLocation(''))).toBe('');
  });
});

// Plan 19, 1.4.1: place names are read at call time, so "I'm coming from" renames them live;
// ⛔ the parser keeps taking every name under every style (a saved tab, a typed address).
describe('place names follow the coming-from style', () => {
  afterEach(() => {
    comingFrom.choice = 'native';
  });

  it('names the bin and This PC by the style, without a reload', () => {
    const cases = [
      ['windows', 'Recycle Bin', 'This PC'],
      ['mac', 'Trash', 'This Mac'],
      ['linux', 'Trash', 'This Computer'],
    ] as const;
    for (const [style, bin, pc] of cases) {
      comingFrom.choice = style;
      expect(locationLabel(RECYCLE_BIN)).toBe(bin);
      expect(locationLabel(THIS_PC)).toBe(pc);
      expect(crumbsOfLocation(RECYCLE_BIN)[0].label).toBe(bin);
      expect(locationText(RECYCLE_BIN)).toBe(bin);
      expect(locationLabel(HOME)).toBe('Home');
      expect(locationLabel(GALLERY)).toBe('Gallery');
    }
  });

  it('parses every name under every style', () => {
    for (const style of ['windows', 'mac', 'linux'] as const) {
      comingFrom.choice = style;
      for (const name of ['Recycle Bin', 'Trash']) {
        expect(parseLocation(name)).toEqual(RECYCLE_BIN);
      }
      for (const name of ['This PC', 'This Mac', 'This Computer']) {
        expect(parseLocation(name)).toEqual(THIS_PC);
      }
      expect(parseLocation(locationText(THIS_PC))).toEqual(THIS_PC);
      expect(parseLocation(locationText(RECYCLE_BIN))).toEqual(RECYCLE_BIN);
    }
  });
});

describe('crumbsOfLocation', () => {
  it('a place is a single crumb pointing at itself', () => {
    expect(crumbsOfLocation(THIS_PC)).toEqual([
      { key: 'this-pc', label: 'This PC', location: THIS_PC, sepBefore: true },
    ]);
    expect(crumbsOfLocation(HOME)).toEqual([
      { key: 'home', label: 'Home', location: HOME, sepBefore: true },
    ]);
  });

  it('a folder gives one crumb per segment, each navigable', () => {
    expect(crumbsOfLocation(pathLocation('C:\\Users\\alex'))).toEqual([
      { key: 'C:\\', label: 'C:', location: pathLocation('C:\\'), sepBefore: true },
      { key: 'C:\\Users', label: 'Users', location: pathLocation('C:\\Users'), sepBefore: true },
      {
        key: 'C:\\Users\\alex',
        label: 'alex',
        location: pathLocation('C:\\Users\\alex'),
        sepBefore: true,
      },
    ]);
  });
});

describe('separators: Windows style keeps Explorer look, Mac and Linux style only between', () => {
  const seps = (loc: Parameters<typeof crumbsOfLocation>[0], home: string | null = null) =>
    crumbsOfLocation(loc, home).map((c) => c.sepBefore);
  const places = [
    ['trash', RECYCLE_BIN],
    ['gallery', GALLERY],
    ['this-pc', THIS_PC],
    ['home', HOME],
  ] as const;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('Windows (and off Tauri)', () => {
    it('has a trailing tail', () => {
      expect(crumbTail()).toBe(true);
    });
    it.each(places)('the %s place has a › before it', (_name, loc) => {
      expect(seps(loc)).toEqual([true]);
    });
    it('every crumb of a path and a ~ path has a › before it', () => {
      expect(seps(pathLocation('C:\\Users\\alex'))).toEqual([true, true, true]);
      expect(seps(pathLocation('C:\\Users\\alex\\x'), 'C:\\Users\\alex')).toEqual([true, true]);
      expect(seps(pathLocation('C:\\Users\\alex'), 'C:\\Users\\alex')).toEqual([true]);
    });
  });

  // `os` is what Rust injects (`std::env::consts::OS`): 'macos', not 'darwin'. With the choice
  // on 'native' the style is the host's.
  describe.each(['macos', 'linux'])('%s', (os) => {
    beforeEach(() => {
      vi.stubGlobal('window', { __TROVE_PLATFORM__: { os, thisPcLabel: 'This Mac' } });
    });
    it('has no trailing tail', () => {
      expect(crumbTail()).toBe(false);
    });
    it.each(places)('the %s place is one crumb with no separator', (_name, loc) => {
      expect(seps(loc)).toEqual([false]);
    });
    it('a path and a ~ path put separators only between crumbs', () => {
      expect(seps(pathLocation('/Users/alex/x'))).toEqual([false, true, true, true]);
      expect(seps(pathLocation('/Users/alex/x'), '/Users/alex')).toEqual([false, true]);
      expect(seps(pathLocation('/Users/alex'), '/Users/alex')).toEqual([false]);
    });
  });
});

// Plan 19 Q2 / 3.1 (Joy 2026-10-19): the crumb arrows follow the "I'm coming from" STYLE, not
// the host. Each case fails on the host-only code (`onWindows()`), which ignored the choice.
describe('separators follow the coming-from style, not the host', () => {
  const seps = (loc: Parameters<typeof crumbsOfLocation>[0]) =>
    crumbsOfLocation(loc).map((c) => c.sepBefore);
  // each host with a three-crumb path in its own form (paths stay the host's)
  const hosts = [
    ['windows', undefined, 'C:\\Users\\alex'],
    ['macos', { os: 'macos', thisPcLabel: 'This Mac' }, '/Users/alex'],
    ['linux', { os: 'linux', thisPcLabel: 'This Computer' }, '/home/alex'],
  ] as const;

  afterEach(() => {
    comingFrom.choice = 'native';
    vi.unstubAllGlobals();
  });

  describe.each(hosts)('on a %s host', (_host, injected, path) => {
    beforeEach(() => {
      if (injected) vi.stubGlobal('window', { __TROVE_PLATFORM__: injected });
    });
    it('Windows style: a › before every crumb and a tail', () => {
      comingFrom.choice = 'windows';
      expect(crumbTail()).toBe(true);
      expect(seps(RECYCLE_BIN)).toEqual([true]);
      expect(seps(pathLocation(path))).toEqual([true, true, true]);
    });
    it.each(['mac', 'linux'] as const)('%s style: separators only between, no tail', (style) => {
      comingFrom.choice = style;
      expect(crumbTail()).toBe(false);
      expect(seps(RECYCLE_BIN)).toEqual([false]);
      expect(seps(pathLocation(path))).toEqual([false, true, true]);
    });
  });

  it('a style flip redraws without a restart', () => {
    comingFrom.choice = 'mac';
    expect(seps(THIS_PC)).toEqual([false]);
    comingFrom.choice = 'windows';
    expect(seps(THIS_PC)).toEqual([true]);
  });
});

describe('home as ~ (plan 12, D7)', () => {
  const home = 'C:\\Users\\alex';
  const labels = (path: string) => crumbsOfLocation(pathLocation(path), home).map((c) => c.label);

  it('a root home never turns a whole drive into ~', () => {
    const crumbs = crumbsOfLocation(pathLocation('C:\\Users'), 'C:\\');
    expect(crumbs.map((c) => c.label)).not.toContain(HOME_MARK);
  });

  it('a home given with a trailing separator still matches', () => {
    const crumbs = crumbsOfLocation(pathLocation('C:\\Users\\alex\\x'), 'C:\\Users\\alex\\');
    expect(crumbs.map((c) => c.label)).toEqual([HOME_MARK, 'x']);
  });

  it('a path inside home starts at one ~ crumb that goes home', () => {
    const crumbs = crumbsOfLocation(pathLocation('C:\\Users\\alex\\Documents\\notes'), home);
    expect(crumbs.map((c) => c.label)).toEqual([HOME_MARK, 'Documents', 'notes']);
    expect(crumbs[0].location).toEqual(pathLocation('C:\\Users\\alex'));
    expect(crumbs[2].location).toEqual(pathLocation('C:\\Users\\alex\\Documents\\notes'));
    expect(labels('c:\\users\\alex')).toEqual([HOME_MARK]);
  });

  it('a path outside home, or a sibling sharing its prefix, keeps its full crumbs', () => {
    expect(labels('C:\\Users\\Alexa\\x')).toEqual(['C:', 'Users', 'Alexa', 'x']);
    expect(labels('C:\\Users')).toEqual(['C:', 'Users']);
    expect(labels('D:\\work')).toEqual(['D:', 'work']);
    expect(labels('\\\\wsl.localhost\\Ubuntu\\home\\alex')).toEqual(['Ubuntu', 'home', 'alex']);
  });

  it('with no home known, crumbs are as before', () => {
    expect(crumbsOfLocation(pathLocation('C:\\Users\\alex\\x')).map((c) => c.label)).toEqual([
      'C:',
      'Users',
      'alex',
      'x',
    ]);
  });

  it('typed ~ paths resolve under home; every other form still parses', () => {
    expect(parseLocation('~', home)).toEqual(pathLocation(home));
    expect(parseLocation('~/Documents/notes', home)).toEqual(
      pathLocation('C:\\Users\\alex\\Documents\\notes'),
    );
    expect(parseLocation('~\\Downloads\\', home)).toEqual(
      pathLocation('C:\\Users\\alex\\Downloads'),
    );
    expect(parseLocation('C:\\', home)).toEqual(pathLocation('C:\\'));
    expect(parseLocation('\\\\wsl.localhost\\Ubuntu\\home', home)).toEqual(
      pathLocation('\\\\wsl.localhost\\Ubuntu\\home'),
    );
    expect(parseLocation('Ubuntu:/home/alex', home)).toEqual(
      pathLocation('\\\\wsl.localhost\\Ubuntu\\home\\alex'),
    );
    expect(parseLocation('home', home)).toEqual(HOME);
    // a name that merely starts with ~ is not home
    expect(parseLocation('~draft', home)).toEqual(pathLocation('~draft'));
    // and with no home known, ~ is left as typed rather than guessed
    expect(parseLocation('~/x')).toEqual(pathLocation('~/x'));
  });
});

describe('parseLocation and locationText', () => {
  it('recognises the places by name, in any case, with stray spaces', () => {
    expect(parseLocation('This PC')).toEqual(THIS_PC);
    expect(parseLocation('  this pc ')).toEqual(THIS_PC);
    expect(parseLocation('HOME')).toEqual(HOME);
  });

  it('recognises the Applications place as "applications" and "apps" (plan 17.2.1)', () => {
    expect(parseLocation('Applications')).toEqual(APPLICATIONS);
    expect(parseLocation(' apps ')).toEqual(APPLICATIONS);
    expect(APPLICATIONS).toEqual({ kind: 'applications' });
    expect(locationLabel(APPLICATIONS)).toBe('Applications');
    expect(locationText(APPLICATIONS)).toBe('Applications');
    expect(parentLocation(APPLICATIONS)).toBeNull();
  });

  it('recognises This PC by its macOS and Linux names too, on every OS', () => {
    expect(parseLocation('This Mac')).toEqual(THIS_PC);
    expect(parseLocation(' this computer ')).toEqual(THIS_PC);
    expect(parseLocation('THIS MAC')).toEqual(THIS_PC);
  });

  it("recognises Explorer's CLSID for This PC", () => {
    expect(parseLocation('::{20D04FE0-3AEA-1069-A2D8-08002B30309D}')).toEqual(THIS_PC);
  });

  it('anything else is a path, trimmed', () => {
    expect(parseLocation(' C:\\Users\\alex ')).toEqual(pathLocation('C:\\Users\\alex'));
    expect(parseLocation('Homework')).toEqual(pathLocation('Homework'));
  });

  it('round-trips through locationText', () => {
    for (const loc of [HOME, THIS_PC, pathLocation('C:\\Users\\alex')]) {
      expect(parseLocation(locationText(loc))).toEqual(loc);
    }
  });
});

describe('typed drive paths on Windows use backslashes and a capital drive letter', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'windows', thisPcLabel: 'This PC' } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('turns forward slashes into backslashes', () => {
    expect(parseLocation('C:/trove-test')).toEqual(pathLocation('C:\\trove-test'));
    expect(parseLocation('c:/a/b')).toEqual(pathLocation('C:\\a\\b'));
    expect(parseLocation('C:\\a/b')).toEqual(pathLocation('C:\\a\\b'));
    expect(parseLocation('d:/')).toEqual(pathLocation('D:\\'));
  });

  it('keeps a trailing separator exactly as backslash input does', () => {
    expect(parseLocation('c:\\a\\b\\')).toEqual(pathLocation('C:\\a\\b\\'));
    expect(parseLocation('c:/a/b/')).toEqual(pathLocation('C:\\a\\b\\'));
  });

  it('leaves backslash input, tokens and UNC alone', () => {
    expect(parseLocation('C:\\trove-test')).toEqual(pathLocation('C:\\trove-test'));
    expect(parseLocation('::{20D04FE0-3AEA-1069-A2D8-08002B30309D}')).toEqual(THIS_PC);
    expect(parseLocation('trove:home')).toEqual(HOME);
    expect(parseLocation('\\\\server\\share')).toEqual(pathLocation('\\\\server\\share'));
    // nothing treats UNC as a special path today, so forward-slash UNC is left as typed
    expect(parseLocation('//server/share')).toEqual(pathLocation('//server/share'));
  });

  it('a WSL path in Linux form still maps to its UNC root', () => {
    expect(parseLocation('Ubuntu:/home/a')).toEqual(
      pathLocation('\\\\wsl.localhost\\Ubuntu\\home\\a'),
    );
  });

  it('a typed URL is never read as a WSL distro', () => {
    expect(parseLocation('https://example.com/a')).toEqual(pathLocation('https://example.com/a'));
    expect(parseLocation('ftp://host/x.zip/y')).toEqual(pathLocation('ftp://host/x.zip/y'));
    expect(parseLocation('Ubuntu-22.04:/home/a')).toEqual(
      pathLocation('\\\\wsl.localhost\\Ubuntu-22.04\\home\\a'),
    );
    expect(parseLocation('C:\\a')).toEqual(pathLocation('C:\\a'));
  });

  it('a file:// URL is the local path it names', () => {
    expect(parseLocation('file:///C:/Users/a%20b')).toEqual(pathLocation('C:\\Users\\a b'));
    expect(parseLocation('FILE://c:/a')).toEqual(pathLocation('C:\\a'));
    expect(parseLocation('file://server/share/x')).toEqual(pathLocation('\\\\server\\share\\x'));
    expect(parseLocation('file://localhost/C:/a')).toEqual(pathLocation('C:\\a'));
  });
});

describe('typed paths off Windows are left alone', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'linux', thisPcLabel: 'This Computer' } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps / paths and drive-looking text as typed', () => {
    expect(parseLocation('/home/a')).toEqual(pathLocation('/home/a'));
    expect(parseLocation('c:/a')).toEqual(pathLocation('c:/a'));
  });

  it('a file:// URL is the local path it names', () => {
    expect(parseLocation('file:///home/a%20b')).toEqual(pathLocation('/home/a b'));
    expect(parseLocation('file://localhost/home/a')).toEqual(pathLocation('/home/a'));
  });
});

describe('WSL locations', () => {
  const ROOT = '\\\\wsl.localhost\\Ubuntu\\';
  const home = pathLocation('\\\\wsl.localhost\\Ubuntu\\home\\alex');
  const root = pathLocation(ROOT);

  it('is typed and shown in the Linux form and round-trips', () => {
    expect(locationText(home)).toBe('Ubuntu:/home/alex');
    expect(parseLocation('Ubuntu:/home/alex')).toEqual(home);
    expect(parseLocation(locationText(root))).toEqual(root);
  });

  it('a distro root is labelled by the distro and goes up to This PC', () => {
    expect(locationLabel(root)).toBe('Ubuntu');
    expect(locationLabel(home)).toBe('alex');
    expect(parentLocation(root)).toEqual(THIS_PC);
    expect(crumbsOfLocation(root)).toEqual([
      { key: ROOT, label: 'Ubuntu', location: root, sepBefore: true },
    ]);
  });

  it('a drive letter with a forward slash is a Windows path, with backslashes', () => {
    expect(parseLocation('C:/Users')).toEqual(pathLocation('C:\\Users'));
  });

  it('Gallery is a place: labelled, typed, parsed, with no parent', () => {
    expect(parseLocation('gallery')).toEqual(GALLERY);
    expect(locationLabel(GALLERY)).toBe('Gallery');
    expect(locationText(GALLERY)).toBe('Gallery');
    expect(parentLocation(GALLERY)).toBeNull();
  });

  it("the Recycle Bin is a place, also from Explorer's CLSID in any case", () => {
    expect(parseLocation('Recycle Bin')).toEqual(RECYCLE_BIN);
    expect(parseLocation('::{645FF040-5081-101B-9F08-00AA002F954E}')).toEqual(RECYCLE_BIN);
    expect(parseLocation('::{645ff040-5081-101b-9f08-00aa002f954e}')).toEqual(RECYCLE_BIN);
    expect(locationLabel(RECYCLE_BIN)).toBe('Recycle Bin');
    expect(parseLocation(locationText(RECYCLE_BIN))).toEqual(RECYCLE_BIN);
    expect(parentLocation(RECYCLE_BIN)).toBeNull();
  });
});

describe('POSIX locations (macOS, Linux)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'linux', thisPcLabel: 'This Computer' } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Up walks to / and then to This PC', () => {
    expect(parentLocation(pathLocation('/home/alex'))).toEqual(pathLocation('/home'));
    expect(parentLocation(pathLocation('/home'))).toEqual(pathLocation('/'));
    expect(parentLocation(pathLocation('/'))).toEqual(THIS_PC);
  });

  it('crumbs navigate to real paths, starting at /', () => {
    expect(crumbsOfLocation(pathLocation('/home/alex')).map((c) => c.location)).toEqual([
      pathLocation('/'),
      pathLocation('/home'),
      pathLocation('/home/alex'),
    ]);
    expect(locationLabel(pathLocation('/'))).toBe('/');
    expect(locationLabel(pathLocation('/home/alex'))).toBe('alex');
  });

  it('home is ~ on macOS and Linux too, and ~/x types into it', () => {
    for (const home of ['/home/alex', '/Users/alex']) {
      const crumbs = crumbsOfLocation(pathLocation(`${home}/src/trove`), home);
      expect(crumbs.map((c) => c.label)).toEqual([HOME_MARK, 'src', 'trove']);
      expect(crumbs[0].location).toEqual(pathLocation(home));
      expect(parseLocation('~/src/trove', home)).toEqual(pathLocation(`${home}/src/trove`));
    }
    expect(
      crumbsOfLocation(pathLocation('/home/Alex/x'), '/home/alex').map((c) => c.label),
    ).toEqual(['/', 'home', 'Alex', 'x']);
  });

  it('compares paths with their case', () => {
    expect(sameLocation(pathLocation('/home/Alex'), pathLocation('/home/alex'))).toBe(false);
    expect(sameLocation(pathLocation('/home/alex'), pathLocation('/home/alex'))).toBe(true);
  });
});

describe('the archive kind (plan 16, Phase 4)', () => {
  const zip = (inner = '') => ({ kind: 'archive' as const, archive: 'C:\\t\\a.zip', inner });

  it('sameLocation: same archive and inner; never equal to the archive file as a path', () => {
    expect(sameLocation(zip('docs'), { ...zip('docs'), archive: 'c:\\T\\A.zip' })).toBe(true);
    expect(sameLocation(zip('docs'), zip())).toBe(false);
    expect(sameLocation(zip(), pathLocation('C:\\t\\a.zip'))).toBe(false);
  });

  it('parentLocation: inner → up a level; top → the containing folder', () => {
    expect(parentLocation(zip('docs/sub'))).toEqual(zip('docs'));
    expect(parentLocation(zip())).toEqual(pathLocation('C:\\t'));
  });

  it('locationLabel and the crumbs read `t › a.zip › docs`', () => {
    expect(locationLabel(zip())).toBe('a.zip');
    expect(locationLabel(zip('docs'))).toBe('docs');
    const crumbs = crumbsOfLocation(zip('docs'), null);
    expect(crumbs.map((c) => c.label).slice(-3)).toEqual(['t', 'a.zip', 'docs']);
    expect(crumbs.at(-2)?.location).toEqual(zip());
  });

  it('locationText and parseLocation round-trip; a plain path stays a path', () => {
    expect(locationText(zip('docs'))).toBe('C:\\t\\a.zip\\docs');
    expect(parseLocation('C:\\t\\a.zip\\docs')).toEqual(zip('docs'));
    expect(parseLocation('C:\\t\\a.zip')).toEqual(pathLocation('C:\\t\\a.zip'));
    expect(parseLocation('C:\\t\\docs')).toEqual(pathLocation('C:\\t\\docs'));
  });
});

describe('tabToken and tabLocation: a tab as the session saves it (plan 15 G.45)', () => {
  it('every place round-trips through a fixed token, the same in every language', () => {
    for (const place of [HOME, THIS_PC, GALLERY, APPLICATIONS, RECYCLE_BIN]) {
      expect(tabLocation(tabToken(place))).toEqual(place);
    }
    expect(tabToken(HOME)).toBe('trove:home');
    expect(tabToken(THIS_PC)).toBe('::{20d04fe0-3aea-1069-a2d8-08002b30309d}');
    expect(tabToken(RECYCLE_BIN)).toBe('::{645ff040-5081-101b-9f08-00aa002f954e}');
  });

  it('a folder is its path, read back as a path even when it looks like a place name', () => {
    expect(tabToken(pathLocation('C:\\a'))).toBe('C:\\a');
    expect(tabLocation('C:\\a')).toEqual(pathLocation('C:\\a'));
    expect(tabLocation('Home')).toEqual(pathLocation('Home'));
  });

  it('an unknown trove: token is skipped, never opened as a path', () => {
    expect(tabLocation('trove:x')).toBeNull();
    expect(tabLocation('')).toBeNull();
  });

  it('an archive or empty tab is not saved', () => {
    expect(tabToken({ kind: 'archive', archive: 'C:\\t\\a.zip', inner: '' })).toBe('');
    expect(tabToken(pathLocation(''))).toBe('');
  });

  it('a one-tab restored window reads its token through parseLocation too', () => {
    expect(parseLocation('trove:home')).toEqual(HOME);
    expect(parseLocation('trove:gallery')).toEqual(GALLERY);
    expect(parseLocation('trove:applications')).toEqual(APPLICATIONS);
  });
});

describe('urlScheme', () => {
  it('names the scheme of a typed link, lower-cased', () => {
    expect(urlScheme('https://example.com/a')).toBe('https');
    expect(urlScheme(' HTTP://example.com ')).toBe('http');
    expect(urlScheme('ftp://host/x')).toBe('ftp');
    expect(urlScheme('file:///C:/a')).toBe('file');
    expect(urlScheme('mailto:alex@example.com')).toBe('mailto');
    expect(urlScheme('ssh://host')).toBe('ssh');
  });

  it('is null for paths, WSL distros and places', () => {
    for (const text of ['C:\\a', 'c:/a', 'Ubuntu:/home/a', '/home/a', 'trove:home', 'This PC'])
      expect(urlScheme(text)).toBeNull();
  });
});

describe('typed . and .. segments are resolved, so Recent never gets a tile named ..', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Windows: climbs one level, stops at the root', () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'windows', thisPcLabel: 'This PC' } });
    expect(parseLocation(String.raw`C:\a\b\..`)).toEqual(pathLocation(String.raw`C:\a`));
    expect(parseLocation('c:/a/b/..')).toEqual(pathLocation(String.raw`C:\a`));
    expect(parseLocation(String.raw`C:\a\.\b`)).toEqual(pathLocation(String.raw`C:\a\b`));
    expect(parseLocation(String.raw`C:\a\..`)).toEqual(pathLocation('C:\\'));
    expect(parseLocation(String.raw`C:\..`)).toEqual(pathLocation('C:\\'));
    expect(parseLocation(String.raw`C:\..\..\a`)).toEqual(pathLocation(String.raw`C:\a`));
  });

  it('Windows: a share and a WSL distro are the floor', () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'windows', thisPcLabel: 'This PC' } });
    expect(parseLocation(String.raw`\\server\share\a\..`)).toEqual(
      pathLocation(String.raw`\\server\share` + '\\'),
    );
    expect(parseLocation(String.raw`\\server\share\..`)).toEqual(
      pathLocation(String.raw`\\server\share` + '\\'),
    );
    expect(parseLocation('Ubuntu:/home/alex/..')).toEqual(
      pathLocation(String.raw`\\wsl.localhost\Ubuntu\home`),
    );
    expect(parseLocation('Ubuntu:/..')).toEqual(
      pathLocation(String.raw`\\wsl.localhost\Ubuntu` + '\\'),
    );
  });

  it('Linux and macOS: / is the floor, a relative path keeps what it cannot resolve', () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'linux', thisPcLabel: 'This Computer' } });
    expect(parseLocation('/home/a/..')).toEqual(pathLocation('/home'));
    expect(parseLocation('/home/a/../b/./c')).toEqual(pathLocation('/home/b/c'));
    expect(parseLocation('/..')).toEqual(pathLocation('/'));
    expect(parseLocation('a/./b')).toEqual(pathLocation('a/b'));
    expect(parseLocation('../a')).toEqual(pathLocation('../a'));
  });

  it('a path without dot segments is untouched; ~/.. resolves above home', () => {
    vi.stubGlobal('window', { __TROVE_PLATFORM__: { os: 'linux', thisPcLabel: 'This Computer' } });
    expect(parseLocation('/home/a/')).toEqual(pathLocation('/home/a/'));
    expect(parseLocation('/home/.hidden/x')).toEqual(pathLocation('/home/.hidden/x'));
    expect(parseLocation('~/..', '/home/alex')).toEqual(pathLocation('/home'));
  });
});

describe('recentLocations: the address bar ▾ list', () => {
  const a = pathLocation(String.raw`C:\a`);
  const b = pathLocation(String.raw`C:\b`);
  const c = pathLocation(String.raw`C:\c`);

  it('lists Back newest first and leaves out the place on screen', () => {
    expect(recentLocations([a, b], c, [])).toEqual([b, a]);
  });

  it('puts the places Back left behind first: they were seen last', () => {
    // A → B → C, then Back twice: forward = [C, B], on A
    expect(recentLocations([], a, [c, b])).toEqual([c, b]);
    // A → B → C, then Back once: back = [A], forward = [C], on B
    expect(recentLocations([a], b, [c])).toEqual([c, a]);
  });

  it('lists each place once, case-blind on Windows paths, and places by kind', () => {
    const shouted = pathLocation(String.raw`c:\A`);
    expect(recentLocations([HOME, a, THIS_PC, shouted, HOME], b, [])).toEqual([
      HOME,
      shouted,
      THIS_PC,
    ]);
  });

  it('skips the blank new-tab entry and caps the list', () => {
    expect(recentLocations([pathLocation(''), a], b, [])).toEqual([a]);
    const many = Array.from({ length: 30 }, (_, i) => pathLocation(String.raw`C:\f` + i));
    const list = recentLocations(many, a, []);
    expect(list).toHaveLength(MAX_ADDRESS_HISTORY);
    expect(list[0]).toEqual(pathLocation(String.raw`C:\f29`));
    expect(recentLocations(many, a, [], 3)).toHaveLength(3);
  });
});
