// A file extension typed in the palette: `*.pdf` or `.pdf` becomes a row "Search for *.pdf".
// Same words the explorer's search box understands (`utils/search-query.ts`: `*.png`), so the
// text the row hands over is exactly what Enter in that box would take.

/** 1-10 letters or digits, at least one letter: `.2024` is a year, `.7z` and `.mp3` are not. */
const EXTENSION = /^(?=.*[a-z])[a-z0-9]{1,10}$/;

/** The extension (lower case, no dot) when the whole query is `*.ext` or `.ext`, else `null`. */
export const extensionQuery = (text: string): string | null => {
  const t = text.trim().toLowerCase();
  const ext = t.startsWith('*.') ? t.slice(2) : t.startsWith('.') ? t.slice(1) : null;
  return ext !== null && EXTENSION.test(ext) ? ext : null;
};
