// "Extract all…" asks for a destination folder. No native folder picker is in this build (no
// dialog plugin), so the app's own text prompt takes the path; this is its syntax check. Whether
// the folder exists is asked of Rust afterwards (`pathKind`), since only it can look.

/** `null` when `text` could name a folder to extract into, else the reason shown under the box. */
export const destinationProblem = (text: string): string | null => {
  const path = text.trim();
  if (path === '') return 'Type the folder to extract into.';
  if (path.includes('\u0000')) return 'That is a place inside an archive, not a folder.';
  const absolute = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\');
  if (!absolute) return 'Type the full path, like C:\\Backups or /media/stick.';
  return null;
};
