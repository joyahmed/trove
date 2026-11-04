import { describe, expect, it } from 'vitest';
import {
  crumbsOf,
  folderKey,
  fromLinuxForm,
  isDriveRoot,
  isRootPath,
  isWslPath,
  nameOf,
  parentOf,
  pathKey,
  pathSep,
  samePath,
  toLinuxForm,
  wslRootOf,
} from './path';

const HOME = '\\\\wsl.localhost\\Ubuntu\\home\\alex';
const ROOT = '\\\\wsl.localhost\\Ubuntu\\';

describe('parentOf', () => {
  it('walks up to the drive root and stops there', () => {
    expect(parentOf('C:\\Users\\alex')).toBe('C:\\Users');
    expect(parentOf('C:\\Users')).toBe('C:\\');
    expect(parentOf('C:\\')).toBeNull();
    expect(parentOf('C:')).toBeNull();
  });

  it('ignores trailing separators', () => {
    expect(parentOf('C:\\Users\\alex\\')).toBe('C:\\Users');
  });

  it('walks a WSL path up to the distro root and stops there', () => {
    expect(parentOf(HOME)).toBe('\\\\wsl.localhost\\Ubuntu\\home');
    expect(parentOf('\\\\wsl.localhost\\Ubuntu\\home')).toBe(ROOT);
    expect(parentOf(ROOT)).toBeNull();
    expect(parentOf('\\\\wsl.localhost\\Ubuntu')).toBeNull();
  });
});

describe('nameOf', () => {
  it('is the last segment on Windows, either slash, and empty for a root', () => {
    expect(nameOf('C:\\Users\\alex\\a.txt')).toBe('a.txt');
    expect(nameOf('C:/Users/alex/')).toBe('alex');
    expect(nameOf('C:\\')).toBe('');
    expect(nameOf(HOME)).toBe('alex');
    expect(nameOf(ROOT)).toBe('');
  });
});

describe('crumbsOf', () => {
  it('gives one crumb per segment with the drive as C:\\', () => {
    expect(crumbsOf('C:\\Users\\alex')).toEqual([
      { label: 'C:', path: 'C:\\' },
      { label: 'Users', path: 'C:\\Users' },
      { label: 'alex', path: 'C:\\Users\\alex' },
    ]);
  });

  it('a drive root is a single crumb', () => {
    expect(crumbsOf('D:\\')).toEqual([{ label: 'D:', path: 'D:\\' }]);
  });

  it('a WSL path starts at the distro, never at wsl.localhost', () => {
    expect(crumbsOf(HOME)).toEqual([
      { label: 'Ubuntu', path: ROOT },
      { label: 'home', path: '\\\\wsl.localhost\\Ubuntu\\home' },
      { label: 'alex', path: HOME },
    ]);
    expect(crumbsOf(ROOT)).toEqual([{ label: 'Ubuntu', path: ROOT }]);
  });
});

describe('isDriveRoot and isRootPath', () => {
  it('matches C:, C:\\ and C:/ only', () => {
    expect(isDriveRoot('C:\\')).toBe(true);
    expect(isDriveRoot('c:/')).toBe(true);
    expect(isDriveRoot('C:')).toBe(true);
    expect(isDriveRoot('C:\\x')).toBe(false);
    expect(isDriveRoot(ROOT)).toBe(false);
  });

  it('a root path is a drive root or a distro root', () => {
    expect(isRootPath('C:\\')).toBe(true);
    expect(isRootPath(ROOT)).toBe(true);
    expect(isRootPath(HOME)).toBe(false);
  });
});

describe('WSL forms', () => {
  it('recognises wsl.localhost and wsl$ in either slash direction', () => {
    expect(isWslPath(HOME)).toBe(true);
    expect(isWslPath('//wsl$/Ubuntu/home')).toBe(true);
    expect(isWslPath('C:\\wsl.localhost\\x')).toBe(false);
    expect(wslRootOf('\\\\wsl$\\Debian\\etc')).toBe('\\\\wsl.localhost\\Debian\\');
    expect(wslRootOf('C:\\Users')).toBeNull();
  });

  it('translates to the Linux form and back', () => {
    expect(toLinuxForm(HOME)).toBe('Ubuntu:/home/alex');
    expect(toLinuxForm(ROOT)).toBe('Ubuntu:/');
    expect(toLinuxForm('C:\\Users')).toBeNull();
    expect(fromLinuxForm('Ubuntu:/home/alex')).toBe(HOME);
    expect(fromLinuxForm('Ubuntu:/')).toBe(ROOT);
    expect(fromLinuxForm(' Ubuntu:/home/alex/ ')).toBe(HOME);
  });

  it('a single letter before the colon is a drive, not a distro', () => {
    expect(fromLinuxForm('C:/Users')).toBeNull();
    expect(fromLinuxForm('Ubuntu')).toBeNull();
  });
});

describe('folderKey', () => {
  it('one key per folder, whatever spelling of it arrived', () => {
    // NTFS holds these as one folder, so they must key as one
    expect(folderKey('C:\\Users\\alex\\Downloads')).toBe('c:\\users\\alex\\downloads');
    expect(folderKey('c:\\users\\alex\\downloads')).toBe('c:\\users\\alex\\downloads');
    expect(folderKey('C:\\Users\\alex\\Downloads\\')).toBe('c:\\users\\alex\\downloads');
    expect(folderKey('C:/Users/alex/Downloads')).toBe('c:\\users\\alex\\downloads');
    expect(folderKey('  C:\\Users\\alex\\Downloads  ')).toBe('c:\\users\\alex\\downloads');
  });

  it('a drive root keeps its separator — there the separator is all there is', () => {
    expect(folderKey('E:\\')).toBe('e:\\');
    expect(folderKey('E:')).toBe('e:\\');
    expect(folderKey('e:/')).toBe('e:\\');
  });

  it('a place keys to nothing: Home and This PC are no folder', () => {
    expect(folderKey('')).toBe('');
    expect(folderKey('   ')).toBe('');
  });

  it('⚠️ leaves a WSL path cased: a Linux filesystem really holds /home/Alex and /home/alex apart', () => {
    expect(folderKey(HOME)).toBe(HOME);
    expect(folderKey(HOME + '\\')).toBe(HOME);
    expect(folderKey('\\\\wsl.localhost\\Ubuntu\\home\\Alex')).not.toBe(folderKey(HOME));
    expect(folderKey(ROOT)).toBe('\\\\wsl.localhost\\Ubuntu');
  });
});

describe('off Windows, a path is POSIX', () => {
  const LINUX = { os: 'linux', thisPcLabel: 'This Computer' };
  const MAC = { os: 'macos', thisPcLabel: 'This Mac' };

  it('walks up to / and stops there', () => {
    expect(parentOf('/Users/alex/x', MAC)).toBe('/Users/alex');
    expect(parentOf('/home/alex/', LINUX)).toBe('/home');
    expect(parentOf('/home', LINUX)).toBe('/');
    expect(parentOf('/', LINUX)).toBeNull();
  });

  it('crumbs start at / and keep forward slashes', () => {
    expect(crumbsOf('/home/alex', LINUX)).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'alex', path: '/home/alex' },
    ]);
    expect(crumbsOf('/', LINUX)).toEqual([{ label: '/', path: '/' }]);
  });

  it('/ is a root on every OS; a mount is not', () => {
    expect(isRootPath('/')).toBe(true);
    expect(isRootPath('/media/alex/USB')).toBe(false);
    expect(isDriveRoot('/')).toBe(false);
  });

  it('keys keep case and slashes, folding only a trailing /', () => {
    expect(folderKey('/home/Alex/', LINUX)).toBe('/home/Alex');
    expect(folderKey('/home/Alex', LINUX)).not.toBe(folderKey('/home/alex', LINUX));
    expect(folderKey('/', LINUX)).toBe('/');
    expect(folderKey('', LINUX)).toBe('');
    expect(folderKey('/a\\b', MAC)).toBe('/a\\b');
  });

  it('samePath is exact off Windows (macOS too) and case-blind on Windows', () => {
    expect(samePath('/home/Alex', '/home/alex', LINUX)).toBe(false);
    expect(samePath('/Users/Alex', '/Users/alex', MAC)).toBe(false);
    expect(samePath('/home/alex', '/home/alex', LINUX)).toBe(true);
    expect(samePath('C:\\Users\\alex', 'c:\\users\\alex')).toBe(true);
    expect(pathKey('/Data', LINUX)).toBe('/Data');
    expect(pathSep(LINUX)).toBe('/');
    expect(pathSep()).toBe('\\');
  });

  it('nameOf splits on / alone off Windows: a \\ is part of the name', () => {
    expect(nameOf('/tmp/a\\b.txt', LINUX)).toBe('a\\b.txt');
    expect(nameOf('/Users/alex/x\\y/', MAC)).toBe('x\\y');
    expect(nameOf('/', LINUX)).toBe('');
    expect(nameOf(HOME, LINUX)).toBe('alex');
  });

  it('a WSL path is still a WSL path whatever the platform says', () => {
    expect(parentOf(HOME, LINUX)).toBe('\\\\wsl.localhost\\Ubuntu\\home');
  });
});

/** Write a path with `/` and read it back with `\`: a backslash literal is hard to read twice. */
const win = (text: string) => text.replaceAll('/', String.fromCharCode(92));

describe('a network share as a root', () => {
  const SHARE = win('//nas/media');
  const LINUX = { os: 'linux', thisPcLabel: 'This Computer' } as const;

  it('is a root with or without a trailing separator, either slash direction', () => {
    expect(isRootPath(SHARE)).toBe(true);
    expect(isRootPath(win('//nas/media/'))).toBe(true);
    expect(isRootPath('//nas/media')).toBe(true);
    expect(isRootPath('//nas/media/')).toBe(true);
  });

  it('is not a root below the share, on a bare server, or off Windows', () => {
    expect(isRootPath(win('//nas/media/film'))).toBe(false);
    expect(isRootPath(win('//nas'))).toBe(false);
    expect(isRootPath(win('//nas/'))).toBe(false);
    expect(isRootPath('//nas/media', LINUX)).toBe(false);
  });

  it('keeps the WSL root a root', () => {
    expect(isRootPath(win('//wsl.localhost/Ubuntu'))).toBe(true);
    expect(isRootPath(HOME)).toBe(false);
  });

  it('stops parentOf at the share', () => {
    expect(parentOf(win('//nas/media/a/b'))).toBe(win('//nas/media/a'));
    expect(parentOf(win('//nas/media/a'))).toBe(SHARE);
    expect(parentOf(SHARE)).toBeNull();
    expect(parentOf(win('//nas/media/'))).toBeNull();
    expect(parentOf('//nas/media/a')).toBe(SHARE);
  });

  it('names the share root by its share', () => {
    expect(nameOf(SHARE)).toBe('media');
    expect(nameOf(win('//nas/media/film/a.mkv'))).toBe('a.mkv');
  });

  it('crumbs server, share, then the folders, each with its own path', () => {
    const crumbs = crumbsOf(win('//nas/media/a/b'));
    expect(crumbs.map((c) => c.label)).toEqual(['nas', 'media', 'a', 'b']);
    expect(crumbs.map((c) => c.path)).toEqual([
      SHARE,
      win('//nas/media/'),
      win('//nas/media/a'),
      win('//nas/media/a/b'),
    ]);
  });

  it('leaves POSIX and drive paths as they were', () => {
    expect(crumbsOf('//nas/media', LINUX).map((c) => c.label)).toEqual(['/', 'nas', 'media']);
    expect(parentOf('//nas/media/a', LINUX)).toBe('//nas/media');
    expect(crumbsOf(win('C:/a')).map((c) => c.label)).toEqual(['C:', 'a']);
  });
});
