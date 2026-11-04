import { describe, expect, it } from 'vitest';
import {
  isRemoteShare,
  isUnreachableError,
  isWslHost,
  serverOf,
  signInCodeOf,
  shareParts,
  shareRootOf,
  unreachablePlaceOf,
} from './network';

describe('shareRootOf', () => {
  it('names the share of a UNC path, without a trailing separator', () => {
    expect(shareRootOf('\\\\nas\\media\\film\\a.mkv')).toBe('\\\\nas\\media');
    expect(shareRootOf('\\\\nas\\media')).toBe('\\\\nas\\media');
    expect(shareRootOf('\\\\nas\\media\\')).toBe('\\\\nas\\media');
  });

  it('reads the slash spelling and keeps the case as typed', () => {
    expect(shareRootOf('//NAS/Media/x')).toBe('\\\\NAS\\Media');
  });

  it('reads the long \\\\?\\UNC\\ spelling', () => {
    expect(shareRootOf('\\\\?\\UNC\\nas\\media\\x')).toBe('\\\\nas\\media');
  });

  it('is null for a bare server, a device path, a drive or a POSIX path', () => {
    expect(shareRootOf('\\\\nas')).toBeNull();
    expect(shareRootOf('\\\\nas\\')).toBeNull();
    expect(shareRootOf('\\\\.\\pipe\\x')).toBeNull();
    expect(shareRootOf('\\\\?\\C:\\x')).toBeNull();
    expect(shareRootOf('C:\\x')).toBeNull();
    expect(shareRootOf('/home/alex')).toBeNull();
    expect(shareRootOf('')).toBeNull();
  });

  it('still names a WSL share textually; callers decide', () => {
    expect(shareRootOf('\\\\wsl.localhost\\Ubuntu\\home')).toBe('\\\\wsl.localhost\\Ubuntu');
  });
});

describe('shareParts', () => {
  it('splits server, share and the rest', () => {
    expect(shareParts('\\\\nas\\media\\a\\b')).toEqual({
      server: 'nas',
      share: 'media',
      rest: ['a', 'b'],
    });
    expect(shareParts('\\\\nas\\media')?.rest).toEqual([]);
  });
});

describe('remote versus WSL', () => {
  it('knows a WSL host in either spelling and any case', () => {
    expect(isWslHost('wsl.localhost')).toBe(true);
    expect(isWslHost('WSL$')).toBe(true);
    expect(isWslHost('nas')).toBe(false);
  });

  it('calls a share remote unless it is WSL', () => {
    expect(isRemoteShare('\\\\nas\\media\\a')).toBe(true);
    expect(isRemoteShare('\\\\wsl.localhost\\Ubuntu\\home')).toBe(false);
    expect(isRemoteShare('\\\\wsl$\\Ubuntu')).toBe(false);
    expect(isRemoteShare('C:\\x')).toBe(false);
  });

  it('gives the server', () => {
    expect(serverOf('\\\\nas\\media\\a')).toBe('nas');
    expect(serverOf('C:\\')).toBeNull();
  });
});

describe('unreachable errors', () => {
  it('matches the Rust deadline error', () => {
    expect(isUnreachableError('\\\\nas\\media did not answer in 10 s')).toBe(true);
    expect(isUnreachableError('Z:\\ did not answer in 10 s')).toBe(true);
    expect(isUnreachableError('Access is denied.')).toBe(false);
    expect(isUnreachableError('')).toBe(false);
  });

  it('pulls the place out', () => {
    expect(unreachablePlaceOf('\\\\nas\\media did not answer in 10 s')).toBe('\\\\nas\\media');
    expect(unreachablePlaceOf('Z:\\ did not answer in 10 s')).toBe('Z:\\');
    expect(unreachablePlaceOf('Access is denied.')).toBeNull();
    expect(unreachablePlaceOf('did not answer in 10 s')).toBeNull();
  });
});

describe('signInCodeOf', () => {
  it('finds access denied and a logon failure in the words Rust gives', () => {
    expect(signInCodeOf('X: Access is denied. (os error 5)')).toBe(5);
    expect(signInCodeOf('X: The user name or password is incorrect. (os error 1326)')).toBe(1326);
  });
  it('is null for any other error', () => {
    expect(signInCodeOf('X: not found (os error 53)')).toBeNull();
    expect(signInCodeOf('X: (os error 55)')).toBeNull();
    expect(signInCodeOf('X did not answer in 10 s')).toBeNull();
  });
});
