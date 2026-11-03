// The only place `invoke` appears for the WSL domain. Mirrors src-tauri/src/commands/wsl.rs.
import { invoke } from '@tauri-apps/api/core';
import type { WslDistro } from '$lib/types/wsl';

/** Installed distros from the registry — no process is started. */
export const wslDistros = () => invoke<WslDistro[]>('wsl_distros');

/** The distro's entry point (`\\wsl.localhost\<name>\home\<user>`). Starts the distro if stopped. */
export const wslHome = (name: string, uid: number) => invoke<string>('wsl_home', { name, uid });

/** The distros running right now; never starts one. A This PC search covers these. */
export const wslRunningDistros = () => invoke<string[]>('wsl_running_distros');
