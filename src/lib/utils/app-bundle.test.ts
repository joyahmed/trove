import { describe, expect, it } from 'vitest';
import { dropPathOf, isAppBundle, opensAsFolder, shownName } from './app-bundle';
import { fileIconKind } from './file-icon';
import { shortKindOf } from './short-kind';

const mac = { os: 'macos', thisPcLabel: 'This Mac' };
const linux = { os: 'linux', thisPcLabel: 'This Computer' };
const windows = { os: 'windows', thisPcLabel: 'This PC' };
const dir = (name: string) => ({ name, isDir: true });

describe('isAppBundle', () => {
  it('a folder ending in .app on a Mac is an app', () => {
    expect(isAppBundle(dir('Safari.app'), mac)).toBe(true);
    expect(isAppBundle(dir('Old Tool.APP'), mac)).toBe(true);
  });
  it('is just a folder on Windows and Linux', () => {
    expect(isAppBundle(dir('Safari.app'), windows)).toBe(false);
    expect(isAppBundle(dir('Safari.app'), linux)).toBe(false);
  });
  it('nothing injected (tests, a browser) is Windows: a folder', () =>
    expect(isAppBundle(dir('Safari.app'))).toBe(false));
  it('a FILE named x.app is not a bundle', () =>
    expect(isAppBundle({ name: 'x.app', isDir: false }, mac)).toBe(false));
  it('needs a name before .app and the dot', () => {
    expect(isAppBundle(dir('.app'), mac)).toBe(false);
    expect(isAppBundle(dir('webapp'), mac)).toBe(false);
    expect(isAppBundle(dir('Safari.app.backup'), mac)).toBe(false);
  });
});

describe('opensAsFolder / dropPathOf: an app is not a folder to go into or drop into', () => {
  const app = { name: 'Safari.app', isDir: true, path: '/Applications/Safari.app' };
  const folder = { name: 'Docs', isDir: true, path: '/Users/alex/Docs' };
  const file = { name: 'a.txt', isDir: false, path: '/Users/alex/a.txt' };
  it('on a Mac the app is neither', () => {
    expect(opensAsFolder(app, mac)).toBe(false);
    expect(dropPathOf(app, mac)).toBeUndefined();
  });
  it('a folder is both, on every OS', () => {
    for (const p of [mac, linux, windows]) {
      expect(opensAsFolder(folder, p)).toBe(true);
      expect(dropPathOf(folder, p)).toBe(folder.path);
    }
  });
  it('Windows and Linux: a folder named x.app stays a drop target', () => {
    expect(dropPathOf(app, windows)).toBe(app.path);
    expect(dropPathOf(app, linux)).toBe(app.path);
  });
  it('a file is never a drop target', () => expect(dropPathOf(file, mac)).toBeUndefined());
});

describe('an app bundle reads "App" with its own icon, only on a Mac', () => {
  const app = { name: 'Safari.app', isDir: true, ext: null, iconKey: 'folder' };
  it('kind', () => {
    expect(shortKindOf(app, mac)).toBe('App');
    expect(shortKindOf(app, linux)).toBe('Folder');
    expect(shortKindOf(app, windows)).toBe('Folder');
  });
  it('icon: its own icon from QuickLook (glyph until then), not the folder', () => {
    expect(fileIconKind(app, true, mac)).toBe('thumb');
    expect(fileIconKind(app, true, linux)).toBe('folder');
  });
});

describe('shownName', () => {
  it('a Mac hides .app on a bundle, like Finder', () => {
    expect(shownName(dir('Safari.app'), mac)).toBe('Safari');
    expect(shownName(dir('Old Tool.APP'), mac)).toBe('Old Tool');
  });
  it('Windows and Linux show the name unchanged', () => {
    expect(shownName(dir('Safari.app'), linux)).toBe('Safari.app');
    expect(shownName(dir('Safari.app'), windows)).toBe('Safari.app');
  });
  it('a plain file named like an app is unchanged', () => {
    expect(shownName({ name: 'notes.app.txt', isDir: false }, mac)).toBe('notes.app.txt');
    expect(shownName({ name: 'x.app', isDir: false }, mac)).toBe('x.app');
  });
});
