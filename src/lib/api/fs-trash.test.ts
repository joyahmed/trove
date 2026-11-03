import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const { trashEntries, NoRecycleBin } = await import('./fs');

describe('trashEntries', () => {
  beforeEach(() => invoke.mockReset());

  it('turns the backend no-bin refusal into NoRecycleBin with its place', async () => {
    invoke.mockRejectedValueOnce({
      noBin: 'N:',
      message: 'N: has no Recycle Bin, so nothing was deleted: N:\\a',
    });
    const err = await trashEntries(['N:\\a']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoRecycleBin);
    expect((err as InstanceType<typeof NoRecycleBin>).place).toBe('N:');
    // a toast shows it as the backend's sentence, not "NoRecycleBin: …"
    expect(String(err)).toBe('N: has no Recycle Bin, so nothing was deleted: N:\\a');
  });

  it('carries why the bin refused: turned off or too big', async () => {
    invoke.mockRejectedValueOnce({ noBin: 'C:', reason: 'off', message: 'off' });
    const off = await trashEntries(['C:\\a']).catch((e: unknown) => e);
    expect((off as InstanceType<typeof NoRecycleBin>).reason).toBe('off');
    invoke.mockRejectedValueOnce({ noBin: 'C:', reason: 'tooBig', message: 'big' });
    const big = await trashEntries(['C:\\a']).catch((e: unknown) => e);
    expect((big as InstanceType<typeof NoRecycleBin>).reason).toBe('tooBig');
    invoke.mockRejectedValueOnce({ noBin: 'N:', message: 'none' });
    const none = await trashEntries(['N:\\a']).catch((e: unknown) => e);
    expect((none as InstanceType<typeof NoRecycleBin>).reason).toBe('noBin');
  });

  it('carries `denied`: macOS refused Trove the Trash', async () => {
    invoke.mockRejectedValueOnce({
      noBin: 'This Mac',
      reason: 'denied',
      paths: ['/u/a'],
      message: 'macOS did not let Trove use the Trash, so nothing more was moved: /u/a',
    });
    const err = (await trashEntries(['/u/a']).catch((e: unknown) => e)) as InstanceType<
      typeof NoRecycleBin
    >;
    expect(err).toBeInstanceOf(NoRecycleBin);
    expect(err.reason).toBe('denied');
    expect(err.paths).toEqual(['/u/a']);
  });

  it('passes every other failure through untouched', async () => {
    invoke.mockRejectedValueOnce('Access is denied');
    await expect(trashEntries(['C:\\a'])).rejects.toBe('Access is denied');
  });

  it('resolves when the bin took it', async () => {
    invoke.mockResolvedValueOnce(undefined);
    await expect(trashEntries(['C:\\a'])).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith('trash_entries', { paths: ['C:\\a'] });
  });
});
