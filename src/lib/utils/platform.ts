// The OS Trove runs on (the host) and the words it shows. Rust injects the host facts
// (`core/shell.rs`, `platform_init_script`, now read via `platform-facts.ts`) before any page
// script runs. Two axes (plan 19): `onMac` / `onWindows` / icons / protocol are the HOST; the
// words (`binName`, `propertiesLabel`, `thisPcLabel`) follow the "I'm coming from" STYLE, read at
// call time, so a settings change renames them without a restart.
// Off Tauri (tests, a plain browser) nothing is set and Windows applies.
import { comingFrom, type OsStyle } from '$lib/state/coming-from.svelte';
import { injected, type TrovePlatform } from '$lib/utils/platform-facts';

export { injected, type TrovePlatform };

/** Every name This PC goes by. ⛔ The parser accepts all three on every OS (B.2.2), so a label
 * outside this list is refused rather than shown, or `parseLocation(locationText(THIS_PC))`
 * would stop round-tripping. */
export const THIS_PC_LABELS = ['This PC', 'This Mac', 'This Computer'] as const;

/**
 * Whether a file's icon is drawn by Trove (by category, `data/file-categories.ts`) rather than
 * asked of the shell. Only off Windows: the shell icon is a stub there (`icons.rs`, plan 14).
 * Off Tauri nothing is injected and Windows' behaviour applies, like every switch in this file.
 */
export const drawnFileIcons = (platform: TrovePlatform | undefined = injected()): boolean =>
  platform !== undefined && platform.os !== 'windows';

/**
 * The origin a custom protocol (`icon`, `preview`) is served from. ⛔ Not the same string on every
 * OS: Tauri 2 maps `<scheme>://` to `http://<scheme>.localhost` on Windows (and Android) and to
 * `<scheme>://localhost` everywhere else. The Windows form was hard-coded, so off Windows every
 * icon and preview request went to an address no handler answers, and the preview pane could not
 * have worked at all. Found 2026-10-02 reading plan 14's traps; the Mac look confirms it.
 * Off Tauri nothing is injected and Windows' form applies, like every switch in this file.
 */
export const protocolOrigin = (
  scheme: string,
  platform: TrovePlatform | undefined = injected(),
): string =>
  platform === undefined || platform.os === 'windows'
    ? `http://${scheme}.localhost`
    : `${scheme}://localhost`;

/** Windows, or nothing injected (tests, a plain browser): every switch here defaults to Windows. */
export const onWindows = (platform: TrovePlatform | undefined = injected()): boolean =>
  platform === undefined || platform.os === 'windows';

/** The Microsoft Store (MSIX) build (plan 22). Off Tauri, or a build that sends no channel, it
 * is the direct download. */
export const storeBuild = (platform: TrovePlatform | undefined = injected()): boolean =>
  platform?.channel === 'msstore';

/** A build that updates itself (plan 22.5): the cargo feature `updater` on a GitHub download.
 * Off Tauri, in the Store build and in every build without the feature, false: no update line. */
export const selfUpdates = (platform: TrovePlatform | undefined = injected()): boolean =>
  platform?.updater === true;

/** A build that reads RAR (plan 16 phase 5): the cargo feature `rar`, on by default. Off Tauri
 * and in a build without it (a distro that ships only OSI code), false: no RAR row anywhere. */
export const readsRar = (platform: TrovePlatform | undefined = injected()): boolean =>
  platform?.rar === true;

/** A Mac build. Off Tauri nothing is injected and Windows' chords apply, like every switch here. */
export const onMac = (platform: TrovePlatform | undefined = injected()): boolean =>
  platform?.os === 'macos';

/** What the details command is called: "Properties" in Windows and Linux style, Finder's
 * "Get Info" in Mac style. Style, not host (plan 19). */
export const propertiesLabel = (style: OsStyle = comingFrom.style): string =>
  style === 'mac' ? 'Get Info' : 'Properties';

/**
 * What the place that holds deleted files is called: "Recycle Bin" in Windows style, "Trash" in
 * Mac and Linux style. ⛔ Only the words: its key is still `recycle-bin` (a stored tab or setting
 * uses the key, and the address parser accepts both names on every OS, like This PC's three),
 * and what the bin can do (restore or not) is the host's, not this word's.
 */
export const binName = (style: OsStyle = comingFrom.style): string =>
  style === 'windows' ? 'Recycle Bin' : 'Trash';

const LAUNCH_BY_STYLE: Record<OsStyle, string> = {
  // the Start menu / Explorer word for running a program (plan 17)
  windows: 'Start',
  // Finder's and the Dock's: an app is opened like any other item
  mac: 'Open',
  // GNOME's app grid and Nautilus say "Open" for an app too
  linux: 'Open',
};

/** The menu verb that runs an app in the Applications place: "Start" in Windows style, "Open" in
 * Mac and Linux style. Style, not host (plan 19): it is a word, the launch is the same. */
export const launchLabel = (style: OsStyle = comingFrom.style): string => LAUNCH_BY_STYLE[style];

/**
 * A sentence from Rust, in the chosen style's bin word (plan 19 Q3 / 3.2). Rust names the host's
 * real bin ("Trove needs Full Disk Access to show the Trash"); with "coming from Windows" picked
 * that must read "Recycle Bin". Only the bin as a noun is rewritten — after "the", "a" or "no" —
 * so a file named "Trash.txt" quoted in the same sentence keeps its name. Display time, so a
 * settings change renames a message already on screen.
 */
export const inBinWords = (text: string, style: OsStyle = comingFrom.style): string =>
  text.replace(
    /\b(the|a|no) (Recycle Bin|Trash)\b/gi,
    (_m, article: string) => `${article} ${binName(style)}`,
  );

/** An Ubuntu (Linux) build. Off Tauri nothing is injected and Windows applies. */
export const onLinux = (platform: TrovePlatform | undefined = injected()): boolean =>
  platform?.os === 'linux';

/** The menu verb: Finder says "Move to Trash" for an app; Windows and Linux "Uninstall". The verb
 * is the HOST's (it names what this machine will actually do, plan 18); the bin word in it is the
 * STYLE's (plan 19): "Move to Recycle Bin" with Windows picked. */
export const uninstallVerb = (
  platform: TrovePlatform | undefined = injected(),
  style: OsStyle = comingFrom.style,
): string => (onMac(platform) ? `Move to ${binName(style)}` : 'Uninstall');

const THIS_PC_BY_STYLE: Record<OsStyle, (typeof THIS_PC_LABELS)[number]> = {
  windows: 'This PC',
  mac: 'This Mac',
  linux: 'This Computer',
};

/** "This PC" in Windows style, "This Mac" in Mac style, "This Computer" in Linux style. With the
 * choice on 'native', Rust's injected name answers (refused if the parser would not read it back). */
export const thisPcLabel = (style?: OsStyle): string => {
  if (style === undefined && comingFrom.choice === 'native') {
    const label = injected()?.thisPcLabel;
    const known = THIS_PC_LABELS.find((l) => l === label);
    if (known) return known;
  }
  return THIS_PC_BY_STYLE[style ?? comingFrom.style];
};
