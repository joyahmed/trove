// The only place `invoke` appears for the set-as-default domain. Mirrors
// src-tauri/src/commands/default_handler.rs.
import { invoke } from '@tauri-apps/api/core';
import type { HandlerInfo, HandlerStatus } from '$lib/types/default-handler';

export const defaultHandlerStatus = () => invoke<HandlerStatus>('default_handler_status');
export const defaultHandlerInfo = () => invoke<HandlerInfo>('default_handler_info');
export const defaultHandlerApply = () => invoke<void>('default_handler_apply');
export const defaultHandlerRevert = () => invoke<void>('default_handler_revert');
