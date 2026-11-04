import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NoBinRefusal } from '$lib/api/fs';
import type { readDir, pathKind, netSignIn, cloudSyncStatus } from '$lib/api/fs';
import type { readArchiveDir } from '$lib/api/archive';
import type { galleryItems } from '$lib/api/gallery';
import type { recentFiles } from '$lib/api/recent';
import type { spotlightApps, spotlightFiles, indexSearch, indexProgress } from '$lib/api/palette';
import type { indexDrives } from '$lib/api/index-settings';
import type { initialLaunch } from '$lib/api/launch';
import type { whoIsLocking, endLockingApp } from '$lib/api/lockers';
import type { openWithApps } from '$lib/api/open-with';
import type { readTextHead } from '$lib/api/preview';
import type { fileProps, folderDriveKind } from '$lib/api/props';
import type { ptyFollow } from '$lib/api/pty';
import type { recycleList } from '$lib/api/recycle';
import type { takeLastSession } from '$lib/api/session';
import type { drives, knownFolders } from '$lib/api/shell';
import type { shellVerbs, detectCommonCommands, shellMenu } from '$lib/api/shell-verbs';
import type { systemTheme } from '$lib/api/theme';
import type { removeMovedOriginals, dragOut, dropModifiers, folderSpace } from '$lib/api/transfer';
import type { clipboardReadPaths } from '$lib/api/clipboard';
import type { uninstallList, uninstallApp } from '$lib/api/uninstall';
import type { wslDistros } from '$lib/api/wsl';
import type { defaultHandlerStatus, defaultHandlerInfo } from '$lib/api/default-handler';
import type { imageDimensions } from '$lib/api/image-dims';

// Plan 07 phase F.1. Nothing else in the suite crosses the IPC boundary: Rust commands are tested
// in Rust and the frontend with `$lib/api/*` mocked, so a command whose JSON disagrees with the
// TypeScript type passed both. `src-tauri/src/ipc_contract.rs` serializes a sample of every
// structured command response into `src-tauri/tests/ipc-fixtures/<command>.json` (and fails when
// those files are stale); this test checks each sample against the type the wrapper in
// `$lib/api` promises.
//
// Types are erased at run time, so each command has a SPEC: a plain object written against the
// wrapper's own return type (`Ret<typeof wrapper>`). svelte-check makes the spec exhaustive over
// the type's keys (rename or add a field in the type and `bun run check` fails here); the test
// makes the fixture match the spec exactly (rename or add a field in Rust and `bun run test`
// fails here). A field the type marks optional may be absent from a sample; any other must be
// there, and a key the spec does not name is a failure too.

type Ret<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

type Spec<T> = null extends T
  ? { nullable: Spec<Exclude<T, null>> }
  : [T] extends [boolean]
    ? 'boolean'
    : [T] extends [number]
      ? 'number'
      : [T] extends [string]
        ? string extends T
          ? 'string'
          : { oneOf: readonly T[] }
        : [T] extends [readonly unknown[]]
          ? { array: Spec<T[number]> }
          : ObjSpec<T> | { any: readonly ObjSpec<T>[] };

type ObjSpec<T> = T extends object ? { shape: Shape<T> } : never;

type Shape<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K>
    ? { optional: Spec<Exclude<T[K], undefined>> }
    : Spec<T[K]>;
};

type Any = string | { [key: string]: unknown };

const check = (spec: unknown, value: unknown, at: string, errors: string[]): void => {
  const fail = (why: string): void => {
    errors.push(`${at}: ${why} (got ${JSON.stringify(value)})`);
  };
  if (typeof spec === 'string') {
    if (typeof value !== spec) fail(`expected ${spec}`);
    return;
  }
  const s = spec as Record<string, unknown>;
  if ('oneOf' in s) {
    if (!(s.oneOf as unknown[]).includes(value)) fail(`not one of ${JSON.stringify(s.oneOf)}`);
  } else if ('nullable' in s) {
    if (value !== null) check(s.nullable, value, at, errors);
  } else if ('array' in s) {
    if (!Array.isArray(value)) return fail('expected an array');
    value.forEach((item, i) => check(s.array, item, `${at}[${i}]`, errors));
  } else if ('any' in s) {
    const tries = (s.any as unknown[]).map((one) => {
      const e: string[] = [];
      check(one, value, at, e);
      return e;
    });
    if (!tries.some((e) => e.length === 0)) fail(`matches no variant: ${tries.flat().join('; ')}`);
  } else if ('shape' in s) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail('expected an object');
    }
    const shape = s.shape as Record<string, Any>;
    const got = value as Record<string, unknown>;
    for (const key of Object.keys(got)) {
      if (!(key in shape)) errors.push(`${at}: Rust sends "${key}", the type has no such field`);
    }
    for (const [key, field] of Object.entries(shape)) {
      const optional = typeof field === 'object' && 'optional' in field;
      if (!(key in got)) {
        if (!optional) errors.push(`${at}: the type needs "${key}", Rust did not send it`);
        continue;
      }
      check(
        optional ? (field as { optional: unknown }).optional : field,
        got[key],
        `${at}.${key}`,
        errors,
      );
    }
  } else {
    fail(`unknown spec ${JSON.stringify(spec)}`);
  }
};

const str = 'string' as const;
const num = 'number' as const;
const bool = 'boolean' as const;
const obj = <T>(shape: Shape<T>): { shape: Shape<T> } => ({ shape });

type ShellMenuNode = Ret<typeof shellMenu>['items'][number];
/** The shell menu is a tree: `children` points back at the node spec itself. */
const shellMenuItem = obj<ShellMenuNode>({
  id: num,
  label: str,
  verb: { nullable: str },
  enabled: bool,
  separator: bool,
  children: { array: { shape: {} as Shape<ShellMenuNode> } },
  iconKey: { nullable: str },
});
shellMenuItem.shape.children = { array: shellMenuItem };

const fileEntry = {
  shape: {
    name: str,
    path: str,
    isDir: bool,
    size: num,
    modifiedMs: { nullable: num },
    createdMs: { nullable: num },
    ext: { nullable: str },
    isHidden: bool,
    iconKey: str,
    typeName: str,
    isLink: { optional: bool },
    cloudState: { optional: { oneOf: ['online', 'pinned', 'local'] } },
  },
} as const;
const dirListing = { shape: { path: str, entries: { array: fileEntry } } } as const;
const indexFilling = { shape: { label: str, seen: num } } as const;
const locker = {
  shape: {
    pid: num,
    app: str,
    exe: str,
    canEnd: bool,
    noEnd: { nullable: { oneOf: ['trove', 'terminal', 'windows', 'otherSession'] } },
  },
} as const;
const transferFailure = {
  shape: {
    path: str,
    destination: str,
    error: str,
    kind: { oneOf: ['file', 'folder', 'new-folder', 'not-removed'] },
    copy: { optional: str },
  },
} as const;

/** command name (= the fixture file) -> spec of one sample of its response. */
const cases: Record<string, unknown> = {
  read_dir: dirListing satisfies Spec<Ret<typeof readDir>>,
  read_archive_dir: dirListing satisfies Spec<Ret<typeof readArchiveDir>>,
  path_kind: { oneOf: ['file', 'dir', 'missing'] } satisfies Spec<Ret<typeof pathKind>>,
  net_sign_in: { oneOf: ['connected', 'cancelled'] } satisfies Spec<Ret<typeof netSignIn>>,
  cloud_sync_status: {
    nullable: { oneOf: ['up-to-date', 'syncing', 'offline', 'error'] },
  } satisfies Spec<Ret<typeof cloudSyncStatus>>,
  gallery_items: { array: fileEntry } satisfies Spec<Ret<typeof galleryItems>>,
  recent_files: { array: fileEntry } satisfies Spec<Ret<typeof recentFiles>>,
  spotlight_files: obj<Ret<typeof spotlightFiles>>({
    entries: { array: fileEntry },
    skippedGuarded: { array: str },
  }),
  index_search: obj<Ret<typeof indexSearch>>({
    ready: bool,
    roots: { array: str },
    hits: { array: fileEntry },
    total: num,
    filling: { optional: { array: indexFilling } },
    stale: { optional: { array: str } },
    skippedGuarded: { optional: { array: str } },
  }),
  index_progress: { array: indexFilling } satisfies Spec<Ret<typeof indexProgress>>,
  index_drives: { array: obj<Ret<typeof indexDrives>[number]>({ root: str }) },
  initial_launch: obj<Ret<typeof initialLaunch>>({
    path: { nullable: str },
    select: { nullable: str },
    hidden: bool,
  }),
  who_is_locking: {
    array: obj<Ret<typeof whoIsLocking>[number]>({ path: str, lockers: { array: locker } }),
  },
  end_locking_app: { oneOf: ['ended', 'stillRunning'] } satisfies Spec<Ret<typeof endLockingApp>>,
  open_with_apps: {
    array: obj<Ret<typeof openWithApps>[number]>({
      id: str,
      name: str,
      icon: { nullable: str },
      isDefault: bool,
    }),
  },
  read_text_head: obj<Ret<typeof readTextHead>>({ text: str, truncated: bool, binary: bool }),
  file_props: obj<Ret<typeof fileProps>>({
    path: str,
    name: str,
    isDir: bool,
    typeName: str,
    size: num,
    sizeOnDisk: num,
    createdMs: { nullable: num },
    modifiedMs: { nullable: num },
    accessedMs: { nullable: num },
    readOnly: bool,
    hidden: bool,
    system: bool,
    archive: bool,
  }),
  folder_drive_kind: {
    oneOf: ['local', 'network', 'removable', 'wsl'],
  } satisfies Spec<Ret<typeof folderDriveKind>>,
  pty_follow: { oneOf: ['typed', 'busy', 'otherShell'] } satisfies Spec<Ret<typeof ptyFollow>>,
  recycle_list: {
    array: obj<Ret<typeof recycleList>[number]>({
      id: str,
      name: str,
      originalParent: { nullable: str },
      deletedMs: num,
      isDir: bool,
      size: { nullable: num },
    }),
  },
  take_last_session: {
    nullable: obj<NonNullable<Ret<typeof takeLastSession>>>({
      windows: {
        array: obj<NonNullable<Ret<typeof takeLastSession>>['windows'][number]>({
          label: str,
          tabs: { array: str },
          active: num,
          bounds: {
            optional: obj<{ x: number; y: number; w: number; h: number; maximized: boolean }>({
              x: num,
              y: num,
              w: num,
              h: num,
              maximized: bool,
            }),
          },
        }),
      },
    }),
  },
  drives: {
    array: obj<Ret<typeof drives>[number]>({
      path: str,
      label: str,
      totalBytes: { nullable: num },
      freeBytes: { nullable: num },
      network: { optional: bool },
    }),
  },
  known_folders: {
    array: obj<Ret<typeof knownFolders>[number]>({
      key: { oneOf: ['desktop', 'downloads', 'documents', 'pictures', 'music', 'videos'] },
      label: str,
      path: str,
    }),
  },
  shell_verbs: {
    array: obj<Ret<typeof shellVerbs>[number]>({
      key: str,
      label: str,
      command: str,
      icon: { nullable: str },
      scope: { oneOf: ['directory', 'directory-background', 'file', 'drive'] },
    }),
  },
  shell_menu: obj<Ret<typeof shellMenu>>({ token: num, items: { array: shellMenuItem } }),
  detect_common_commands: {
    array: obj<Ret<typeof detectCommonCommands>[number]>({
      id: str,
      label: str,
      program: str,
      args: str,
      scope: { array: { oneOf: ['file', 'folder', 'background', 'wsl'] } },
      source: {
        oneOf: ['app-paths', 'start-menu', 'path', 'known-dir', 'wsl-distro', 'desktop-entry'],
      },
      certain: bool,
    }),
  },
  spotlight_apps: {
    array: obj<Ret<typeof spotlightApps>[number]>({
      name: str,
      lnkPath: str,
      target: str,
      aumid: str,
      openWith: { nullable: obj<{ program: string; args: string }>({ program: str, args: str }) },
      path: str,
    }),
  },
  system_theme: obj<Ret<typeof systemTheme>>({ accent: str, transparency: bool, textScale: num }),
  remove_moved_originals: { array: transferFailure } satisfies {
    array: Spec<Ret<typeof removeMovedOriginals>[number]>;
  },
  clipboard_read_paths: {
    nullable: obj<NonNullable<Ret<typeof clipboardReadPaths>>>({
      paths: { array: str },
      cut: bool,
    }),
  },
  drag_out: obj<Ret<typeof dragOut>>({ effect: { oneOf: ['none', 'copy', 'move'] } }),
  drop_modifiers: obj<Ret<typeof dropModifiers>>({ ctrl: bool, shift: bool }),
  folder_space: {
    nullable: obj<NonNullable<Ret<typeof folderSpace>>>({ freeBytes: num, mountRoot: str }),
  },
  uninstall_list: {
    array: obj<Ret<typeof uninstallList>[number]>({
      id: str,
      name: str,
      version: str,
      publisher: str,
      folder: str,
      path: str,
      removable: {
        oneOf: ['yes', 'system', 'trove', 'noUninstaller', 'link', 'notApp', 'elsewhere'],
      },
      program: str,
      stamp: str,
      typed: bool,
    }),
  },
  uninstall_app: {
    oneOf: ['gone', 'stillListed', 'unknown', 'noTrash', 'typedInTerminal'],
  } satisfies Spec<Ret<typeof uninstallApp>>,
  wsl_distros: {
    array: obj<Ret<typeof wslDistros>[number]>({ name: str, isDefault: bool, uid: num }),
  },
  default_handler_status: {
    any: [
      obj<{ kind: 'not-applied' }>({ kind: { oneOf: ['not-applied'] } }),
      obj<{ kind: 'applied' }>({ kind: { oneOf: ['applied'] } }),
      obj<{ kind: 'partially-applied'; applied: string[] }>({
        kind: { oneOf: ['partially-applied'] },
        applied: { array: str },
      }),
      obj<{ kind: 'applied-to-other'; exe: string }>({
        kind: { oneOf: ['applied-to-other'] },
        exe: str,
      }),
    ],
  } satisfies { any: readonly ObjSpec<Ret<typeof defaultHandlerStatus>>[] },
  default_handler_info: obj<Ret<typeof defaultHandlerInfo>>({ exePath: str, stable: bool }),
  image_dimensions: {
    array: { nullable: { array: num } },
  } satisfies Spec<Ret<typeof imageDimensions>>,
  'trash_entries.error': {
    any: [
      obj<NoBinRefusal>({
        noBin: str,
        reason: { oneOf: ['noBin', 'off', 'tooBig', 'denied'] },
        paths: { array: str },
        message: str,
      }),
      str,
    ],
  },
};

const FIXTURES = join(__dirname, '../../../src-tauri/tests/ipc-fixtures');
const files = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();

describe('IPC contract: Rust fixtures against the $lib/api types', () => {
  it('has a spec for every fixture and a fixture for every spec', () => {
    expect(files).toEqual(Object.keys(cases).sort());
  });

  describe.each(files)('%s', (name) => {
    it('every sample matches the type', () => {
      const samples = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as unknown[];
      expect(samples.length).toBeGreaterThan(0);
      const errors: string[] = [];
      // each fixture is an array of samples of the response; the spec describes one response
      samples.forEach((sample, i) => check(cases[name], sample, `${name}#${i}`, errors));
      expect(errors).toEqual([]);
    });
  });

  it('every command the wrappers invoke is in the Rust handler list', () => {
    const lib = readFileSync(join(__dirname, '../../../src-tauri/src/lib.rs'), 'utf8');
    const start = lib.indexOf('generate_handler![');
    const handlers = new Set(
      [...lib.slice(start, start + lib.slice(start).indexOf(']')).matchAll(/::(\w+),?\s*$/gm)].map(
        (m) => m[1],
      ),
    );
    expect(handlers.size).toBeGreaterThan(100);
    const api = join(__dirname);
    const invoked = readdirSync(api)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .flatMap((f) =>
        [...readFileSync(join(api, f), 'utf8').matchAll(/\binvoke(?:<[^(]*>)?\(\s*'(\w+)'/g)].map(
          (m) => `${f}: ${m[1]}`,
        ),
      );
    expect(invoked.length).toBeGreaterThan(100);
    expect(invoked.filter((i) => !handlers.has(i.split(': ')[1]))).toEqual([]);
  });
});
