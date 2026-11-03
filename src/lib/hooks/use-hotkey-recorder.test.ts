// Esc while a chord is being recorded stops the recording and nothing else: the Settings
// dialog's own window listener must not see it (MAC-A.8.9).
import { describe, expect, it, vi } from 'vitest';
import { useHotkeyRecorder } from './use-hotkey-recorder.svelte';
import { isHotkeyRecording } from '$lib/utils/hotkeys';

// The Rust side (A.8.9): a flag for the window-menu guard, and chords the page never saw.
const native = vi.hoisted(() => ({
  flags: [] as boolean[],
  deliver: null as ((chord: string) => void) | null,
  unlistened: 0,
}));
vi.mock('$lib/api/palette', () => ({
  setHotkeyRecordingNative: (on: boolean) => {
    native.flags.push(on);
    return Promise.resolve();
  },
  onRecordedChord: (cb: (chord: string) => void) => {
    native.deliver = cb;
    return Promise.resolve(() => {
      native.unlistened += 1;
      native.deliver = null;
    });
  },
}));

const esc = () => {
  const e = new Event('keydown', { cancelable: true }) as Event & { key: string };
  e.key = 'Escape';
  return e;
};

// A tiny window: listeners run in order, and stopImmediatePropagation ends the walk.
const fire = (listeners: Array<(e: never) => void>, e: Event) => {
  let stopped = false;
  e.stopImmediatePropagation = () => {
    stopped = true;
  };
  for (const l of listeners) {
    if (stopped) break;
    l(e as never);
  }
};

describe('hotkey recorder Escape', () => {
  it('keeps the dialog open and the chord unchanged while recording', () => {
    const onchange = vi.fn();
    const dialogEsc = vi.fn();
    const rec = useHotkeyRecorder(onchange);
    rec.toggle();
    expect(rec.recording).toBe(true);
    fire([rec.onkeydown, dialogEsc], esc());
    expect(rec.recording).toBe(false);
    expect(onchange).not.toHaveBeenCalled();
    expect(dialogEsc).not.toHaveBeenCalled();
  });

  it('lets Escape through when not recording, so the dialog closes', () => {
    const dialogEsc = vi.fn();
    const rec = useHotkeyRecorder(vi.fn());
    fire([rec.onkeydown, dialogEsc], esc());
    expect(dialogEsc).toHaveBeenCalledOnce();
  });
});

describe('hotkey recording flag', () => {
  it('is set while recording and cleared after the Escape has finished', () => {
    vi.useFakeTimers();
    const rec = useHotkeyRecorder(vi.fn());
    rec.toggle();
    expect(isHotkeyRecording()).toBe(true);
    rec.onkeydown(esc() as never);
    expect(isHotkeyRecording()).toBe(true); // still set for the dialog's listener
    vi.runAllTimers();
    expect(isHotkeyRecording()).toBe(false);
    vi.useRealTimers();
  });
});

describe('a chord the page never sees (Windows Alt+Space, A.8.9)', () => {
  it('is recorded when Rust hands it over while recording', async () => {
    native.flags = [];
    const onchange = vi.fn();
    const rec = useHotkeyRecorder(onchange);
    rec.toggle();
    expect(native.flags).toEqual([true]);
    const deliver = native.deliver;
    expect(deliver).not.toBeNull();
    deliver?.('alt+space');
    expect(onchange).toHaveBeenCalledExactlyOnceWith('alt+space');
    expect(rec.recording).toBe(false);
    expect(native.flags).toEqual([true, false]);
    await Promise.resolve();
    await Promise.resolve();
    expect(native.deliver).toBeNull(); // the listener is dropped with the recording
  });

  it('is ignored once the keydown already recorded the same press', () => {
    const onchange = vi.fn();
    const rec = useHotkeyRecorder(onchange);
    rec.toggle();
    const deliver = native.deliver;
    const e = Object.assign(new Event('keydown', { cancelable: true }), {
      code: 'Space',
      key: ' ',
      altKey: true,
      ctrlKey: false,
      shiftKey: false,
      metaKey: false,
    });
    rec.onkeydown(e as never);
    expect(onchange).toHaveBeenCalledExactlyOnceWith('alt+space'); // by the keydown
    deliver?.('alt+space');
    expect(onchange).toHaveBeenCalledExactlyOnceWith('alt+space');
  });

  it('tells Rust to stop when Escape ends the recording', () => {
    native.flags = [];
    const rec = useHotkeyRecorder(vi.fn());
    rec.toggle();
    rec.onkeydown(esc() as never);
    expect(native.flags).toEqual([true, false]);
  });
});
