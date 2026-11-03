// The only place the search commands and the "search:results" event appear. Mirrors
// src-tauri/src/commands/search.rs.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { SearchBatch, SearchQuery } from '$lib/types/search';

/**
 * Start a recursive search under `roots` (one folder, or every drive from a place); resolves
 * to its id. Cancel the previous one yourself.
 */
export const startSearch = (roots: string[], query: SearchQuery, includeHidden: boolean) =>
  invoke<number>('start_search', { roots, query, includeHidden });

export const cancelSearch = (searchId: number) => invoke<void>('cancel_search', { searchId });

/** Batches of hits for any running search. Returns the unlisten fn. */
export const onSearchResults = (cb: (batch: SearchBatch) => void) =>
  listen<SearchBatch>('search:results', (e) => cb(e.payload));
