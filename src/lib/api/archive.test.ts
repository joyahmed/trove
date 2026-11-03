import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { archiveConflicts, startCompress, startExtract, startExtractHere } from './archive';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => 7) }));

describe('archive api', () => {
  beforeEach(() => vi.mocked(invoke).mockClear());

  it('archiveConflicts sends the archive, destination and entries (null = all)', async () => {
    await archiveConflicts('C:\\a.zip', 'C:\\out');
    expect(invoke).toHaveBeenCalledWith('archive_conflicts', {
      archive: 'C:\\a.zip',
      destination: 'C:\\out',
      entries: null,
    });
    await archiveConflicts('C:\\a.zip', 'C:\\out', ['x.txt']);
    expect(invoke).toHaveBeenLastCalledWith('archive_conflicts', {
      archive: 'C:\\a.zip',
      destination: 'C:\\out',
      entries: ['x.txt'],
    });
  });

  it('startExtract passes the answer and returns the job id', async () => {
    expect(await startExtract('/a.zip', '/out', null, 'keep-both')).toBe(7);
    expect(invoke).toHaveBeenCalledWith('start_extract', {
      archive: '/a.zip',
      destination: '/out',
      entries: null,
      resolution: 'keep-both',
    });
  });

  it('startExtractHere and startCompress name their commands', async () => {
    await startExtractHere('/a.zip');
    expect(invoke).toHaveBeenCalledWith('start_extract_here', { archive: '/a.zip' });
    await startCompress(['/x', '/y'], 'zip');
    expect(invoke).toHaveBeenLastCalledWith('start_compress', {
      sources: ['/x', '/y'],
      format: 'zip',
    });
  });
});
