// @vitest-environment ./vitest.svelte-client-env.ts
// The plain wheel scrolls sideways only while the hook is enabled, which is List view alone.
import { flushSync } from 'svelte';
import { describe, expect, it } from 'vitest';
import { useSidewaysWheel } from './use-sideways-wheel.svelte';

const mount = (enabled: boolean) => {
  const hook: { fn?: (e: unknown) => void } = {};
  let prevented = false;
  const el = {
    scrollLeft: 0,
    scrollWidth: 2000,
    clientWidth: 500,
    scrollHeight: 300,
    clientHeight: 300,
    addEventListener: (_: string, fn: (e: unknown) => void) => (hook.fn = fn),
    removeEventListener: () => {},
  };
  const stop = $effect.root(() => {
    useSidewaysWheel(
      () => el as unknown as HTMLElement,
      () => enabled,
    );
  });
  flushSync();
  // a listener that was never added cannot run: that is the "other views" case
  hook.fn?.({ deltaX: 0, deltaY: 120, deltaMode: 0, preventDefault: () => (prevented = true) });
  return { el, prevented: () => prevented, stop };
};

describe('useSidewaysWheel', () => {
  it('scrolls sideways and cancels the event in List view', () => {
    const { el, prevented, stop } = mount(true);
    expect(el.scrollLeft).toBe(120);
    expect(prevented()).toBe(true);
    stop();
  });
  it('does nothing in any other view', () => {
    const { el, prevented, stop } = mount(false);
    expect(el.scrollLeft).toBe(0);
    expect(prevented()).toBe(false);
    stop();
  });
});
