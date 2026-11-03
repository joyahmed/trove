// A chord recorder for one settings row: click, press the keys, and that becomes the chord.
// Holds the recording flag, whether Super is down (WebKitGTK never reports it as a modifier,
// see `isSuperKey`), and why the last press was refused. The pure part is `recordChord`.
//
// Some chords never reach the page as a keydown: on Windows, Alt+Space is the window menu's and
// the registered Spotlight chord is the OS's. While recording, Rust holds both back and sends
// them here as `onRecordedChord` (src-tauri/src/core/key_menu.rs, A.8.9).
import { onRecordedChord, setHotkeyRecordingNative } from '$lib/api/palette';
import { isSuperKey, recordChord, setHotkeyRecording } from '$lib/utils/hotkeys';

export const useHotkeyRecorder = (onchange: (chord: string) => unknown) => {
  let recording = $state(false);
  let refused = $state<string | null>(null);
  let superHeld = false;
  let unlisten: Promise<() => void> | null = null;

  const stop = () => {
    recording = false;
    superHeld = false;
    unlisten?.then((off) => off()).catch(() => undefined);
    unlisten = null;
    void setHotkeyRecordingNative(false);
    // not now: the Escape that stopped us is still on its way to the dialog's listener
    setTimeout(() => setHotkeyRecording(recording), 0);
  };

  const accept = (chord: string) => {
    refused = null;
    stop();
    onchange(chord);
  };

  const start = () => {
    recording = true;
    setHotkeyRecording(true);
    void setHotkeyRecordingNative(true);
    unlisten = onRecordedChord((chord) => {
      // the keydown may have recorded this very press already
      if (recording) accept(chord);
    });
    unlisten.catch(() => undefined);
  };

  const onkeydown = (e: KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    // Immediate: the Settings dialog also listens for Escape on window, and a plain
    // stopPropagation does not stop a second window listener.
    e.stopImmediatePropagation();
    if (e.key === 'Escape') {
      stop();
      return;
    }
    if (isSuperKey(e)) {
      superHeld = true;
      return;
    }
    const result = recordChord(e, superHeld);
    if (!result) return;
    if ('refused' in result) {
      // keep listening: the next press may well have its modifier
      refused = result.refused;
      return;
    }
    accept(result.chord);
  };

  const onkeyup = (e: KeyboardEvent) => {
    if (isSuperKey(e)) superHeld = false;
  };

  return {
    get recording() {
      return recording;
    },
    get refused() {
      return recording ? refused : null;
    },
    toggle: () => {
      refused = null;
      if (recording) stop();
      else start();
    },
    onkeydown,
    onkeyup,
    /** a Super released while the window was not looking must not stick */
    onblur: () => {
      superHeld = false;
    },
  };
};
