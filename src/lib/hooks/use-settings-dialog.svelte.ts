// The Settings dialog's reactivity: the section list, the rows of the chosen section (read
// live — the hidden-folder rows change as the person clicks), Escape closes.
import { settingsSections, type SettingRow } from '$lib/data/settings-sections';
import { settingsDialog, type SettingsSectionKey } from '$lib/state/settings-dialog.svelte';
import { isRecordingHotkey } from '$lib/utils/focus-trap';
import { isHotkeyRecording } from '$lib/utils/hotkeys';
import { useFocusReturn } from './use-focus-return.svelte';

export const useSettingsDialog = () => {
  const { trap, isTop } = useFocusReturn();
  const section = $derived(
    settingsSections.find((s) => s.key === settingsDialog.section) ?? settingsSections[0],
  );

  const onkeydown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    // a Confirm on top ("Reset settings?") answers its own Escape; a listening hotkey recorder
    // takes Escape as "stop recording", not "close Settings" (the flag, because on the Mac the
    // key lands on <body>, not on the recording button)
    if (!isTop() || isHotkeyRecording() || isRecordingHotkey(e.target)) return;
    settingsDialog.close();
    e.preventDefault();
    e.stopPropagation();
  };

  return {
    sections: settingsSections,
    get current(): SettingsSectionKey {
      return settingsDialog.section;
    },
    get title() {
      return section.label;
    },
    get rows(): SettingRow[] {
      return section.rows();
    },
    select: (key: SettingsSectionKey) => (settingsDialog.section = key),
    close: () => settingsDialog.close(),
    onkeydown,
    /** on the panel: takes focus into the dialog as it opens, keeps Tab inside (utils/focus-trap) */
    trap,
  };
};
