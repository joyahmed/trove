// A stable DOM id for a file-list row, so the grid can name its focused row in
// `aria-activedescendant` (the rows themselves never take focus). Same path, same id.

/** `row-` plus two 32-bit string hashes of the path in base 36: unique enough for one list. */
export const rowId = (path: string): string => {
  let a = 5381;
  let b = 52711;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    a = (Math.imul(a, 33) ^ c) >>> 0;
    b = (Math.imul(b, 31) + c) >>> 0;
  }
  return `row-${a.toString(36)}${b.toString(36)}`;
};
