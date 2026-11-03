// The "Customize context menu…" dialog's state: open or not, and the row being edited. The
// commands themselves live in settings; this only edits a draft and writes it back.
import { spotlightApps } from '$lib/api/palette';
import { detectCommonCommands, resolveCustomProgram } from '$lib/api/shell-verbs';
import { confirm } from '$lib/state/confirm.svelte';
import { settings } from '$lib/state/settings.svelte';
import type { AppEntry } from '$lib/types/palette';
import type { CommandScope, CustomCommand, DetectedApp } from '$lib/types/shell-verbs';
import { toDraft } from '$lib/utils/app-pick';
import { newCommandId } from '$lib/utils/custom-commands';

/** Either slash: a detected program is a full path, a hand-typed one is usually a bare name. */
const SEP = /[\\/]/;

/** The executable a command runs, stripped to something two spellings of it can be compared by. */
const stemOf = (program: string) =>
  (program.split(SEP).pop() ?? program)
    .replace(/\.exe$/i, '')
    .trim()
    .toLowerCase();

/** Everything two entries are compared by; the label and the id are not part of it. */
type Comparable = { program: string; args: string; scope: readonly CommandScope[] };

/**
 * Where a command appears, as a **set**: `['folder','file']` and `['file','folder']` are one
 * scope, and a repeat says nothing. `wsl` is in here like any other member, which is the point —
 * a `wsl`-scoped command is not the same command as a `file, folder` one.
 */
const scopeKey = (scope: readonly CommandScope[]) => [...new Set(scope)].sort().join(',');

/**
 * Same executable, same argument line. This used to be the whole test, and it is a resemblance
 * rather than an identity: it says nothing about where the two entries appear.
 */
const sameProgramAndArgs = (a: Comparable, b: Comparable) =>
  stemOf(a.program) === stemOf(b.program) && a.args.trim() === b.args.trim();

/** …and the same scope. Only then would adding the detected entry duplicate a row you have. */
const sameCommand = (a: Comparable, b: Comparable) =>
  sameProgramAndArgs(a, b) && scopeKey(a.scope) === scopeKey(b.scope);

/** One detected entry as the strip offers it, with what the person already has said out loud. */
export interface Suggestion {
  found: DetectedApp;
  /** the person has a command that runs this same program the same way, but scoped differently */
  similar: boolean;
}

/** The arguments a new draft starts with; still this = the person has not typed any. */
const BLANK_ARGS = '%path%';

const blank = (): CustomCommand => ({
  id: newCommandId(),
  label: '',
  program: '',
  args: BLANK_ARGS,
  scope: ['file', 'folder'],
});

class CustomizeState {
  open = $state(false);
  /** the command being edited (a copy), or null while the list is showing */
  draft = $state<CustomCommand | null>(null);
  /** what this machine could run, from `detect_common_commands`; null until asked */
  detected = $state<DetectedApp[] | null>(null);
  detecting = $state(false);
  /**
   * What the draft's program resolves to: the full path, `null` when nothing would run, or
   * `undefined` while it is still being looked up. It belongs to `resolvedFor` only.
   */
  resolved = $state<string | null | undefined>(undefined);
  /** the trimmed program `resolved` answers for */
  resolvedFor = $state('');
  /** the installed apps the Program box suggests (`spotlight_apps`); null until loaded */
  apps = $state<AppEntry[] | null>(null);
  /** the program a pick just wrote: the list stays shut until the box says something else */
  pickedProgram = $state<string | null>(null);
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** the label the last pick wrote by itself; a label still equal to it was not typed by hand */
  #autoLabel = '';
  /** the arguments the last pick wrote by itself; arguments still equal to it were not typed */
  #autoArgs = '';

  show() {
    this.open = true;
    this.draft = null;
    this.pickedProgram = null;
    void this.detect();
    void this.loadApps();
  }

  /**
   * The app list, once per dialog session (Rust caches it too). Failure only costs the
   * suggestions: the Program box still takes a typed name, as it always did.
   */
  async loadApps() {
    if (this.apps !== null) return;
    try {
      this.apps = await spotlightApps();
    } catch {
      this.apps = [];
    }
  }

  /**
   * Fill the draft from a picked app. The program always; the arguments when the person has not
   * typed any (empty, or the untouched `%path%` a new draft starts with — a Mac pick NEEDS its
   * `-a "<bundle>"`), and otherwise their text with that required part put in front; the label
   * when empty or still the one an earlier pick wrote (never over a label typed by hand). A blocked app (no `openWith`) changes nothing.
   * ⛔ Picking does not bypass the check: the program is looked up again, and Save waits for it.
   */
  pickApp(app: AppEntry): boolean {
    const d = this.draft;
    if (!d) return false;
    const fill = toDraft(app);
    if ('blocked' in fill) return false;
    d.program = fill.program;
    const args = d.args.trim();
    if (args === '' || args === BLANK_ARGS || args === this.#autoArgs) d.args = fill.args;
    else {
      // typed arguments stay, but the part the app cannot run without (the Mac `-a "<bundle>"`,
      // everything before the first `%token%`) goes in front of them unless it is already there
      const need = fill.args.split('%')[0].trim();
      if (need !== '' && !args.includes(need)) d.args = `${need} ${args}`;
    }
    const label = d.label.trim();
    if (label === '' || label === this.#autoLabel) {
      this.#autoLabel = `Open with ${app.name}`;
      d.label = this.#autoLabel;
    }
    this.#autoArgs = d.args.trim() === fill.args.trim() ? fill.args.trim() : '';
    this.pickedProgram = fill.program;
    void this.resolveNow(fill.program);
    return true;
  }

  /**
   * Ask Rust what is installed. Failure is not worth a dialog: the person can still type a
   * command by hand, which is exactly what they did before this existed.
   */
  async detect() {
    if (this.detecting) return;
    this.detecting = true;
    try {
      this.detected = await detectCommonCommands();
    } catch {
      this.detected = [];
    } finally {
      this.detecting = false;
    }
  }

  /**
   * The detected entries worth offering, each told whether the person already has something like
   * it. **Surface, do not suppress.**
   *
   * ⚠️ Matching on the generated id alone is not enough, and the first version got this wrong:
   * a hand-typed "Open with Code (WSL)" carries its own random id, so the identical command was
   * offered again right above itself. Hence the FILE STEM comparison — a detected entry carries
   * a full path, a hand-typed one is usually the bare name.
   *
   * ⛔ But "same program, same args" then went too far the other way, and hid the very thing the
   * person needed to see. Measured against a real settings file: two hand-typed Zed rows, both
   * `zed %path%` and neither scoped like the detected entry, between them hid the one correct
   * Zed detection — so a *broken* command silently suppressed its own replacement. Hiding is
   * only safe when the row really would be a duplicate, so the comparison now includes the
   * SCOPE, and anything short of an exact match is **shown, marked `similar`**, for the person
   * to compare against their own. An exact match on program, arguments and scope stays hidden:
   * that button would add a byte-for-byte copy of a row already in the list, which is the
   * duplicate the id note above is about.
   */
  get suggestions(): Suggestion[] {
    const mine = settings.customCommands;
    return (this.detected ?? [])
      .filter((d) => !mine.some((c) => c.id === d.id || sameCommand(c, d)))
      .map((found) => ({ found, similar: mine.some((c) => sameProgramAndArgs(c, found)) }));
  }

  /** Add one detected entry as-is. It keeps the detected id, which is what makes it stay added. */
  addDetected(found: DetectedApp) {
    if (settings.customCommands.some((c) => c.id === found.id)) return;
    settings.customCommands.push({
      id: found.id,
      label: found.label,
      program: found.program,
      args: found.args,
      scope: [...found.scope],
    });
  }

  close() {
    this.open = false;
    this.draft = null;
  }

  add() {
    this.#autoLabel = '';
    this.#autoArgs = '';
    this.draft = blank();
    this.pickedProgram = null;
  }

  edit(command: CustomCommand) {
    this.#autoLabel = '';
    this.#autoArgs = '';
    this.draft = { ...command, scope: [...command.scope] };
    // an existing command's program is not a question: no list until it is edited
    this.pickedProgram = command.program;
  }

  /** Asks first: a command is typed by hand and there is no undo. */
  async remove(id: string) {
    const command = settings.customCommands.find((c) => c.id === id);
    if (!command) return;
    const ok = await confirm.ask({
      title: 'Remove command',
      message: `Remove "${command.label}" from the context menu?`,
      okLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    settings.customCommands = settings.customCommands.filter((c) => c.id !== id);
  }

  toggleScope(scope: CommandScope) {
    if (!this.draft) return;
    const i = this.draft.scope.indexOf(scope);
    if (i >= 0) this.draft.scope.splice(i, 1);
    else this.draft.scope.push(scope);
  }

  /**
   * Look the program up after a pause in typing, so each keystroke is not a disk walk. The form
   * calls this whenever the program box changes; asking again for the same text is free.
   */
  queueResolve(program: string, delayMs = 250) {
    const name = program.trim();
    if (name === this.resolvedFor && this.resolved !== undefined) return;
    clearTimeout(this.#timer);
    this.resolvedFor = name;
    this.resolved = undefined;
    if (name === '') {
      this.resolved = null;
      return;
    }
    this.#timer = setTimeout(() => void this.resolveNow(name), delayMs);
  }

  /** Look the program up now. A reply for text the person has since changed is dropped. */
  async resolveNow(program: string) {
    const name = program.trim();
    clearTimeout(this.#timer);
    this.resolvedFor = name;
    this.resolved = undefined;
    let found: string | null;
    try {
      found = name === '' ? null : await resolveCustomProgram(name);
    } catch {
      found = null;
    }
    if (this.resolvedFor === name) this.resolved = found;
  }

  /**
   * false when the draft is not worth keeping: no program, or one nothing on this machine would
   * start. ⚠️ Only saving is gated — a command saved before this check still runs.
   */
  get draftValid() {
    if (this.draft === null) return false;
    const name = this.draft.program.trim();
    return name !== '' && this.resolvedFor === name && typeof this.resolved === 'string';
  }

  save() {
    const d = this.draft;
    if (!d || !this.draftValid) return;
    const clean: CustomCommand = {
      ...d,
      label: d.label.trim() || d.program.trim(),
      program: d.program.trim(),
      scope: [...d.scope],
    };
    const i = settings.customCommands.findIndex((c) => c.id === clean.id);
    if (i >= 0) settings.customCommands[i] = clean;
    else settings.customCommands.push(clean);
    this.draft = null;
  }

  cancelEdit() {
    this.draft = null;
  }

  /** The line the draft would run, with the program as it resolved and the arguments as typed. */
  get commandLine() {
    const exe = this.resolved;
    if (!this.draft || typeof exe !== 'string') return '';
    const program = /\s/.test(exe) ? `"${exe}"` : exe;
    const args = this.draft.args.trim();
    return args ? `${program} ${args}` : program;
  }
}

export const customize = new CustomizeState();
