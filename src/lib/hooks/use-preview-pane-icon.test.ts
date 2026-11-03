import { describe, expect, it } from 'vitest';
import {
  detailsIcon,
  isTrashPath,
  previewEntryIcon,
  previewPlaceIcon,
} from './use-preview-pane-icon';

const mac = { os: 'macos', thisPcLabel: 'This Mac' };
const linux = { os: 'linux', thisPcLabel: 'This Computer' };
const win = { os: 'windows', thisPcLabel: 'This PC' };
const dir = (name: string) => ({ name, isDir: true, iconKey: 'folder' });

describe('previewEntryIcon', () => {
  it('a Mac Foo.app is an app glyph, not the folder', () =>
    expect(previewEntryIcon(dir('Foo.app'), true, mac)).toBe('entry'));
  it('a plain folder stays the folder', () =>
    expect(previewEntryIcon(dir('Docs'), true, mac)).toBe('folder'));
  it('Foo.app off a Mac is just a folder', () =>
    expect(previewEntryIcon(dir('Foo.app'), true, linux)).toBe('folder'));
  it('a file goes through EntryIcon', () =>
    expect(previewEntryIcon({ name: 'a.txt', isDir: false, iconKey: 'ext/txt' }, true)).toBe(
      'entry',
    ));
  it('a selected ~/.Trash row gets the bin', () =>
    expect(previewEntryIcon({ ...dir('.Trash'), path: '/Users/alex/.Trash' }, true, mac)).toBe(
      'bin',
    ));
});

describe('previewPlaceIcon', () => {
  it('the Trash / Recycle Bin place gets the bin', () =>
    expect(previewPlaceIcon({ kind: 'recycle-bin' })).toBe('bin'));
  it('a tab on ~/.Trash gets the bin', () =>
    expect(previewPlaceIcon({ kind: 'path', path: '/Users/alex/.Trash' }, mac)).toBe('bin'));
  it('other places and folders get the folder', () => {
    expect(previewPlaceIcon({ kind: 'home' })).toBe('folder');
    expect(previewPlaceIcon({ kind: 'path', path: '/x' })).toBe('folder');
  });
});

describe('isTrashPath', () => {
  it('a Mac ~/.Trash and a volume .Trashes/<uid> are the Trash', () => {
    expect(isTrashPath('/Users/alex/.Trash', mac)).toBe(true);
    expect(isTrashPath('/Users/alex/.Trash/', mac)).toBe(true);
    expect(isTrashPath('/Volumes/USB/.Trashes/501', mac)).toBe(true);
    expect(isTrashPath('/Users/alex/.Trash/old', mac)).toBe(false);
    expect(isTrashPath('/Users/alex/Trash', mac)).toBe(false);
  });
  it('Linux freedesktop Trash folders', () => {
    expect(isTrashPath('/home/alex/.local/share/Trash', linux)).toBe(true);
    expect(isTrashPath('/home/alex/.local/share/Trash/files', linux)).toBe(true);
    expect(isTrashPath('/media/usb/.Trash-1000', linux)).toBe(true);
    expect(isTrashPath('/home/alex/.Trash', linux)).toBe(false);
  });
  it('Windows $Recycle.Bin and a user SID folder in it', () => {
    expect(isTrashPath('C:\\$Recycle.Bin', win)).toBe(true);
    expect(isTrashPath('D:\\$RECYCLE.BIN\\S-1-5-21-1-2-3-1001', win)).toBe(true);
    expect(isTrashPath('C:\\Users\\alex\\.Trash', win)).toBe(false);
  });
});

describe('detailsIcon (the (i) pane)', () => {
  const props = (name: string, path: string, isDir = true) => ({ name, path, isDir });
  it('a Mac Calculator.app draws the app glyph, not the folder (Mac, 16a32d4)', () =>
    expect(detailsIcon(props('Calculator.app', '/System/Applications/Calculator.app'), mac)).toBe(
      'entry',
    ));
  it('~/.Trash opened as a folder draws the bin', () =>
    expect(detailsIcon(props('.Trash', '/Users/alex/.Trash'), mac)).toBe('bin'));
  it('a plain folder, and Calculator.app off a Mac, stay the folder', () => {
    expect(detailsIcon(props('Docs', '/Users/alex/Docs'), mac)).toBe('folder');
    expect(detailsIcon(props('Calculator.app', '/opt/Calculator.app'), linux)).toBe('folder');
  });
  it('a file goes through EntryIcon', () =>
    expect(detailsIcon(props('a.txt', '/Users/alex/a.txt', false), mac)).toBe('entry'));
});
