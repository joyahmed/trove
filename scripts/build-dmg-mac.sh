#!/usr/bin/env bash
# Build Trove's Mac .dmg WITHOUT Tauri's dmg bundler (it scripts Finder over AppleScript, which
# opens windows and fails headless). Builds the .app with tauri, then packs it with hdiutil.
#   bash scripts/build-dmg-mac.sh [--universal] [--out DIR] [--allow-dirty]
# Output: <out>/Trove-<shorthash>[-dirty].dmg (default out: dist-mac). Ad-hoc signed, never notarized.
# Does not install, open or mount anything. Honors CARGO_TARGET_DIR (plan 22.4).
set -euo pipefail

[[ "$(uname -s)" == "Darwin" ]] || { echo "build-dmg-mac.sh: macOS only" >&2; exit 1; }

repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"

universal=0
allow_dirty=0
out="$repo/dist-mac"
while (($# > 0)); do
  case "$1" in
    --universal) universal=1 ;;
    --allow-dirty) allow_dirty=1 ;;
    --out)
      [[ $# -ge 2 ]] || { echo "build-dmg-mac.sh: --out needs a directory" >&2; exit 2; }
      out="$2"
      shift
      ;;
    *) echo "usage: build-dmg-mac.sh [--universal] [--out DIR] [--allow-dirty]" >&2; exit 2 ;;
  esac
  shift
done

hash="$(git rev-parse --short HEAD)"
dirty="$(git status --porcelain --untracked-files=no | head -1)"
if [[ -n "$dirty" && $allow_dirty -eq 0 ]]; then
  echo "build-dmg-mac.sh: tree has uncommitted changes; commit them or pass --allow-dirty" >&2
  exit 1
fi

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$repo/src-tauri/target}"
# Release builds drop build-machine paths from the binary (plan 22.0.4).
CARGO_ENCODED_RUSTFLAGS="$(bun scripts/remap-flags.ts --encoded)"
export CARGO_ENCODED_RUSTFLAGS

args=(--bundles app --config '{"bundle":{"macOS":{"signingIdentity":"-"}}}')
tdir="$CARGO_TARGET_DIR/release"
if ((universal)); then
  args+=(--target universal-apple-darwin)
  tdir="$CARGO_TARGET_DIR/universal-apple-darwin/release"
fi

echo "Building Trove at $hash${dirty:+ (with uncommitted changes)}..."
bun install --frozen-lockfile >/dev/null
bun run tauri build "${args[@]}"

app="$tdir/bundle/macos/Trove.app"
[[ -d "$app" ]] || { echo "build-dmg-mac.sh: no bundle at $app" >&2; exit 1; }

work="$(mktemp -d "${TMPDIR:-/tmp}/trove-dmg.XXXXXX")"
mnt=""
trap '[[ -n "${mnt:-}" ]] && hdiutil detach "$mnt" -force >/dev/null 2>&1; rm -rf "$work"' EXIT
stage="$work/stage"
mkdir -p "$stage" "$out"
ditto "$app" "$stage/Trove.app"
# stamp the commit, readable with: defaults read Trove.app/Contents/Info TroveCommit
plist="$stage/Trove.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :TroveCommit string $hash" "$plist" 2>/dev/null ||
  /usr/libexec/PlistBuddy -c "Set :TroveCommit $hash" "$plist"
# stamping breaks the seal, so re-sign ad-hoc
codesign --force --deep --sign - "$stage/Trove.app" >/dev/null ||
  { echo "build-dmg-mac.sh: re-sign failed" >&2; exit 1; }
# no build-machine path may be left in the binary (plan 22.0.4)
bun scripts/path-leak-check.ts "$stage/Trove.app/Contents/MacOS/trove" ||
  { echo "build-dmg-mac.sh: binary carries a build-machine path" >&2; exit 1; }
ln -s /Applications "$stage/Applications"

dmg="$out/Trove-$hash${dirty:+-dirty}.dmg"
rm -f "$dmg"
hdiutil create -volname Trove -srcfolder "$stage" -ov -format UDZO "$dmg" >/dev/null

echo "dmg:    $dmg"
echo "size:   $(du -h "$dmg" | cut -f1) ($(stat -f %z "$dmg") bytes)"
echo "sha256: $(shasum -a 256 "$dmg" | cut -d' ' -f1)"
hdiutil imageinfo "$dmg" | grep -E '^(Format|Format Description|Checksum Type|Size):' || true

# check the signature on the app as it sits inside the image
mnt="$work/mnt"
mkdir -p "$mnt"
hdiutil attach "$dmg" -nobrowse -readonly -noautoopen -mountpoint "$mnt" >/dev/null
sig="$(codesign -dv "$mnt/Trove.app" 2>&1 || true)"
hdiutil detach "$mnt" >/dev/null
mnt=""
echo "$sig" | grep -E 'Signature|Identifier' || true
echo "$sig" | grep -q "Signature=adhoc" || { echo "build-dmg-mac.sh: app is not ad-hoc signed" >&2; exit 1; }
