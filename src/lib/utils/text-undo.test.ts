import { describe, expect, it, vi } from 'vitest';
import { bindTextUndo, textUndoCommand } from './text-undo';

const key = (
  k: string,
  mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {},
  code?: string,
) => ({ key: k, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

const field = (tagName: string, inTerminal = false) => ({
  tagName,
  closest: () => (inTerminal ? {} : null),
});

describe('textUndoCommand', () => {
  it('maps GTK undo and redo chords in an input or textarea', () => {
    expect(textUndoCommand(key('z', { ctrlKey: true }), field('INPUT'))).toBe('undo');
    expect(textUndoCommand(key('Z', { ctrlKey: true, shiftKey: true }), field('INPUT'))).toBe(
      'redo',
    );
    expect(textUndoCommand(key('y', { ctrlKey: true }), field('TEXTAREA'))).toBe('redo');
  });
  it('reads the physical key on a non-Latin layout', () => {
    expect(textUndoCommand(key('я', { ctrlKey: true }, 'KeyZ'), field('INPUT'))).toBe('undo');
  });
  it('leaves the file list, the terminal and other chords alone', () => {
    expect(textUndoCommand(key('z', { ctrlKey: true }), field('DIV'))).toBeNull();
    expect(textUndoCommand(key('z', { ctrlKey: true }), null)).toBeNull();
    expect(textUndoCommand(key('z', { ctrlKey: true }), field('TEXTAREA', true))).toBeNull();
    expect(textUndoCommand(key('z'), field('INPUT'))).toBeNull();
    expect(textUndoCommand(key('z', { ctrlKey: true, altKey: true }), field('INPUT'))).toBeNull();
    expect(textUndoCommand(key('c', { ctrlKey: true }), field('INPUT'))).toBeNull();
  });
});

describe('bindTextUndo', () => {
  const setup = (linux: boolean, focused = field('INPUT')) => {
    const target = new EventTarget();
    const exec = vi.fn<(cmd: string) => boolean>(() => true);
    const remove = bindTextUndo(linux, target as unknown as Window, {
      activeElement: focused,
      execCommand: exec,
    });
    const fire = (k: string, mods: object = {}) => {
      const e = Object.assign(new Event('keydown', { cancelable: true }), { ...key(k), ...mods });
      target.dispatchEvent(e);
      return e;
    };
    return { exec, fire, remove };
  };
  it('runs undo and redo and cancels the key on Linux', () => {
    const { exec, fire, remove } = setup(true);
    expect(fire('z', { ctrlKey: true }).defaultPrevented).toBe(true);
    fire('Z', { ctrlKey: true, shiftKey: true });
    expect(exec.mock.calls).toEqual([['undo'], ['redo']]);
    remove();
    fire('z', { ctrlKey: true });
    expect(exec).toHaveBeenCalledTimes(2);
  });
  it('does nothing on Windows and Mac', () => {
    const { exec, fire } = setup(false);
    expect(fire('z', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
  it('leaves Ctrl+Z to the terminal', () => {
    const { exec, fire } = setup(true, field('TEXTAREA', true));
    expect(fire('z', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});
