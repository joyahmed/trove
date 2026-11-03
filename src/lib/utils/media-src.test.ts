import { describe, expect, it } from 'vitest';
import { loadMediaBlob, needsBlobMedia } from '$lib/utils/media-src';

const on = (os: string) => ({ os, thisPcLabel: 'x' });

describe('needsBlobMedia', () => {
  it('is Linux only: WebKitGTK cannot play a custom scheme', () => {
    expect(needsBlobMedia(on('linux'))).toBe(true);
    expect(needsBlobMedia(on('windows'))).toBe(false);
    expect(needsBlobMedia(on('macos'))).toBe(false);
    expect(needsBlobMedia(undefined)).toBe(false);
  });
});

describe('loadMediaBlob', () => {
  const toUrl = (b: Blob) => `blob:${b.type}:${b.size}`;

  it('turns the whole answer into a blob URL that keeps its type', async () => {
    const load = async () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/mpeg' } });
    expect(await loadMediaBlob('preview://localhost/file/a.mp3', load, toUrl)).toBe(
      'blob:audio/mpeg:3',
    );
  });

  it('is null when the protocol refuses the file (too large, or gone)', async () => {
    for (const status of [413, 404]) {
      const load = async () => new Response(null, { status });
      expect(await loadMediaBlob('preview://localhost/file/a.mp4', load, toUrl)).toBeNull();
    }
  });
});
