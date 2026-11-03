# Contributing

Conventions for this codebase. Read them before writing the first component; a PR that
disagrees with them is asked to change, not debated.

## The five frontend rules

### 1. Hooks hold reactivity. Components hold markup.

A `.svelte` file is markup plus one hook call. `$state`, `$derived`, `$effect`, handlers,
fetching, IPC — all of it lives in a **rune module** (`*.svelte.ts`), and the component consumes
what it returns.

```svelte
<!-- src/lib/components/file-list/FileList.svelte -->
<script lang="ts">
  import { useFileList } from '$lib/hooks/use-file-list.svelte';
  import { fileColumns } from '$lib/data/file-columns';
  import FileRow from './file-list-parts/FileRow.svelte';

  const list = useFileList();
</script>

<table>
  <thead>
    <tr>
      {#each fileColumns as col (col.key)}
        <th onclick={() => list.sortBy(col.key)}>{col.label}</th>
      {/each}
    </tr>
  </thead>
  <tbody>
    {#each list.entries as entry (entry.path)}
      <FileRow {entry} selected={list.isSelected(entry)} onopen={list.open} />
    {/each}
  </tbody>
</table>
```

The `<script>` of a `.svelte` file may contain: imports, `$props()`, one `use…()` call, and
`$derived` **only** when it is a one-line view formatting of a prop. Anything else — `$state`,
`$effect`, a handler with logic — belongs in the hook. A component that grows a second `$state`
is the signal to move it.

Two kinds of rune module, both under the "hook" idea:

| Kind                       | File                                  | Shape                                                                  | Use for                                                                 |
| -------------------------- | ------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| App-wide state (singleton) | `src/lib/state/<thing>.svelte.ts`     | a class with `$state` fields, one exported instance                    | current path, tabs, selection, settings — anything two components share |
| Per-instance hook          | `src/lib/hooks/use-<thing>.svelte.ts` | `export const useThing = (args?) => { … return { get x() {…}, doY } }` | a component's own reactivity: a rename box, a context menu              |

The hook form **must return getters** (or a class instance), never a destructured `$state` —
destructuring snapshots the value and the component stops updating.

### 2. Never repeat a markup element — `{#each}` it.

Two similar blocks are a data array you have not written yet. Columns, sidebar sections,
toolbar buttons, menu items, keyboard shortcuts are **data files** in `src/lib/data/` and the
markup that renders them is one element inside `{#each … (key)}` — always keyed. A repeated
fragment that is not a list is a `{#snippet}`, not a copy.

### 3. One component per file; the file is the export.

Components are `PascalCase.svelte`; everything else is `kebab-case.ts` / `kebab-case.svelte.ts`.
Hooks are `use-<thing>.svelte.ts` exporting `useThing`. State modules are `<thing>.svelte.ts`
exporting a lowercase instance. Named exports are for what legitimately holds several things:
hooks, state, utils, data, types.

### 4. Split along seams that mean something.

A component's sub-pieces live in `<name>-parts/` beside it (`FileList.svelte` +
`file-list-parts/FileRow.svelte`). Split at a section, a concern, a piece with its own reason
to change — not to hit a line count. Past ~120 lines look for the seam; "it renders a lot of
markup" usually means rule 2 was skipped.

### 5. Lazy only what is off-screen.

Static-import everything on screen at first paint. `{#await import('./X.svelte')}` **only** for
dialogs and panels mounted on a click, non-active tab panels, the preview pane, heavy
third-party pieces. Never the shell, never `*-parts/`, never anything inside `{#each}`. The
pending block of an `{#await}` is a shape-aware skeleton, not a spinner.

## Svelte 5 specifics

- **Runes only.** `$state`, `$derived`, `$effect`, `$props`, `$bindable`. No `writable()`
  stores, no `export let`, no `$:`, no `on:click` — it is `onclick`. Svelte 4 syntax is a bug.
- **Props are typed with an interface** and destructured once:
  `let { entry, selected = false, onopen }: Props = $props();`
- **Callbacks, not events.** Child → parent is an `on<thing>` prop, not `createEventDispatcher`.
- **`$derived` is the only memo.** `$effect` is rare, lives in hooks, and syncs with the outside
  world (a Tauri event listener, a `ResizeObserver`) — never derives state.
- **Reactive collections:** mutate in place (`entries.push(e)`); Svelte 5 proxies deep state.
- **Styling:** Tailwind v4 utilities in markup; a `<style>` block only for what utilities
  cannot say. Design tokens are CSS variables in `src/app.css` under `@theme`.

## Where things live

```
src/
  app.css                      Tailwind + @theme tokens (Fluent light/dark, Mica surfaces)
  routes/+page.svelte          the one route: renders <Shell />. SPA, ssr = false
  lib/
    api/                       typed wrappers around Tauri `invoke` — the ONLY place invoke appears
    types/                     FileEntry, DriveInfo … — mirror the Rust structs (serde camelCase)
    state/                     app-wide singletons, class + $state
    hooks/                     per-instance use-*.svelte.ts
    data/                      columns, sidebar sections, actions, menus — data, not markup
    utils/                     pure functions
    components/
      shell/                   Shell.svelte, TitleBar.svelte, shell-parts/
      sidebar/                 Sidebar.svelte, sidebar-parts/
      file-list/               FileList.svelte, file-list-parts/
src-tauri/src/
  lib.rs                       Builder: plugins, invoke_handler
  commands/<domain>.rs         #[tauri::command] fns, one file per domain, thin — call into core
  core/<domain>.rs             the logic, unit-tested, no tauri types
```

**Tauri IPC layering is a rule:** `.svelte` → hook/state → `$lib/api/*` → `invoke`. A component
never imports `@tauri-apps/api`. Every command's request/response type is declared once in
`src/lib/types/` and once as a `#[derive(Serialize)] #[serde(rename_all = "camelCase")]` struct;
the two are kept identical by hand.

## The gate

The package manager is bun (`bun install`; the lockfile is `bun.lock`). `bun run gate` runs, in
order: `svelte-check`, `eslint`, `prettier --check`, `vitest`, `vite build`, `cargo fmt --check`,
`cargo clippy -- -D warnings`, `cargo test`. Green or the change does not land. Individual
scripts: `bun run check`, `bun run lint`, `bun run format`, `bun run test`, `bun run build`,
`bun run gate:rs`.

## Commit messages

Subject: `✅DOMAIN: task` — `✅FE:` frontend, `✅RS:` Rust, `✅SHELL:` window/title bar/Mica,
`✅DOCS:`, `✅PLAN:`, `✅SETUP:` tooling. Body: the problem, the change, why this way, closing
with one plain **Verified** sentence saying what was run or seen. No generated trailers.
