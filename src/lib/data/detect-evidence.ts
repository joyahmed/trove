// How a detected app was found, in words. One map for both surfaces that show a detected app
// (the Customize dialog's suggestion strip and the Settings "Apps" section), so the two can
// never disagree about the same app. A guess must read as a guess.
import type { DetectedApp, DetectSource } from '$lib/types/shell-verbs';

export const DETECT_EVIDENCE: Record<DetectSource, string> = {
  'app-paths': 'registered by its installer',
  'start-menu': 'found in the Start menu',
  path: 'found on your PATH',
  'known-dir': 'found where it usually installs',
  'wsl-distro': 'needs the Remote-WSL extension in your distro',
  'desktop-entry': 'found in your app menu',
};

/** The evidence line for one detected app; an uncertain one says so out loud. */
export const evidenceFor = (found: Pick<DetectedApp, 'source' | 'certain'>): string =>
  found.certain
    ? DETECT_EVIDENCE[found.source]
    : `${DETECT_EVIDENCE[found.source]} · a guess, check it works`;
