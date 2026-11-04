// The terminal pane's reactivity: wires the emulator component to the PTY session — output
// through the sink, input through `write`, size through `resize` — and spawns the shell once
// the emulator reports its first size. Only this hook and the pane import `@wterm/*`.
import { TERMINAL_FOLLOW_NOTE } from '$lib/data/terminal-follow-note';
import type { TerminalHandle } from '@wterm/svelte';
import { terminal } from '$lib/state/terminal.svelte';
import { theme as appTheme } from '$lib/state/theme.svelte';
import { locationLabel, pathLocation } from '$lib/utils/location';

const DARK_THEME = 'solarized-dark';
const LIGHT_THEME = 'light';

export const useTerminalPane = () => {
  let handle = $state<TerminalHandle | null>(null);
  let ready = $state(false);
  // the app's theme as shown (Settings → Theme, System resolved), not the OS's on its own
  const theme = $derived(appTheme.dark ? DARK_THEME : LIGHT_THEME);
  const folderLabel = $derived(terminal.path ? locationLabel(pathLocation(terminal.path)) : 'Home');
  const status = $derived(
    terminal.error
      ? terminal.error
      : terminal.exited
        ? `Exited${terminal.exitCode === null ? '' : ` (${terminal.exitCode})`}`
        : '',
  );

  // The emulator is the sink for the shell's output while this pane is mounted.
  $effect(() => {
    const h = handle;
    if (!h) return;
    terminal.setSink((chunk) => h.write(chunk));
    return () => terminal.setSink(null);
  });

  const onReady = () => {
    ready = true;
    handle?.focus();
    if (terminal.sessionId === null) void terminal.spawn();
  };
  const onResize = (cols: number, rows: number) => {
    if (!ready) return;
    terminal.resize(cols, rows);
  };
  const onData = (data: string) => terminal.write(data);
  const onError = (e: unknown) => {
    terminal.error = String(e);
  };
  const restart = () => void terminal.spawn();
  const close = () => terminal.close();

  return {
    get handle() {
      return handle;
    },
    set handle(h: TerminalHandle | null) {
      handle = h;
    },
    get theme() {
      return theme;
    },
    get folderLabel() {
      return folderLabel;
    },
    get path() {
      return terminal.path;
    },
    get status() {
      return status;
    },
    get exited() {
      return terminal.exited;
    },
    get follow() {
      return terminal.follow;
    },
    followNote: TERMINAL_FOLLOW_NOTE,
    set follow(v: boolean) {
      terminal.follow = v;
    },
    onReady,
    onResize,
    onData,
    onError,
    restart,
    close,
  };
};
