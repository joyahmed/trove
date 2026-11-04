import { describe, expect, it } from 'vitest';
import {
  paneShellFor,
  pastePathsText,
  quoteCmd,
  quotePosix,
  quotePowerShell,
  type PaneShell,
} from './shell-quote';

const posix: PaneShell = { kind: 'posix', wslDistro: null };
const ps: PaneShell = { kind: 'powershell', wslDistro: null };
const cmd: PaneShell = { kind: 'cmd', wslDistro: null };
const wsl: PaneShell = { kind: 'posix', wslDistro: 'Ubuntu' };

const hard = ['it\'s $HOME `x` "q" \\ ünï 日本.txt', 'plain', 'two  spaces'];

describe('quoting per shell', () => {
  it("POSIX: single quotes, a quote becomes the four characters '\\''", () => {
    expect(quotePosix('a b')).toBe("'a b'");
    expect(quotePosix("it's")).toBe("'it'\\''s'");
    expect(quotePosix('$HOME `x` "q" \\ ünï 日本')).toBe('\'$HOME `x` "q" \\ ünï 日本\'');
  });
  it('PowerShell: single quotes, a quote is doubled, $ stays literal', () => {
    expect(quotePowerShell("it's $x")).toBe("'it''s $x'");
    expect(quotePowerShell('C:\\My Docs\\ü.txt')).toBe("'C:\\My Docs\\ü.txt'");
  });
  it('cmd: double quotes', () => {
    expect(quoteCmd('C:\\My Docs\\a b.txt')).toBe('"C:\\My Docs\\a b.txt"');
  });
});

describe('pastePathsText', () => {
  it('joins with single spaces and no trailing newline, per shell', () => {
    const paths = ['/h/my file.txt', "/h/it's.txt"];
    expect(pastePathsText(paths, posix).text).toBe("'/h/my file.txt' '/h/it'\\''s.txt'");
    expect(pastePathsText(paths, ps).text).toBe("'/h/my file.txt' '/h/it''s.txt'");
    expect(pastePathsText(['C:\\a b', 'C:\\c'], cmd).text).toBe('"C:\\a b" "C:\\c"');
    for (const s of [posix, ps, cmd]) expect(pastePathsText(paths, s).text).not.toMatch(/[\r\n]$/);
  });
  it('keeps $, backticks and unicode intact inside the quotes', () => {
    expect(pastePathsText(hard, posix).text).toBe(
      "'it'\\''s $HOME `x` \"q\" \\ ünï 日本.txt' 'plain' 'two  spaces'",
    );
  });
  it('sends nothing for an empty selection', () => {
    expect(pastePathsText([], posix)).toEqual({ text: '', skipped: 0 });
  });
  it('WSL shell gets Linux paths: its own share, and drives under /mnt', () => {
    const r = pastePathsText(
      [
        '\\\\wsl.localhost\\Ubuntu\\home\\a\\my file',
        'C:\\Users\\a b',
        '\\\\wsl.localhost\\Ubuntu\\',
      ],
      wsl,
    );
    expect(r).toEqual({ text: "'/home/a/my file' '/mnt/c/Users/a b' '/'", skipped: 0 });
  });
  it('WSL shell skips another distro and counts it', () => {
    const r = pastePathsText(
      ['\\\\wsl.localhost\\Debian\\etc', '\\\\wsl.localhost\\ubuntu\\x'],
      wsl,
    );
    expect(r).toEqual({ text: "'/x'", skipped: 1 });
  });
  it('a PowerShell pane keeps WSL share paths as they are', () => {
    expect(pastePathsText(['\\\\wsl.localhost\\Ubuntu\\x y'], ps).text).toBe(
      "'\\\\wsl.localhost\\Ubuntu\\x y'",
    );
  });
});

describe('paneShellFor', () => {
  it('off Windows it is POSIX whatever the folder', () => {
    expect(paneShellFor('/home/a', false)).toEqual(posix);
  });
  it('on Windows: PowerShell, or the distro when the folder is a WSL share', () => {
    expect(paneShellFor('C:\\x', true)).toEqual(ps);
    expect(paneShellFor('\\\\wsl.localhost\\Ubuntu\\home', true)).toEqual(wsl);
  });
});
