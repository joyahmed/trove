import { describe, expect, it } from 'vitest';
import {
  argsPlaceholder,
  expandArgs,
  isWslOnly,
  labelPlaceholder,
  linuxPathOf,
  placeholdersFor,
  seedCommandsFor,
  splitArgs,
  splitByPlatform,
} from './custom-commands';

describe('customize help per platform', () => {
  it('Windows keeps the full legend and the WSL examples', () => {
    const legend = placeholdersFor(true);
    expect(legend.map((p) => p.token)).toEqual([
      '%path%',
      '%paths%',
      '%parent%',
      '%name%',
      '%linuxpath%',
      '%distro%',
    ]);
    expect(legend[0].means).toContain('Windows form');
    expect(labelPlaceholder(true)).toBe('Open with Code (WSL)');
    expect(argsPlaceholder(true)).toBe('--remote wsl+%distro% %linuxpath%');
  });

  it('off Windows: no WSL tokens, no "Windows form", no WSL examples', () => {
    const legend = placeholdersFor(false);
    expect(legend.map((p) => p.token)).toEqual(['%path%', '%paths%', '%parent%', '%name%']);
    expect(JSON.stringify(legend)).not.toMatch(/Windows|WSL/);
    expect(labelPlaceholder(false)).toBe('Open with Code');
    expect(argsPlaceholder(false)).not.toMatch(/wsl|%distro%|%linuxpath%/);
  });

  it('the hidden tokens still expand when typed', () => {
    expect(expandArgs('%linuxpath%', { path: '/home/a', paths: ['/home/a'] })).toEqual(['/home/a']);
  });
});

describe('expandArgs', () => {
  it('quotes a path with spaces and leaves plain flags alone', () => {
    const args = expandArgs('--open %path% --new', {
      path: 'C:\\a b\\c.txt',
      paths: ['C:\\a b\\c.txt'],
    });
    expect(args).toEqual(['--open', 'C:\\a b\\c.txt', '--new']);
  });

  it('%paths% lists every selected item, %parent% and %name% split the target', () => {
    const args = expandArgs('%paths% -p %parent% -n %name%', {
      path: 'C:\\dir\\one.txt',
      paths: ['C:\\dir\\one.txt', 'C:\\dir\\two two.txt'],
    });
    expect(args).toEqual([
      'C:\\dir\\one.txt',
      'C:\\dir\\two two.txt',
      '-p',
      'C:\\dir',
      '-n',
      'one.txt',
    ]);
  });

  it('a WSL path gives the distro and the Linux path', () => {
    const args = expandArgs('--remote wsl+%distro% %linuxpath%', {
      path: '\\\\wsl.localhost\\Ubuntu\\home\\alex\\proj',
      paths: ['\\\\wsl.localhost\\Ubuntu\\home\\alex\\proj'],
    });
    expect(args).toEqual(['--remote', 'wsl+Ubuntu', '/home/alex/proj']);
  });

  it('a Windows path gives an empty distro and forward slashes', () => {
    expect(expandArgs('[%distro%] %linuxpath%', { path: 'C:\\x\\y', paths: ['C:\\x\\y'] })).toEqual(
      ['[]', 'C:/x/y'],
    );
    expect(linuxPathOf('\\\\wsl.localhost\\Ubuntu\\')).toBe('/');
  });

  it('an unknown placeholder is left as typed', () => {
    expect(expandArgs('%nope% %name%', { path: 'C:\\f.txt', paths: ['C:\\f.txt'] })).toEqual([
      '%nope%',
      'f.txt',
    ]);
  });
});

describe('splitArgs', () => {
  it('groups double quotes and honours an escaped quote', () => {
    expect(splitArgs('a "b c" d')).toEqual(['a', 'b c', 'd']);
    expect(splitArgs('say \\"hi\\" there')).toEqual(['say', '"hi"', 'there']);
    expect(splitArgs('   ')).toEqual([]);
  });
});

describe('splitArgs quoting', () => {
  it.each([true, false])('single quotes group (windows: %s)', (win) => {
    expect(splitArgs("a 'b c' d", win)).toEqual(['a', 'b c', 'd']);
    expect(splitArgs("--msg 'it's fine'", win)).toEqual(['--msg', "it's fine"]);
  });

  it.each([true, false])('double quotes group (windows: %s)', (win) => {
    expect(splitArgs('a "b c" d', win)).toEqual(['a', 'b c', 'd']);
  });

  it.each([true, false])('an apostrophe in a word is just a character (windows: %s)', (win) => {
    expect(splitArgs("it's don't", win)).toEqual(["it's", "don't"]);
    expect(splitArgs("'unclosed one", win)).toEqual(["'unclosed", 'one']);
    expect(splitArgs('"it\'s here"', win)).toEqual(["it's here"]);
  });

  it.each([true, false])('an empty field is no arguments (windows: %s)', (win) => {
    expect(splitArgs('', win)).toEqual([]);
    expect(splitArgs('   ', win)).toEqual([]);
    expect(splitArgs('a "" b', win)).toEqual(['a', '', 'b']);
    expect(splitArgs("a '' b", win)).toEqual(['a', '', 'b']);
  });

  it('on Windows backslashes follow CommandLineToArgvW', () => {
    expect(splitArgs('C:\\Users\\alex\\a.txt', true)).toEqual(['C:\\Users\\alex\\a.txt']);
    expect(splitArgs('"C:\\My Dir\\x" y', true)).toEqual(['C:\\My Dir\\x', 'y']);
    // 2 backslashes then a quote: one backslash, and the quote closes the group
    expect(splitArgs('"C:\\My Dir\\\\" y', true)).toEqual(['C:\\My Dir\\', 'y']);
    // 3 backslashes then a quote: one backslash and a literal quote
    expect(splitArgs('a\\\\\\"b', true)).toEqual(['a\\"b']);
  });

  it('off Windows only \\" is special; other backslashes stay', () => {
    expect(splitArgs('say \\"hi\\" a\\b', false)).toEqual(['say', '"hi"', 'a\\b']);
  });
});

describe('expandArgs round-trips a path through the quoting', () => {
  it('a Windows path with spaces and a trailing backslash is one argument', () => {
    const path = 'C:\\Program Files\\';
    expect(expandArgs('--open %path% --new', { path, paths: [path] }, true)).toEqual([
      '--open',
      path,
      '--new',
    ]);
  });

  it('a path with a double quote or a leading apostrophe survives', () => {
    for (const windows of [true, false]) {
      for (const path of ['/tmp/a "b" c', "'odd name", "/tmp/o'brien x"]) {
        expect(expandArgs('%path%', { path, paths: [path] }, windows)).toEqual([path]);
      }
    }
  });
});

describe('seeding and listing per platform', () => {
  const wslCmd = { id: 'w', label: 'W', program: 'code', args: '', scope: ['wsl'] as const };
  const mixed = { id: 'm', label: 'M', program: 'zed', args: '', scope: ['file', 'wsl'] as const };
  const plain = { id: 'p', label: 'P', program: 'vlc', args: '', scope: ['file'] as const };

  it('Windows seeds the Code-over-WSL command', () => {
    expect(seedCommandsFor(true).map((c) => c.id)).toEqual(['code-wsl']);
  });

  it('Mac and Linux seed no WSL-scoped command', () => {
    expect(seedCommandsFor(false)).toEqual([]);
  });

  it('Windows lists everything and hides nothing', () => {
    const r = splitByPlatform([wslCmd, mixed, plain], true);
    expect(r.visible).toHaveLength(3);
    expect(r.hidden).toBe(0);
  });

  it('off Windows only the wsl-only commands are hidden, and counted', () => {
    const r = splitByPlatform([wslCmd, mixed, plain], false);
    expect(r.visible.map((c) => c.id)).toEqual(['m', 'p']);
    expect(r.hidden).toBe(1);
  });

  it('a command with an empty scope is not wsl-only', () => {
    expect(isWslOnly({ scope: [] })).toBe(false);
  });
});
