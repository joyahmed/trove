// WCAG 2.x contrast, for picking the text colour that sits on a custom accent.

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** Relative luminance (0 black .. 1 white) of a `#rrggbb` colour; null for anything else. */
export const luminance = (hex: string): number | null => {
  const m = HEX.exec(hex);
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio (1..21) between two `#rrggbb` colours; null if either is not one. */
export const contrastRatio = (a: string, b: string): number | null => {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** `#fff` or `#000`, whichever reads better on `accent`; white when `accent` is not a colour. */
export const textOnAccent = (accent: string): '#fff' | '#000' => {
  const white = contrastRatio(accent, '#ffffff');
  const black = contrastRatio(accent, '#000000');
  return white !== null && black !== null && black > white ? '#000' : '#fff';
};
