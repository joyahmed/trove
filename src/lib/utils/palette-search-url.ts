// The web row's whole computation: a settings template with `%s` in it, plus what was typed.
// Kept apart from the source that uses it because this is the only part worth testing — the
// row itself is IPC and rendering, and this is a pure string function.
//
// ⭐ No network call happens here or anywhere before Enter. Typing builds a URL and nothing
// else; there is no autocomplete request, no telemetry, no lookup of any kind.

/**
 * The template with `%s` swapped for the query, percent-encoded.
 *
 * Only the FIRST `%s` is substituted — `String.replace` with a string pattern replaces once —
 * which is deliberate: a template is one query slot, and a second `%s` is a typo, not a second
 * placeholder to fill. A template with no `%s` comes back unchanged; `sanitize` in
 * `state/settings.svelte.ts` is what stops one ever reaching here from the settings file, and
 * returning the template untouched is the harmless answer if one does.
 *
 * `encodeURIComponent` is what makes `&`, `#`, `+`, `/` and `?` in the query stay part of the
 * query instead of becoming URL structure — and because it also encodes `$`, the encoded text
 * can never contain a `$&`-style replacement pattern that `String.replace` would expand.
 */
export const buildSearchUrl = (template: string, query: string): string =>
  template.replace('%s', encodeURIComponent(query));
