// The dialogs' window key handlers, driven directly: $effect and <svelte:window> do not run in
// this (node) setup, so each test calls `onkeydown` itself and asserts what it did.
//
// Three rules (utils/focus-trap):
//   - Enter on a focused control is that control's: Tab → Cancel → Enter must answer NO.
//   - Only the topmost dialog reacts: one key must not reach the dialog underneath too.
//   - A listening hotkey recorder owns every key, Tab and Escape included.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirm } from '$lib/state/confirm.svelte';
import { customize } from '$lib/state/customize.svelte';
import { settingsDialog } from '$lib/state/settings-dialog.svelte';
import { transfers } from '$lib/state/transfers.svelte';
import type { CustomCommand } from '$lib/types/shell-verbs';
import { RECORDING_ATTR, wrapTab, type TrapNode } from '$lib/utils/focus-trap';
import { useConfirmDialog } from './use-confirm-dialog.svelte';
import { useConflictDialog } from './use-conflict-dialog.svelte';
import { useCustomizeDialog } from './use-customize-dialog.svelte';
import { useSettingsDialog } from './use-settings-dialog.svelte';
import { setHotkeyRecording } from '$lib/utils/hotkeys';

interface FakeEl {
  name: string;
  tagName: string;
  type?: string;
  focus: () => void;
  isConnected: boolean;
  hasAttribute: (name: string) => boolean;
  attrs: Set<string>;
}

const doc: { activeElement: unknown; body: unknown; querySelector: () => null } = {
  activeElement: null,
  body: { name: 'body' },
  querySelector: () => null,
};

const el = (name: string, tagName = 'BUTTON', type?: string): FakeEl => {
  const node: FakeEl = {
    name,
    tagName,
    type,
    isConnected: true,
    attrs: new Set(),
    hasAttribute: (a) => node.attrs.has(a),
    focus: () => {
      doc.activeElement = node;
    },
  };
  return node;
};

const panelOf = (items: FakeEl[]) => {
  const node: TrapNode & { tagName: string } = {
    tagName: 'DIV',
    focus: () => {
      doc.activeElement = node;
    },
    contains: (other) => other === node || items.includes(other as FakeEl),
    querySelectorAll: () => items,
  };
  return node;
};

const key = (k: string, target: unknown, shiftKey = false) => {
  const e = {
    key: k,
    target,
    shiftKey,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    defaultPrevented: false,
    preventDefault() {
      e.defaultPrevented = true;
    },
    stopPropagation() {},
  };
  return e;
};
const asKey = (e: ReturnType<typeof key>) => e as unknown as KeyboardEvent;

/** Open a dialog: its hook plus a mounted panel (what `use:dialog.trap` does). */
const mount = <D extends { trap: (p: HTMLElement) => { destroy: () => void } }>(
  dialog: D,
  items: FakeEl[],
) => {
  const panel = panelOf(items);
  const action = dialog.trap(panel as unknown as HTMLElement);
  return { dialog, panel, close: () => action.destroy() };
};

const settled = async (p: Promise<boolean>) => {
  let value: boolean | 'pending' = 'pending';
  void p.then((v) => (value = v));
  await Promise.resolve();
  await Promise.resolve();
  return value;
};

beforeEach(() => {
  doc.activeElement = doc.body;
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
});
afterEach(() => {
  confirm.answer(false);
  customize.draft = null;
  settingsDialog.open = false;
  transfers.pending = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const askDelete = () =>
  confirm.ask({ title: 'Delete permanently?', message: '', okLabel: 'Delete', danger: true });

describe('Confirm: Enter answers for the panel, a focused button answers for itself', () => {
  it('Tab to Cancel, Enter → NO (was: YES, a permanent delete)', async () => {
    const answer = askDelete();
    const cancel = el('Cancel');
    const ok = el('Delete');
    const { dialog, panel, close } = mount(useConfirmDialog(), [cancel, ok]);
    expect(doc.activeElement).toBe(panel);

    expect(wrapTab(key('Tab', panel), panel, doc)).toBe(true);
    expect(doc.activeElement).toBe(cancel);

    const enter = key('Enter', cancel);
    dialog.onkeydown(asKey(enter));
    // the handler stood aside: the browser clicks Cancel
    expect(enter.defaultPrevented).toBe(false);
    expect(confirm.pending).not.toBeNull();
    dialog.cancel(); // Cancel's own click
    expect(await settled(answer)).toBe(false);
    close();
  });

  it('Enter on the panel itself → YES', async () => {
    const answer = askDelete();
    const { dialog, panel, close } = mount(useConfirmDialog(), [el('Cancel'), el('Delete')]);
    const enter = key('Enter', panel);
    dialog.onkeydown(asKey(enter));
    expect(enter.defaultPrevented).toBe(true);
    expect(await settled(answer)).toBe(true);
    close();
  });

  it('Shift+Tab to OK, Enter → YES (through the OK button)', async () => {
    const answer = askDelete();
    const cancel = el('Cancel');
    const ok = el('Delete');
    const { dialog, panel, close } = mount(useConfirmDialog(), [cancel, ok]);
    expect(wrapTab(key('Tab', panel, true), panel, doc)).toBe(true);
    expect(doc.activeElement).toBe(ok);

    const enter = key('Enter', ok);
    dialog.onkeydown(asKey(enter));
    expect(enter.defaultPrevented).toBe(false);
    dialog.ok(); // OK's own click
    expect(await settled(answer)).toBe(true);
    close();
  });

  it('Escape → NO wherever focus is', async () => {
    const answer = askDelete();
    const cancel = el('Cancel');
    const { dialog, close } = mount(useConfirmDialog(), [cancel, el('Delete')]);
    const esc = key('Escape', cancel);
    dialog.onkeydown(asKey(esc));
    expect(esc.defaultPrevented).toBe(true);
    expect(await settled(answer)).toBe(false);
    close();
  });
});

const draft: CustomCommand = {
  id: 'x',
  label: 'Open in Code',
  program: 'code',
  args: '"%path%"',
  scope: ['folder'],
};

describe('Custom commands: Enter saves from a field, not from a button', () => {
  it('Enter on Cancel (or a header button) does not save', () => {
    const save = vi.spyOn(customize, 'save').mockImplementation(() => {});
    customize.draft = { ...draft };
    const cancel = el('Cancel');
    const { dialog, close } = mount(useCustomizeDialog(), [el('Name', 'INPUT', 'text'), cancel]);
    const enter = key('Enter', cancel);
    dialog.onkeydown(asKey(enter));
    expect(save).not.toHaveBeenCalled();
    expect(enter.defaultPrevented).toBe(false);
    close();
  });

  it('Enter in a text field saves; in a textarea it does not', () => {
    const save = vi.spyOn(customize, 'save').mockImplementation(() => {});
    customize.draft = { ...draft };
    const name = el('Name', 'INPUT', 'text');
    const notes = el('Notes', 'TEXTAREA');
    const { dialog, close } = mount(useCustomizeDialog(), [name, notes]);
    dialog.onkeydown(asKey(key('Enter', notes)));
    expect(save).not.toHaveBeenCalled();
    const enter = key('Enter', name);
    dialog.onkeydown(asKey(enter));
    expect(save).toHaveBeenCalledTimes(1);
    expect(enter.defaultPrevented).toBe(true);
    close();
  });
});

describe('Settings Escape while a hotkey is being recorded', () => {
  it('ignores Escape even when the key landed on body, and closes again after stop', () => {
    settingsDialog.show();
    const settings = mount(useSettingsDialog(), [el('General')]);
    setHotkeyRecording(true);
    settings.dialog.onkeydown(asKey(key('Escape', {})));
    expect(settingsDialog.open).toBe(true);
    setHotkeyRecording(false);
    settings.dialog.onkeydown(asKey(key('Escape', {})));
    expect(settingsDialog.open).toBe(false);
    settings.close();
  });
});

describe('stacked dialogs: only the top one reacts', () => {
  it('Escape on "Reset settings?" answers it and leaves Settings open', async () => {
    settingsDialog.show();
    const settings = mount(useSettingsDialog(), [el('General')]);
    const answer = confirm.ask({
      title: 'Reset settings?',
      message: '',
      okLabel: 'Reset',
      danger: true,
    });
    const top = mount(useConfirmDialog(), [el('Cancel'), el('Reset')]);

    // <svelte:window> order: Settings' listener was added first, so it hears the key first
    const esc = key('Escape', top.panel);
    settings.dialog.onkeydown(asKey(esc));
    expect(settingsDialog.open).toBe(true);
    top.dialog.onkeydown(asKey(esc));
    expect(await settled(answer)).toBe(false);
    top.close();

    // Confirm gone: Settings is the top again and Escape closes it
    settings.dialog.onkeydown(asKey(key('Escape', settings.panel)));
    expect(settingsDialog.open).toBe(false);
    settings.close();
  });

  it('Enter on a Confirm over Custom commands does not save the draft', async () => {
    const save = vi.spyOn(customize, 'save').mockImplementation(() => {});
    customize.draft = { ...draft };
    const field = el('Name', 'INPUT', 'text');
    const under = mount(useCustomizeDialog(), [field]);
    const answer = askDelete();
    const top = mount(useConfirmDialog(), [el('Cancel'), el('Delete')]);

    const enter = key('Enter', top.panel);
    under.dialog.onkeydown(asKey(enter));
    top.dialog.onkeydown(asKey(enter));
    expect(save).not.toHaveBeenCalled();
    expect(await settled(answer)).toBe(true);
    top.close();
    under.close();
  });

  it('Conflict: Escape cancels only while it is the top dialog', () => {
    transfers.pending = {
      sources: ['C:/a/x.txt'],
      destination: 'C:/b',
      mode: 'copy',
      conflicts: ['C:/b/x.txt'],
      fromCut: false,
    } as typeof transfers.pending;
    const conflict = mount(useConflictDialog(), [el('Replace'), el('Skip'), el('Keep both')]);
    const answer = askDelete();
    const top = mount(useConfirmDialog(), [el('Cancel'), el('Delete')]);
    conflict.dialog.onkeydown(asKey(key('Escape', top.panel)));
    expect(transfers.pending).not.toBeNull();
    top.dialog.onkeydown(asKey(key('Escape', top.panel)));
    top.close();
    void answer;

    conflict.dialog.onkeydown(asKey(key('Escape', conflict.panel)));
    expect(transfers.pending).toBeNull();
    conflict.close();
  });
});

describe('a listening hotkey recorder owns Tab and Escape', () => {
  it('Shift+Tab while recording is not wrapped away; Escape does not close Settings', () => {
    settingsDialog.show();
    const first = el('General');
    const recorder = el('Shortcut');
    const { dialog, panel, close } = mount(useSettingsDialog(), [first, recorder]);
    recorder.focus();
    recorder.attrs.add(RECORDING_ATTR);

    // without the recorder flag this is the "first ↔ last" wrap at the start — check both
    first.focus();
    first.attrs.add(RECORDING_ATTR);
    const shiftTab = key('Tab', first, true);
    expect(wrapTab(shiftTab, panel, doc)).toBe(false);
    expect(shiftTab.defaultPrevented).toBe(false);
    expect(doc.activeElement).toBe(first);
    first.attrs.delete(RECORDING_ATTR);
    expect(wrapTab(key('Tab', first, true), panel, doc)).toBe(true);
    expect(doc.activeElement).toBe(recorder);

    dialog.onkeydown(asKey(key('Escape', recorder)));
    expect(settingsDialog.open).toBe(true);
    recorder.attrs.delete(RECORDING_ATTR);
    dialog.onkeydown(asKey(key('Escape', recorder)));
    expect(settingsDialog.open).toBe(false);
    close();
  });
});
