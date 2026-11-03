// The only place the launch command and the "launch" event appear. Mirrors
// src-tauri/src/commands/launch.rs and LAUNCH_EVENT in lib.rs.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Launch } from '$lib/types/launch';

export const initialLaunch = () => invoke<Launch>('initial_launch');

/** A second process started with arguments and handed them to us. Returns the unlisten fn. */
export const onLaunch = (cb: (launch: Launch) => void) =>
  listen<Launch>('launch', (e) => cb(e.payload));
