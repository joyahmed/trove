// The Details pane's reactivity: follow the selection and the active tab while mounted,
// listen for folder totals, and hand the state to the markup as getters.
import { untrack } from 'svelte';
import {
  attributeToggles,
  detailsRows,
  fmtContains,
  notCountedNote,
  recycleItemRows,
  recycleSelectedItem,
  recycleSummary,
} from '$lib/data/details-rows';
import { recycle } from '$lib/state/recycle.svelte';
import { details } from '$lib/state/details.svelte';
import { selection } from '$lib/state/selection.svelte';
import { tabs } from '$lib/state/tabs.svelte';
import { fmtSize } from '$lib/utils/format';
import { locationLabel } from '$lib/utils/location';
import { onMac } from '$lib/utils/platform';
import { detailsIcon, previewPlaceIcon } from './use-preview-pane-icon';

const extOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

export const useDetailsPane = () => {
  // The pane is lazy: listen while mounted, drop everything on unmount.
  $effect(() => {
    const detach = details.attach();
    return () => {
      detach();
      details.reset();
    };
  });

  // Re-sync on any change of the selection or the folder; the rest is untracked so a
  // listing refresh does not re-fetch.
  $effect(() => {
    void selection.count;
    void selection.focused;
    void tabs.active.location;
    untrack(() => void details.sync());
  });

  const rows = $derived(
    details.props
      ? detailsRows
          .map((r) => ({
            key: r.key,
            label: r.label,
            value: r.value(details.props!, details.totals),
          }))
          .filter((r): r is { key: string; label: string; value: string } => r.value !== null)
      : [],
  );

  const manySummary = $derived.by(() => {
    const t = details.totals;
    if (!t) return '';
    const size = `${fmtSize(t.bytes)}${t.done ? '' : '…'}${notCountedNote(t)}`;
    return `${fmtContains(t)} · ${size}`;
  });

  const toggles = $derived(
    attributeToggles().map((t) => ({ ...t, checked: details.props?.[t.key] ?? false })),
  );

  // the header icon: a Mac app's glyph, the bin for the Trash folder, else folder / file
  const icon = $derived(details.props ? detailsIcon(details.props) : null);
  // what EntryIcon draws from: the listing's row, or (the current folder) one made from props
  const iconEntry = $derived.by(() => {
    const p = details.props;
    if (!p) return null;
    if (details.entry?.path === p.path) return details.entry;
    const dot = p.name.lastIndexOf('.');
    const ext = !p.isDir && dot > 0 ? p.name.slice(dot + 1).toLowerCase() : null;
    return {
      name: p.name,
      path: p.path,
      isDir: p.isDir,
      isLink: false,
      iconKey: p.isDir ? 'folder' : ext ? `ext/${ext}` : `file/${p.path}`,
      // the thumbnail's cache stamp (thumbStamp), as a listing row carries them
      size: p.size,
      modifiedMs: p.modifiedMs,
    };
  });
  // a place (Trash, Home, This PC, Gallery) has no path to read props from: name it instead of
  // "Select an item" (the Mac: the sidebar's Trash showed nothing at all)
  const place = $derived.by(() => {
    const loc = tabs.active.location;
    if (loc.kind === 'path') return null;
    // the Trash view has read the bin by the time this pane shows; say what is in it
    const bin = loc.kind === 'recycle-bin' && recycle.loaded;
    const summary = bin ? recycleSummary(recycle.items) : null;
    // one bin item selected: show it as the pane shows a file, so its deleted date can be read
    // even where the list hides that column (plan 15 A.5.10, 800-1000 px with the pane open)
    const one = bin ? recycleSelectedItem(recycle.items, recycle.selected) : null;
    const item = one
      ? {
          name: one.name,
          entry: {
            name: one.name,
            path: one.id,
            isDir: one.isDir,
            isLink: false,
            iconKey: one.isDir ? 'folder' : `ext/${extOf(one.name)}`,
          },
          rows: recycleItemRows(one, onMac()),
        }
      : null;
    return { label: locationLabel(loc), icon: previewPlaceIcon(loc), summary, item };
  });

  const setAttribute = (key: 'readOnly' | 'hidden', value: boolean) =>
    key === 'readOnly' ? details.setReadOnly(value) : details.setHidden(value);

  return {
    get target() {
      return details.target;
    },
    get props() {
      return details.props;
    },
    get count() {
      return details.count;
    },
    get loading() {
      return details.loading;
    },
    get writing() {
      return details.writing;
    },
    get error() {
      return details.error;
    },
    /** inside an archive: read-only, no attribute boxes */
    get inArchive() {
      return details.inArchive;
    },
    get rows() {
      return rows;
    },
    get entry() {
      return details.entry;
    },
    get icon() {
      return icon;
    },
    get iconEntry() {
      return iconEntry;
    },
    get place() {
      return place;
    },
    get manySummary() {
      return manySummary;
    },
    get toggles() {
      return toggles;
    },
    setAttribute,
  };
};
