import { describe, expect, it } from 'vitest';
import { iconUrl } from './icons';

describe('iconUrl', () => {
  it('an extension key is the path of the URL', () => {
    expect(iconUrl('ext/txt', 16)).toBe('http://icon.localhost/ext/txt?size=16');
    expect(iconUrl('ext/', 32)).toBe('http://icon.localhost/ext/?size=32');
  });

  it('a file key carries its path URL-encoded', () => {
    expect(iconUrl('file/C:\\Program Files\\app.exe', 32)).toBe(
      'http://icon.localhost/file/C%3A%5CProgram%20Files%5Capp.exe?size=32',
    );
  });

  it('an app key carries its app id URL-encoded, `!` and all', () => {
    // ⛔ an AUMID's `!` separates the package family from the application id, and a shell one
    // is a path with backslashes and braces (`{1AC14E77-…}\cmd.exe`). Unencoded, the `!` is
    // legal in a URL path but the backslash is not, and the icon silently 404s.
    expect(iconUrl('app/Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', 16)).toBe(
      'http://icon.localhost/app/Microsoft.WindowsCalculator_8wekyb3d8bbwe!App?size=16',
    );
    expect(iconUrl('app/{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\cmd.exe', 32)).toBe(
      'http://icon.localhost/app/%7B1AC14E77-02E7-4E5D-B744-2EB1AE5198B7%7D%5Ccmd.exe?size=32',
    );
  });

  it('folders have no shell icon URL', () => {
    expect(iconUrl('folder', 16)).toBe('');
  });
});
