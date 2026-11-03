#!/usr/bin/env bash
# Build Trove as a release .app and install it to /Applications on this Mac.
# Run after every merge so the installed copy is what was just built:
#   bash scripts/install-mac.sh
# Uses its own cargo target dir, so it never fights a running `tauri dev`.
set -euo pipefail

[[ "$(uname -s)" == "Darwin" ]] || { echo "install-mac.sh: macOS only" >&2; exit 1; }

repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/trove-target-install}"
hash="$(git rev-parse --short HEAD)"
dirty="$(git status --porcelain --untracked-files=no | head -1)"

# Quit every running RELEASE/installed Trove first, not only the installed one: a copy built
# elsewhere (e.g. the ~/.cache/trove-target-reopen bundle, which has no TroveCommit) keeps the
# hotkey and the single-instance lock, so the new install would open into the old process.
# A `tauri dev` run is NEVER touched: skipped when its executable sits under a `target/debug`
# dir, or when any ancestor process is a dev server (cargo, tauri, bun, node, vite).
# TERM then KILL per pid (an AppleEvent quit by bundle id could reach the dev copy).
# TROVE_QUIT_DRY=1 only prints what would be quit; TROVE_QUIT_ONLY=1 runs just this step.
is_dev_trove() { # $1 = pid; true (0) for a `tauri dev` run
  local pid="$1" exe cur="$1" name
  exe="$(ps -o comm= -p "$pid" 2>/dev/null || true)"
  [[ "$exe" == */target/debug/* ]] && return 0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do # walk the parent chain
    cur="$(ps -o ppid= -p "$cur" 2>/dev/null | tr -d ' ')"
    [[ -n "$cur" && "$cur" -gt 1 ]] || return 1
    name="$(ps -o comm= -p "$cur" 2>/dev/null || true)"
    name="${name##*/}"
    case "$name" in cargo | cargo-tauri | tauri | bun | bunx | node | vite) return 0 ;; esac
  done
  return 1
}
release_pids() { # pids of running Troves that are not a dev run
  local pid
  for pid in $(pgrep -ix trove || true); do
    if is_dev_trove "$pid"; then
      echo "Skipping dev Trove $pid ($(ps -o comm= -p "$pid" 2>/dev/null))" >&2
    else
      echo "$pid"
    fi
  done
}
alive() { local p; for p in "$@"; do kill -0 "$p" 2>/dev/null && return 0; done; return 1; }
wait_gone() { # $1 = tries of 0.5 s, then the pids
  local tries="$1"
  shift
  for ((i = 0; i < tries; i++)); do
    alive "$@" || return 0
    sleep 0.5
  done
  ! alive "$@"
}
quit_troves() {
  local pids
  # shellcheck disable=SC2207
  pids=($(release_pids))
  if ((${#pids[@]} == 0)); then
    echo "No release Trove running."
    return 0
  fi
  for p in "${pids[@]}"; do echo "Quitting Trove $p: $(ps -o comm= -p "$p" 2>/dev/null)"; done
  if [[ "${TROVE_QUIT_DRY:-}" == 1 ]]; then
    echo "(dry run: nothing quit)"
    return 0
  fi
  kill -TERM "${pids[@]}" 2>/dev/null || true
  wait_gone 20 "${pids[@]}" || { kill -KILL "${pids[@]}" 2>/dev/null || true; wait_gone 10 "${pids[@]}" || true; }
  if alive "${pids[@]}"; then
    echo "install-mac.sh: Trove still running (${pids[*]})" >&2
    return 1
  fi
  echo "All release Trove processes quit."
}
[[ "${TROVE_QUIT_ONLY:-}" == 1 ]] && { quit_troves; exit; }

echo "Building Trove at $hash${dirty:+ (with uncommitted changes)}..."
bun install --frozen-lockfile >/dev/null
bun run tauri build --bundles app

app="$CARGO_TARGET_DIR/release/bundle/macos/Trove.app"
[[ -d "$app" ]] || { echo "install-mac.sh: no bundle at $app" >&2; exit 1; }

quit_troves

rm -rf /Applications/Trove.app
ditto "$app" /Applications/Trove.app
# record which commit is installed, readable with: defaults read /Applications/Trove.app/Contents/Info TroveCommit
/usr/libexec/PlistBuddy -c "Add :TroveCommit string $hash" /Applications/Trove.app/Contents/Info.plist 2>/dev/null ||
  /usr/libexec/PlistBuddy -c "Set :TroveCommit $hash" /Applications/Trove.app/Contents/Info.plist
codesign --force --deep --sign - /Applications/Trove.app >/dev/null 2>&1 || true

echo "Installed /Applications/Trove.app at $hash."
