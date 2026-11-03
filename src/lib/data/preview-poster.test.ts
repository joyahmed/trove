import { describe, expect, it } from 'vitest';
import { wantsDetailsThumb, wantsPosterThumb } from './preview-poster';

const f = (name: string) => ({ name, isDir: false });

describe('wantsPosterThumb', () => {
  it('a Mac video gets the thumbnail as its poster', () => {
    expect(wantsPosterThumb(f('a.mov'), 'video', true)).toBe(true);
    expect(wantsPosterThumb(f('a.mp4'), 'video', true)).toBe(true);
  });
  it('m4v (no preview kind) still gets the large thumbnail on a Mac', () => {
    expect(wantsPosterThumb(f('a.m4v'), 'none', true)).toBe(true);
  });
  it("off a Mac a video keeps today's plain player (QuickLook is Mac-only)", () => {
    expect(wantsPosterThumb(f('a.mov'), 'video', false)).toBe(false);
    expect(wantsPosterThumb(f('a.m4v'), 'none', false)).toBe(false);
  });
  it('images, audio, pdf, text and folders never ask', () => {
    expect(wantsPosterThumb(f('a.png'), 'image', true)).toBe(false);
    expect(wantsPosterThumb(f('a.m4a'), 'audio', true)).toBe(false);
    expect(wantsPosterThumb(f('a.pdf'), 'pdf', true)).toBe(false);
    expect(wantsPosterThumb({ name: 'x.mov', isDir: true }, 'none', true)).toBe(false);
  });
  it('a video QuickLook cannot thumbnail (webm) has no poster', () => {
    expect(wantsPosterThumb(f('a.webm'), 'video', true)).toBe(false);
  });
});

describe('wantsDetailsThumb', () => {
  it('a Mac video gets the large thumbnail, like an image', () => {
    for (const n of ['clip.mov', 'clip.mp4', 'clip.m4v', 'a.png', 'a.jpg', 'a.heic', 'a.tiff']) {
      expect(wantsDetailsThumb(f(n), true, true)).toBe(true);
    }
  });
  it('off a Mac (Linux) a decoded image is large, a video keeps its icon', () => {
    expect(wantsDetailsThumb(f('a.png'), true, false)).toBe(true);
    expect(wantsDetailsThumb(f('a.mov'), true, false)).toBe(false);
  });
  it('Windows (shell icons, no decoded thumbnail) keeps the icon', () => {
    expect(wantsDetailsThumb(f('a.png'), false, false)).toBe(false);
    expect(wantsDetailsThumb(f('a.mov'), false, true)).toBe(false);
  });
  it('folders, app bundles and other files keep their icon', () => {
    expect(wantsDetailsThumb({ name: 'pics', isDir: true }, true, true)).toBe(false);
    expect(wantsDetailsThumb({ name: 'Calculator.app', isDir: true }, true, true)).toBe(false);
    expect(wantsDetailsThumb(f('notes.txt'), true, true)).toBe(false);
    expect(wantsDetailsThumb(f('a.webm'), true, true)).toBe(false);
    expect(wantsDetailsThumb(f('README'), true, true)).toBe(false);
  });
});

describe('a file inside an archive', () => {
  // its path holds a NUL: Rust has no file to thumbnail, so neither pane asks
  const inZip = { name: 'clip.mp4', isDir: false, path: 'C:\\x\\a.zip\u0000clip.mp4' };
  it('asks for no poster or Details thumbnail', () => {
    expect(wantsPosterThumb(inZip, 'video', true)).toBe(false);
    expect(wantsDetailsThumb(inZip, true, true)).toBe(false);
    expect(wantsPosterThumb({ ...inZip, path: 'C:\\x\\clip.mp4' }, 'video', true)).toBe(true);
  });
});

describe('wantsPosterThumb for HEIC on Windows (G.57)', () => {
  it('asks the shell thumbnail when the pane has no renderer', () => {
    for (const n of ['a.heic', 'a.HEIF', 'a.tif', 'a.tiff', 'a.avif']) {
      expect(wantsPosterThumb(f(n), 'none', false, false), n).toBe(true);
    }
    expect(wantsPosterThumb(f('a.xyz'), 'none', false, false)).toBe(false);
    expect(wantsPosterThumb(f('a.heic'), 'none', false, true)).toBe(false);
  });
});
