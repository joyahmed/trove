// The only place `invoke` appears for the theme domain. Mirrors src-tauri/src/commands/theme.rs.
import { invoke } from '@tauri-apps/api/core';
import type { SystemTheme } from '$lib/types/theme';

export const systemTheme = () => invoke<SystemTheme>('system_theme');
