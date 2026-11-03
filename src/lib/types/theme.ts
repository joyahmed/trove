// Mirrors src-tauri/src/core/theme.rs (serde camelCase). Change both or neither.

export interface SystemTheme {
  /** `#rrggbb` — the Windows accent colour */
  accent: string;
  /** Settings → Personalization → Colors → Transparency effects. Dormant: no window asks for
   *  `windowEffects`, so nothing acts on this — see `src-tauri/src/core/theme.rs`. */
  transparency: boolean;
  /** Settings → Accessibility → Text size, as a factor (1 = 100 %) */
  textScale: number;
}
