// The open tabs and which one is active. Everything that reads "the current folder" goes
// through `tabs.active`; a data file must read it lazily (`() => tabs.active.x`), never bind
// a method at module load.
import { TabState } from '$lib/state/tab.svelte';
import type { Location } from '$lib/types/location';
import { startLocation } from '$lib/utils/location';
import { settings } from '$lib/state/settings.svelte';
import { classifyLaunchArg } from '$lib/utils/shell-arg';

const CLOSED_MAX = 10;

class TabsState {
  list = $state<TabState[]>([new TabState()]);
  activeIndex = $state(0);
  /** where closed tabs were, newest last, for Ctrl+Shift+T */
  closed = $state<Location[]>([]);

  get active(): TabState {
    return this.list[this.activeIndex];
  }

  /**
   * Open a new tab and switch to it — on Home, as Explorer does, unless `to` says where.
   * `''` opens an empty tab for a caller that navigates it itself (a launch).
   */
  open(to: Location | string = startLocation(settings.startPlace)) {
    const tab = new TabState();
    this.list.push(tab);
    this.activeIndex = this.list.length - 1;
    if (to !== '') void tab.navigate(to, { replace: true });
    return tab;
  }

  /**
   * A tab for a second launch asking for `path`. A place only Explorer shows (Control Panel,
   * `shell:...`) gets no tab: it is handed to Explorer, and an empty tab would stay blank.
   * Returns `null` then.
   */
  openForLaunch(path: string | undefined): TabState | null {
    if (path && classifyLaunchArg(path) === 'explorer') return null;
    return this.open('');
  }

  /**
   * Close a tab. The last one is never removed here — `'last'` tells the shell to close the
   * window instead, as Explorer does; the state stays free of window calls.
   */
  close(index = this.activeIndex): 'closed' | 'last' {
    if (this.list.length === 1) return 'last';
    const [gone] = this.list.splice(index, 1);
    if (gone.path) {
      this.closed.push(gone.location);
      if (this.closed.length > CLOSED_MAX) this.closed.shift();
    }
    this.activeIndex = Math.min(
      this.activeIndex > index ? this.activeIndex - 1 : this.activeIndex,
      this.list.length - 1,
    );
    return 'closed';
  }

  /** Ctrl+Shift+T: bring back the most recently closed tab, if any. */
  reopen() {
    const to = this.closed.pop();
    if (to !== undefined) return this.open(to);
  }

  activate(index: number) {
    if (index >= 0 && index < this.list.length) this.activeIndex = index;
  }

  /** Ctrl+1…9: the nth tab; 9 is always the last one, as browsers do. */
  jump(n: number) {
    this.activate(n >= 9 ? this.list.length - 1 : n - 1);
  }

  /** Drag to reorder: take the tab at `from` and insert it at `to`; the active tab stays active. */
  move(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= this.list.length || to >= this.list.length)
      return;
    const active = this.active;
    const [tab] = this.list.splice(from, 1);
    this.list.splice(to, 0, tab);
    this.activeIndex = this.list.indexOf(active);
  }

  next = () => this.activate((this.activeIndex + 1) % this.list.length);
  prev = () => this.activate((this.activeIndex - 1 + this.list.length) % this.list.length);
}

export const tabs = new TabsState();
