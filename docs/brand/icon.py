# Trove's app icon: a Windows-yellow two-tone folder filling the canvas, with a faceted
# accent-blue gem sitting in it — the trove. Drawn 4x and downsampled to 1024 px.
#
# THIS FILE IS THE SOURCE OF TRUTH. There is no SVG for this mark and there never was
# (docs/brand/trove.svg belongs to a different, rejected mark — see the banner in it).
# The 1024 master is not hand-art: it is this script's output, reproducible exactly.
#
# Regenerate every app asset:
#   python docs/brand/icon.py docs/brand/trove-icon-1024.png
#   bunx tauri icon docs/brand/trove-icon-1024.png -o src-tauri/icons
#   rm -rf src-tauri/icons/android src-tauri/icons/ios   # this repo ships Windows/NSIS only
#   python -c "from PIL import Image; Image.open('docs/brand/trove-icon-1024.png').convert('RGBA').resize((128,128), Image.LANCZOS).save('static/favicon.png')"
#
# Determinism, measured 2026-09-26 on Pillow 11.3.0 / CPython 3.9: rerunning this script
# reproduced the committed master with 0 of 1048576 pixels differing, and `tauri icon`
# then reproduced every committed PNG and icon.ico byte-for-byte. Only icon.icns differs,
# and only in member ORDER (ic11 before ic09, same total length, same images) — a
# tauri-CLI version artefact on a file this repo does not ship.
#
# ── THEN FORCE THE WINDOWS RESOURCE TO REBUILD, OR YOU WILL SHIP THE OLD ICON ─────────
#   rm -rf src-tauri/target/*/build/trove-*
#   rm -f src-tauri/target/release/trove.exe src-tauri/target/release/trove.pdb
#   bun run build:exe
#
# tauri_build::build() emits rerun-if-changed for tauri.conf.json and capabilities and
# nothing else. Emitting any such directive switches off cargo's default "re-run if any
# file in the package changed", so src-tauri/icons/ is watched by NOTHING: edit icon.ico
# alone and cargo keeps the stale build-script output (out/resource.lib, with the previous
# icon baked in) and relinks it into a brand-new binary. The build is green, the on-disk
# hashes agree, and the exe carries the old mark. This has already shipped once (c14d2c9).
# `cargo clean -p trove` is NOT enough — measured: it removed 8.6 GiB and still left
# target/*/build/trove-*/out/resource.lib. Delete those paths by hand, as above.
#
# Then prove it from the ARTEFACT, never from the PNGs on disk: parse trove.exe's PE
# resource directory, pull the RT_ICON entries, and check they are byte-identical to
# src-tauri/icons/icon.ico's entries. The tray icon is separate — tray.rs embeds
# icons/32x32.png via include_image!, which stores it DECODED, so the PNG bytes are not
# in the binary; the whole 32*32*4 = 4096-byte RGBA buffer is contiguous in .rdata, so
# match that and then measure it. A flat-colour probe is not sufficient for this mark:
# at 32 px the gem is 59 antialiased pixels with no single-colour run longer than 2 px.
#
# ── WHY THIS MARK, AND WHAT WAS TRIED INSTEAD ────────────────────────────────────────
#
# Joy chose this mark on 2026-09-26 over everything that replaced it. Four passes of
# redesign (095d107 → 0518d0a → e55ba38) were all rejected in favour of the original.
# The full record of what those passes tried, measured, and learned — including three
# rejected tones with WCAG contrast numbers on both Windows 11 taskbar grounds, and the
# note that a literal chest silhouette reads as a bread loaf and a table lamp — is kept
# in docs/brand/trove.svg. READ IT BEFORE PROPOSING A REDESIGN. Do not repeat those
# passes; they are expensive and they have already been run.
#
# The short version of what THIS mark answers:
#   • It fills ~90 % of the canvas (52 → 972 px), matching Windows' own icons, so it does
#     not read small beside them. An earlier cut used ~70 % and looked shrunken.
#   • It is a FOLDER, the thing the app is about, not an abstraction of one. Every attempt
#     to abstract it (a notched keep, a chest) lost the referent.
#   • The gem is the mark: a brilliant cut in three blues with a glint, its crown showing
#     above the front panel — the thing a trove holds. Blue against the folder's gold is
#     the highest-contrast pairing available, so the gem survives to 16 px as a blue chip
#     even when its facets do not.
#   • The gem also solves the taskbar-contrast problem that cost the notched-box lineage
#     three tones: the gold does not have to carry the mark alone, so it can stay at the
#     app's own folder value instead of being darkened until it reads as cardboard.
#
# Verified at 512 / 256 / 128 / 64 / 32 / 16 px on dark (#202020) and light (#f3f3f3):
# the gem stays a blue mark at 16 px.

import sys

from PIL import Image, ImageDraw, ImageFilter

OUT = sys.argv[1]
S = 4096
u = S / 1024
BACK = (226, 158, 42, 255)
FRONT = (255, 204, 77, 255)
FRONT_TOP = (255, 221, 120, 255)
GEM_DARK = (0, 84, 160, 255)
GEM = (0, 120, 212, 255)
GEM_LIGHT = (86, 176, 255, 255)
GEM_GLINT = (210, 236, 255, 255)


def rr(draw, box, r, fill):
    draw.rounded_rectangle(box, radius=r, fill=fill)


def gem(draw, cx, cy, w, h):
    """A brilliant-cut gem seen from the front: a flat table, a crown band, a pavilion point."""
    # outline points (x offsets in halves of w, y offsets in halves of h)
    top_y = cy - h / 2
    girdle_y = cy - h * 0.08
    bottom_y = cy + h / 2
    table_l, table_r = cx - w * 0.28, cx + w * 0.28
    gird_l, gird_r = cx - w / 2, cx + w / 2
    # pavilion (lower) in the darkest blue
    draw.polygon([(gird_l, girdle_y), (gird_r, girdle_y), (cx, bottom_y)], fill=GEM_DARK)
    # pavilion facets: two lighter triangles
    draw.polygon([(gird_l, girdle_y), (cx - w * 0.16, girdle_y), (cx, bottom_y)], fill=GEM)
    draw.polygon([(cx + w * 0.16, girdle_y), (gird_r, girdle_y), (cx, bottom_y)], fill=GEM)
    # crown band
    draw.polygon([(table_l, top_y), (table_r, top_y), (gird_r, girdle_y), (gird_l, girdle_y)], fill=GEM)
    # crown side facets
    draw.polygon([(table_l, top_y), (gird_l, girdle_y), (cx - w * 0.16, girdle_y)], fill=GEM_LIGHT)
    draw.polygon([(table_r, top_y), (gird_r, girdle_y), (cx + w * 0.16, girdle_y)], fill=GEM_DARK)
    # table (the flat top)
    draw.polygon([(table_l, top_y), (table_r, top_y), (cx + w * 0.16, girdle_y), (cx - w * 0.16, girdle_y)], fill=GEM_LIGHT)
    # glint
    draw.polygon([(table_l + w * 0.06, top_y + h * 0.05), (table_l + w * 0.2, top_y + h * 0.05), (table_l + w * 0.1, top_y + h * 0.16)], fill=GEM_GLINT)


img = Image.new('RGBA', (S, S), (0, 0, 0, 0))

# drop shadow, tight and low
sh = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(sh)
rr(d, (52 * u, 300 * u, 972 * u, 940 * u), 110 * u, (0, 0, 0, 110))
sh = sh.filter(ImageFilter.GaussianBlur(16 * u))
img.alpha_composite(sh)

d = ImageDraw.Draw(img)
# back panel: a left tab joined to the body — the folder fills ~90 % of the canvas
rr(d, (52 * u, 150 * u, 430 * u, 400 * u), 72 * u, BACK)   # tab
rr(d, (52 * u, 250 * u, 972 * u, 920 * u), 110 * u, BACK)  # body

# the gem sits in the folder: its upper half shows above the front panel
gem(d, 512 * u, 420 * u, 420 * u, 360 * u)

# front panel, lower, so a band of the back and the gem's top show
rr(d, (52 * u, 470 * u, 972 * u, 920 * u), 110 * u, FRONT)
# lighter lip along the front's top edge
rr(d, (52 * u, 470 * u, 972 * u, 552 * u), 44 * u, FRONT_TOP)
d.rectangle((52 * u, 520 * u, 972 * u, 552 * u), fill=FRONT)

out = img.resize((1024, 1024), Image.LANCZOS)
out.save(OUT)
print('saved', OUT, out.size)
