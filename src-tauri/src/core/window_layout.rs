//! Where Trove puts its own windows (plan 20): Windows' Snap for one window, and Cascade /
//! Show windows stacked / Show windows side by side for all of them. Pure: a monitor's work
//! area in, rects out, all in PHYSICAL px like `core::session`'s `Bounds` and `Screen`.
//!
//! ⛔ Never smaller than [`MIN_SIZE`] at the monitor's scale. A layout that cannot fit its
//! windows at that size wraps into a grid (stacked, side by side) or starts the cascade over at
//! the corner; a cell still too small keeps the minimum and the windows overlap, each pulled in
//! so it stays on the work area.

use serde::Deserialize;

use crate::core::session::{pull_in, Bounds, Screen, DEFAULT_SIZE, MIN_SIZE};

/// One half of a monitor.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Side {
    Left,
    Right,
}

/// The four Snap keys (Win+arrows on Windows; ⌃⌥+arrows on a Mac coming from Windows).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SnapKey {
    Left,
    Right,
    Up,
    Down,
}

/// Windows' taskbar menu, for every Trove window at once.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Layout {
    Cascade,
    Stacked,
    SideBySide,
}

/// How far each cascaded window steps right and down, in logical px: one title bar.
pub const CASCADE_STEP: f64 = 32.0;

/// The minimum window size on `area`'s monitor, in its physical px.
fn min_px(area: &Screen) -> (u32, u32) {
    (
        (MIN_SIZE.0 * area.scale).ceil() as u32,
        (MIN_SIZE.1 * area.scale).ceil() as u32,
    )
}

/// A `w`×`h` rect at `x`,`y`, grown to the minimum and pulled in until it is all on `area`
/// (the top-left edge wins when it cannot be).
fn place(area: &Screen, x: i32, y: i32, w: u32, h: u32) -> Bounds {
    let (min_w, min_h) = min_px(area);
    let (w, h) = (w.max(min_w), h.max(min_h));
    Bounds {
        x: pull_in(x, w, area.x, area.w),
        y: pull_in(y, h, area.y, area.h),
        w,
        h,
        maximized: false,
    }
}

/// Part `i` of `total` cut into `k` parts that tile it exactly: its offset and its length.
fn split(total: u32, k: u32, i: u32) -> (u32, u32) {
    let at = |j: u32| (total as u64 * j as u64 / k.max(1) as u64) as u32;
    (at(i), at(i + 1) - at(i))
}

/// The left or right half of `area`, the full height. The two halves tile it exactly; a half
/// narrower than the minimum keeps the minimum, still against its own edge.
pub fn snap_rect(area: &Screen, side: Side) -> Bounds {
    let (offset, w) = split(area.w, 2, if side == Side::Left { 0 } else { 1 });
    let (min_w, _) = min_px(area);
    let x = match side {
        Side::Left => area.x,
        Side::Right if w < min_w => area.x + area.w as i32 - min_w as i32,
        Side::Right => area.x + offset as i32,
    };
    place(area, x, area.y, w, area.h)
}

/// `n` windows in lines along one axis. `rows`: stacked (each window full width, one under the
/// other); else side by side. Lines are capped at what fits at the minimum and the rest wrap
/// into more lines, sharing the windows evenly, so there is never an empty cell.
fn tile(n: usize, area: &Screen, rows: bool) -> Vec<Bounds> {
    if n == 0 {
        return Vec::new();
    }
    let n = n as u32;
    let (min_w, min_h) = min_px(area);
    // along: the axis the windows line up on; across: the axis the lines sit side by side on
    let (along, across, min_along) = if rows {
        (area.h, area.w, min_h)
    } else {
        (area.w, area.h, min_w)
    };
    let per_line = (along / min_along.max(1)).max(1);
    let lines = n.div_ceil(per_line);
    let mut out = Vec::with_capacity(n as usize);
    for line in 0..lines {
        let count = n / lines + u32::from(line < n % lines);
        let (across_at, across_len) = split(across, lines, line);
        for i in 0..count {
            let (along_at, along_len) = split(along, count, i);
            out.push(if rows {
                place(
                    area,
                    area.x + across_at as i32,
                    area.y + along_at as i32,
                    across_len,
                    along_len,
                )
            } else {
                place(
                    area,
                    area.x + along_at as i32,
                    area.y + across_at as i32,
                    along_len,
                    across_len,
                )
            });
        }
    }
    out
}

/// Show windows stacked: one column of full-width rows (more columns when rows would be
/// shorter than the minimum).
pub fn stacked(n: usize, area: &Screen) -> Vec<Bounds> {
    tile(n, area, true)
}

/// Show windows side by side: one row of full-height columns (more rows when columns would be
/// narrower than the minimum).
pub fn side_by_side(n: usize, area: &Screen) -> Vec<Bounds> {
    tile(n, area, false)
}

/// Cascade windows: all one size — the default window size, shrunk so the cascade fits, never
/// under the minimum — each [`CASCADE_STEP`] right and down from the last, from the top-left
/// corner. A step that would leave the work area starts again at the corner.
pub fn cascade(n: usize, area: &Screen) -> Vec<Bounds> {
    let step = ((CASCADE_STEP * area.scale).round() as u32).max(1);
    let (min_w, min_h) = min_px(area);
    let spread = step.saturating_mul(n.saturating_sub(1) as u32);
    let w = ((DEFAULT_SIZE.0 * area.scale).round() as u32)
        .min(area.w.saturating_sub(spread))
        .max(min_w);
    let h = ((DEFAULT_SIZE.1 * area.scale).round() as u32)
        .min(area.h.saturating_sub(spread))
        .max(min_h);
    // how many steps fit before a window would run off the right or the bottom edge
    let fit = (area.w.saturating_sub(w) / step + 1).min(area.h.saturating_sub(h) / step + 1);
    (0..n as u32)
        .map(|i| {
            let off = ((i % fit.max(1)) * step) as i32;
            place(area, area.x + off, area.y + off, w, h)
        })
        .collect()
}

/// The rects `layout` gives `n` windows on `area`, in order.
pub fn layout_rects(layout: Layout, n: usize, area: &Screen) -> Vec<Bounds> {
    match layout {
        Layout::Cascade => cascade(n, area),
        Layout::Stacked => stacked(n, area),
        Layout::SideBySide => side_by_side(n, area),
    }
}

/// What Trove remembers about a window it snapped: which half, the rect it put it at, and the
/// bounds it had before — where Restore takes it back to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SnapMemo {
    pub side: Side,
    pub rect: Bounds,
    pub before: Bounds,
}

/// A window as the Snap keys see it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SnapState {
    Normal,
    Maximized,
    Half(Side),
}

/// What one Snap key does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SnapAction {
    /// to this half (a maximized window is restored first)
    Snap(Side),
    Maximize,
    /// out of maximized, to its normal rect
    Unmaximize,
    /// already on this half: to the same half of the next monitor that way, if there is one
    /// (plan 20 Q2); no monitor that way, nothing
    NextMonitor(Side),
    /// back to the bounds it had before the snap
    Restore,
    Minimize,
    Nothing,
}

/// How far, in px, a snapped window may be from the rect it was put at and still be that half
/// (the OS may round a size by a pixel).
const SNAP_SLACK: i64 = 2;

fn near(a: &Bounds, b: &Bounds) -> bool {
    let d = |p: i64, q: i64| (p - q).abs() <= SNAP_SLACK;
    d(a.x as i64, b.x as i64)
        && d(a.y as i64, b.y as i64)
        && d(a.w as i64, b.w as i64)
        && d(a.h as i64, b.h as i64)
}

/// The window's state: maximized, a half Trove snapped it to and it still sits at, or normal (a
/// half the user has since dragged or resized is normal again).
pub fn snap_state(memo: Option<&SnapMemo>, now: Bounds, maximized: bool) -> SnapState {
    if maximized {
        return SnapState::Maximized;
    }
    match memo {
        Some(m) if near(&m.rect, &now) => SnapState::Half(m.side),
        _ => SnapState::Normal,
    }
}

/// Windows 11's Snap keys, as Joy wrote them (plan 20, "What the four keys do").
pub fn next_snap(state: SnapState, key: SnapKey) -> SnapAction {
    use SnapAction as A;
    match (state, key) {
        (SnapState::Half(Side::Left), SnapKey::Left) => A::NextMonitor(Side::Left),
        (SnapState::Half(Side::Right), SnapKey::Right) => A::NextMonitor(Side::Right),
        (SnapState::Half(_), _) => A::Restore,
        (_, SnapKey::Left) => A::Snap(Side::Left),
        (_, SnapKey::Right) => A::Snap(Side::Right),
        (SnapState::Normal, SnapKey::Up) => A::Maximize,
        (SnapState::Maximized, SnapKey::Up) => A::Nothing,
        (SnapState::Normal, SnapKey::Down) => A::Minimize,
        (SnapState::Maximized, SnapKey::Down) => A::Unmaximize,
    }
}

fn centre(s: &Screen) -> (i64, i64) {
    (s.x as i64 + s.w as i64 / 2, s.y as i64 + s.h as i64 / 2)
}

/// The monitor next to `from` towards `side` (plan 20 Q2): of the monitors whose middle is that
/// way, the one level with it first (their heights overlap), then the nearest across, then the
/// nearest up or down. `None` when there is no monitor that way.
pub fn next_monitor<'a>(from: &Screen, monitors: &'a [Screen], side: Side) -> Option<&'a Screen> {
    let (fx, fy) = centre(from);
    monitors
        .iter()
        .filter(|s| {
            let (x, _) = centre(s);
            match side {
                Side::Left => x < fx,
                Side::Right => x > fx,
            }
        })
        .min_by_key(|s| {
            let (x, y) = centre(s);
            let level = (s.y as i64) < from.y as i64 + from.h as i64
                && (from.y as i64) < s.y as i64 + s.h as i64;
            (!level, (x - fx).abs(), (y - fy).abs())
        })
}

/// The number of an explorer label, for a stable order: `main` is 1, `main-<n>` is n.
fn label_number(label: &str) -> u32 {
    if label == "main" {
        1
    } else {
        label
            .strip_prefix("main-")
            .and_then(|n| n.parse().ok())
            .unwrap_or(u32::MAX)
    }
}

/// Whether a window is on the active stage, from its own size and the size the window server
/// draws it at (both in points). With Stage Manager on, the yellow button does not miniaturize a
/// window: it moves it to the strip at the side as its own set, where it is drawn as a thumbnail
/// about 120 points wide - and `isMiniaturized`, `isVisible` and `occlusionState` all still say
/// "on screen" (measured on macOS 27, plan 20.4.3). A window drawn at a size that is not its own
/// is in the strip, so it is left out like a minimized one. Unknown drawn size → on stage.
#[cfg_attr(
    not(target_os = "macos"),
    allow(
        dead_code,
        reason = "only the Mac has Stage Manager; the tests run everywhere"
    )
)]
pub fn on_active_stage(own: (f64, f64), drawn: Option<(f64, f64)>) -> bool {
    const SLACK: f64 = 2.0;
    drawn.is_none_or(|(w, h)| (w - own.0).abs() <= SLACK && (h - own.1).abs() <= SLACK)
}

/// One window as the arranger sees it: its label, and whether it is on screen and not minimized.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub label: String,
    pub explorer: bool,
    pub shown: bool,
}

/// The windows a layout moves, in the order it places them: explorer windows that are on screen
/// (never Spotlight, never a minimized or hidden one), by the order they were opened. The asking
/// window goes last for a cascade (the top of the pile, where it is focused) and first for the
/// tiles (the top-left cell).
pub fn arrange_order(windows: &[Candidate], anchor: &str, layout: Layout) -> Vec<String> {
    let mut picked: Vec<&Candidate> = windows.iter().filter(|w| w.explorer && w.shown).collect();
    picked.sort_by_key(|w| (label_number(&w.label), w.label.clone()));
    let mut labels: Vec<String> = picked.into_iter().map(|w| w.label.clone()).collect();
    if let Some(i) = labels.iter().position(|l| l == anchor) {
        let a = labels.remove(i);
        match layout {
            Layout::Cascade => labels.push(a),
            _ => labels.insert(0, a),
        }
    }
    labels
}

/// How far a window's OUTER rect reaches past what you see of it, per side, physical px.
///
/// On Windows a window with `WS_THICKFRAME` (every explorer window, `core::frame`) has an
/// invisible resize border around its visible frame: measured 7 px left, right and bottom and
/// 0 on top at 100 % (plan 20.4.3, 2026-10-21). The OS's own Snap puts the OUTER rect that much
/// past the work area so the VISIBLE edge lands on it. Everywhere else, all zero.
#[cfg_attr(not(windows), allow(dead_code))] // only Windows has an invisible frame to correct
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Insets {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// The insets between a window's outer rect and its visible frame, both `[left, top, right,
/// bottom]` in screen px (`GetWindowRect` and `DWMWA_EXTENDED_FRAME_BOUNDS`). A side where the
/// frame is not inside the outer rect (a bad read) counts as 0, never negative.
#[cfg_attr(not(windows), allow(dead_code))] // only Windows has an invisible frame to correct
pub fn frame_insets(outer: [i32; 4], frame: [i32; 4]) -> Insets {
    Insets {
        left: (frame[0] - outer[0]).max(0),
        top: (frame[1] - outer[1]).max(0),
        right: (outer[2] - frame[2]).max(0),
        bottom: (outer[3] - frame[3]).max(0),
    }
}

/// The outer rect that shows `visible` once `insets` are added round it: what to hand
/// `SetWindowPos` so the visible frame IS the layout's rect.
#[cfg_attr(not(windows), allow(dead_code))] // only Windows has an invisible frame to correct
pub fn outer_for(visible: Bounds, insets: Insets) -> Bounds {
    let grow = |a: i32, b: i32| (a + b).max(0) as u32;
    Bounds {
        x: visible.x - insets.left,
        y: visible.y - insets.top,
        w: visible.w + grow(insets.left, insets.right),
        h: visible.h + grow(insets.top, insets.bottom),
        maximized: false,
    }
}

/// A `[left, top, right, bottom]` screen rect as `Bounds` (never maximized).
#[cfg_attr(not(windows), allow(dead_code))] // only Windows has an invisible frame to correct
pub fn rect_bounds(r: [i32; 4]) -> Bounds {
    Bounds {
        x: r[0],
        y: r[1],
        w: (r[2] - r[0]).max(0) as u32,
        h: (r[3] - r[1]).max(0) as u32,
        maximized: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_outer_rect_grows_by_the_invisible_border_so_the_visible_edge_is_on_the_area() {
        // Plan 20.4.3, Windows 2026-10-21: the 1-window Stacked result had outer (2560,0)-
        // (5136,1401) and DWM's visible frame (2567,0)-(5129,1394) — 7 px left, right, bottom.
        let insets = frame_insets([2560, 0, 5136, 1401], [2567, 0, 5129, 1394]);
        assert_eq!(
            insets,
            Insets {
                left: 7,
                top: 0,
                right: 7,
                bottom: 7
            }
        );
        // the work area of DISPLAY2, x 2560..5120, 1392 high
        let area = rect_bounds([2560, 0, 5120, 1392]);
        let outer = outer_for(area, insets);
        assert_eq!((outer.x, outer.y, outer.w, outer.h), (2553, 0, 2574, 1399));
        // the OS's own left-half Snap on the same monitor measured outer (2553,0) 1294x1399
        let half = outer_for(rect_bounds([2560, 0, 3840, 1392]), insets);
        assert_eq!((half.x, half.y, half.w, half.h), (2553, 0, 1294, 1399));
        // and the visible frame of that outer rect is the area again, to the pixel
        let back = frame_insets(
            [
                outer.x,
                outer.y,
                outer.x + outer.w as i32,
                outer.y + outer.h as i32,
            ],
            [2560, 0, 5120, 1392],
        );
        assert_eq!(back, insets);
    }

    #[test]
    fn no_border_or_a_bad_read_leaves_the_rect_as_it_is() {
        let r = rect_bounds([100, 50, 900, 650]);
        assert_eq!(outer_for(r, Insets::default()), r);
        // a frame read that reaches OUTSIDE the outer rect never shrinks the window
        assert_eq!(
            frame_insets([0, 0, 800, 500], [-3, -3, 803, 503]),
            Insets::default()
        );
        // the minimum is the visible size's: growing never takes it under 800x500
        let min = rect_bounds([0, 0, 800, 500]);
        let grown = outer_for(
            min,
            Insets {
                left: 7,
                top: 0,
                right: 7,
                bottom: 7,
            },
        );
        assert!(grown.w >= 800 && grown.h >= 500);
        assert!(!grown.maximized);
    }

    fn screen(x: i32, y: i32, w: u32, h: u32, scale: f64) -> Screen {
        Screen {
            x,
            y,
            w,
            h,
            scale,
            primary: true,
        }
    }

    /// A 1920×1080 monitor with a 40 px taskbar at the bottom.
    fn hd() -> Screen {
        screen(0, 0, 1920, 1040, 1.0)
    }

    fn on_area(b: &Bounds, s: &Screen) -> bool {
        b.x >= s.x
            && b.y >= s.y
            && b.x as i64 + b.w as i64 <= s.x as i64 + s.w as i64
            && b.y as i64 + b.h as i64 <= s.y as i64 + s.h as i64
    }

    fn rect(x: i32, y: i32, w: u32, h: u32) -> Bounds {
        Bounds {
            x,
            y,
            w,
            h,
            maximized: false,
        }
    }

    #[test]
    fn a_half_is_half_the_work_area_and_never_under_800() {
        let s = hd();
        assert_eq!(snap_rect(&s, Side::Left), rect(0, 0, 960, 1040));
        assert_eq!(snap_rect(&s, Side::Right), rect(960, 0, 960, 1040));
        // an odd width: the halves still tile it with no gap
        let odd = screen(0, 0, 1921, 1040, 1.0);
        let (l, r) = (snap_rect(&odd, Side::Left), snap_rect(&odd, Side::Right));
        assert_eq!(l.x + l.w as i32, r.x);
        assert_eq!(r.x + r.w as i32, 1921);
        // a second monitor to the right, at 1.5x, menu bar at the top
        let second = screen(1920, 25, 2560, 1415, 1.5);
        assert_eq!(snap_rect(&second, Side::Right), rect(3200, 25, 1280, 1415));
        // 1366 px at 1x: a half is 683, under 800 — it keeps 800, against its own edge
        let small = screen(0, 0, 1366, 728, 1.0);
        assert_eq!(snap_rect(&small, Side::Left), rect(0, 0, 800, 728));
        assert_eq!(snap_rect(&small, Side::Right), rect(566, 0, 800, 728));
        // at 2x the minimum is 1600 physical px
        let retina = screen(0, 0, 2880, 1800, 2.0);
        assert_eq!(snap_rect(&retina, Side::Left).w, 1600);
        assert_eq!(snap_rect(&retina, Side::Right), rect(1280, 0, 1600, 1800));
    }

    #[test]
    fn stacked_and_side_by_side_tile_one_to_five_windows_with_no_gap() {
        let s = screen(100, 50, 1920, 2400, 1.0);
        for n in 1..=4 {
            // 2400 / 500 = 4 rows fit: one column
            let rows = stacked(n, &s);
            assert_eq!(rows.len(), n);
            assert_eq!(rows[0].y, 50);
            for pair in rows.windows(2) {
                assert_eq!(pair[0].y + pair[0].h as i32, pair[1].y, "{n}: {rows:?}");
            }
            let last = rows.last().unwrap();
            assert_eq!(last.y + last.h as i32, 50 + 2400);
            assert!(rows.iter().all(|r| r.x == 100 && r.w == 1920));
        }
        let wide = screen(0, 0, 4000, 1040, 1.0);
        for n in 1..=5 {
            // 4000 / 800 = 5 columns fit: one row
            let cols = side_by_side(n, &wide);
            assert_eq!(cols.len(), n);
            for pair in cols.windows(2) {
                assert_eq!(pair[0].x + pair[0].w as i32, pair[1].x, "{n}: {cols:?}");
            }
            let last = cols.last().unwrap();
            assert_eq!(last.x + last.w as i32, 4000);
            assert!(cols.iter().all(|c| c.y == 0 && c.h == 1040));
        }
        // one window fills the work area, not maximized
        assert_eq!(stacked(1, &hd()), vec![rect(0, 0, 1920, 1040)]);
        assert_eq!(side_by_side(1, &hd()), vec![rect(0, 0, 1920, 1040)]);
        assert!(stacked(0, &hd()).is_empty() && cascade(0, &hd()).is_empty());
    }

    #[test]
    fn too_many_rows_wrap_into_columns_and_never_go_under_500() {
        // 1040 px tall: two 500 px rows fit, so 3 windows are 2 columns (2 + 1)
        let s = hd();
        let three = stacked(3, &s);
        assert_eq!(three[0], rect(0, 0, 960, 520));
        assert_eq!(three[1], rect(0, 520, 960, 520));
        // the column with fewer windows makes them taller: no empty cell
        assert_eq!(three[2], rect(960, 0, 960, 1040));
        // 5 windows: 3 columns of 2, 2, 1
        let five = stacked(5, &s);
        assert_eq!(five.len(), 5);
        assert!(five
            .iter()
            .all(|b| b.h >= 500 && b.w >= 800 && on_area(b, &s)));
        // the last column is 640 px: the window keeps 800 and is pulled in from the right edge
        assert_eq!(five[4], rect(1120, 0, 800, 1040));
        // side by side on 1920: two 800 px columns fit, so 3 windows are 2 rows (2 + 1)
        let three = side_by_side(3, &s);
        assert_eq!(three[0], rect(0, 0, 960, 520));
        assert_eq!(three[1], rect(960, 0, 960, 520));
        assert_eq!(three[2], rect(0, 520, 1920, 520));
    }

    #[test]
    fn a_cell_under_the_minimum_keeps_the_minimum_and_stays_on_the_area() {
        // 5 windows, 3 columns on 1920: 640 px columns → 800 px windows that overlap
        let s = hd();
        for b in stacked(5, &s).iter().chain(side_by_side(5, &s).iter()) {
            assert!(b.w >= 800 && b.h >= 500, "{b:?}");
            assert!(on_area(b, &s), "{b:?}");
        }
        // a work area smaller than the minimum itself: the minimum, at its top-left corner
        let tiny = screen(10, 20, 640, 400, 1.0);
        for b in stacked(2, &tiny)
            .iter()
            .chain(cascade(3, &tiny).iter())
            .chain([snap_rect(&tiny, Side::Right)].iter())
        {
            assert_eq!((b.x, b.y, b.w, b.h), (10, 20, 800, 500), "{b:?}");
        }
    }

    #[test]
    fn cascade_steps_32_px_and_starts_again_at_the_corner() {
        let s = hd();
        let three = cascade(3, &s);
        assert_eq!(three[0], rect(0, 0, 1200, 760));
        assert_eq!(three[1], rect(32, 32, 1200, 760));
        assert_eq!(three[2], rect(64, 64, 1200, 760));
        // many windows: shrunk to fit, never under the minimum, and wrapping to the corner
        let many = cascade(20, &s);
        assert!(many
            .iter()
            .all(|b| b.w == 1200 && b.h == 500 && on_area(b, &s)));
        // (1040 - 500) / 32 + 1 = 17 steps fit down; the 18th starts over
        assert_eq!(many[16], rect(512, 512, 1200, 500));
        assert_eq!(many[17], rect(0, 0, 1200, 500));
        // at 2x the step and the sizes are physical
        let retina = cascade(2, &screen(0, 0, 2880, 1800, 2.0));
        assert_eq!(retina[1], rect(64, 64, 2400, 1520));
    }

    #[test]
    fn every_rect_is_on_the_work_area() {
        let areas = [
            hd(),
            screen(-1920, 0, 1920, 1040, 1.0),
            screen(0, 25, 1440, 875, 1.0),
            screen(1920, -200, 2560, 1400, 1.25),
        ];
        for s in &areas {
            for n in 1..=5 {
                for layout in [Layout::Cascade, Layout::Stacked, Layout::SideBySide] {
                    let rects = layout_rects(layout, n, s);
                    assert_eq!(rects.len(), n);
                    for b in &rects {
                        assert!(on_area(b, s), "{layout:?} {n} on {s:?}: {b:?}");
                        assert!(!b.maximized);
                    }
                }
            }
            for side in [Side::Left, Side::Right] {
                assert!(on_area(&snap_rect(s, side), s));
            }
        }
    }

    #[test]
    fn the_snap_keys_follow_windows_rules() {
        use SnapAction as A;
        use SnapKey as K;
        use SnapState as S;
        let table = [
            (
                S::Normal,
                [
                    A::Snap(Side::Left),
                    A::Snap(Side::Right),
                    A::Maximize,
                    A::Minimize,
                ],
            ),
            (
                S::Maximized,
                [
                    A::Snap(Side::Left),
                    A::Snap(Side::Right),
                    A::Nothing,
                    A::Unmaximize,
                ],
            ),
            (
                S::Half(Side::Left),
                [
                    A::NextMonitor(Side::Left),
                    A::Restore,
                    A::Restore,
                    A::Restore,
                ],
            ),
            (
                S::Half(Side::Right),
                [
                    A::Restore,
                    A::NextMonitor(Side::Right),
                    A::Restore,
                    A::Restore,
                ],
            ),
        ];
        for (state, want) in table {
            for (key, want) in [K::Left, K::Right, K::Up, K::Down].into_iter().zip(want) {
                assert_eq!(next_snap(state, key), want, "{state:?} {key:?}");
            }
        }
    }

    #[test]
    fn a_half_pressed_again_goes_to_the_next_monitor_that_way() {
        // left: a 1440 laptop; middle: the 1920 main; right: a 2560 at 1.5x, set higher
        let laptop = screen(-1440, 100, 1440, 860, 1.0);
        let main = hd();
        let right = screen(1920, -200, 2560, 1400, 1.5);
        let all = [main, right, laptop];
        assert_eq!(next_monitor(&main, &all, Side::Left), Some(&laptop));
        assert_eq!(next_monitor(&main, &all, Side::Right), Some(&right));
        assert_eq!(next_monitor(&right, &all, Side::Left), Some(&main));
        // the far edge: no monitor that way, so nothing moves
        assert_eq!(next_monitor(&laptop, &all, Side::Left), None);
        assert_eq!(next_monitor(&right, &all, Side::Right), None);
        assert_eq!(next_monitor(&main, &[main], Side::Left), None);
        // one level with it beats a nearer one stacked above
        let above = screen(1000, -1080, 1920, 1040, 1.0);
        let far = screen(4000, 0, 1920, 1040, 1.0);
        assert_eq!(
            next_monitor(&main, &[main, above, far], Side::Right),
            Some(&far)
        );
        // the same half there
        assert_eq!(
            snap_rect(next_monitor(&main, &all, Side::Right).unwrap(), Side::Right),
            rect(3200, -200, 1280, 1400)
        );
    }

    #[test]
    fn a_moved_half_is_normal_again() {
        let half = rect(0, 0, 960, 1040);
        let memo = SnapMemo {
            side: Side::Left,
            rect: half,
            before: rect(100, 100, 1200, 760),
        };
        assert_eq!(snap_state(Some(&memo), half, false), S::Half(Side::Left));
        // the OS rounding a size by a pixel or two is still the half
        assert_eq!(
            snap_state(Some(&memo), rect(1, 0, 958, 1041), false),
            S::Half(Side::Left)
        );
        // dragged away, or resized: normal
        assert_eq!(
            snap_state(Some(&memo), rect(40, 0, 960, 1040), false),
            S::Normal
        );
        assert_eq!(
            snap_state(Some(&memo), rect(0, 0, 900, 1040), false),
            S::Normal
        );
        assert_eq!(snap_state(None, half, false), S::Normal);
        // maximized wins over any memo
        assert_eq!(snap_state(Some(&memo), half, true), S::Maximized);
    }

    use SnapState as S;

    fn win(label: &str, explorer: bool, shown: bool) -> Candidate {
        Candidate {
            label: label.into(),
            explorer,
            shown,
        }
    }

    #[test]
    fn a_window_in_the_stage_manager_strip_is_not_on_stage() {
        // 800 x 525 window drawn at its own size: on stage (rounding slack allowed)
        assert!(on_active_stage((800.0, 525.0), Some((800.0, 525.0))));
        assert!(on_active_stage((800.0, 525.0), Some((801.0, 524.0))));
        // the yellow button under Stage Manager: drawn as a 104 x 107 thumbnail in the strip
        assert!(!on_active_stage((800.0, 525.0), Some((104.0, 107.0))));
        // the window server did not say: assume on stage, as before
        assert!(on_active_stage((800.0, 525.0), None));
    }

    #[test]
    fn five_windows_with_one_minimized_stack_the_other_four_two_by_two() {
        let windows = vec![
            win("main", true, true),
            win("main-2", true, true),
            win("main-3", true, false), // in the strip / minimized
            win("main-4", true, true),
            win("main-5", true, true),
        ];
        let order = arrange_order(&windows, "main-5", Layout::Stacked);
        assert_eq!(order, ["main-5", "main", "main-2", "main-4"]);
        let s = screen(0, 30, 1920, 1050, 1.0);
        let cells = layout_rects(Layout::Stacked, order.len(), &s);
        assert_eq!(cells.len(), 4);
        let mut xs: Vec<i32> = cells.iter().map(|b| b.x).collect();
        xs.dedup();
        assert_eq!(xs.len(), 2, "2 columns of 2: {cells:?}");
    }

    #[test]
    fn only_visible_explorer_windows_are_arranged_and_the_asker_ends_on_top() {
        let windows = [
            win("main-10", true, true),
            win("palette", false, true),
            win("main-3", true, false), // minimized or hidden
            win("main", true, true),
            win("main-2", true, true),
        ];
        assert_eq!(
            arrange_order(&windows, "main-2", Layout::Cascade),
            ["main", "main-10", "main-2"]
        );
        assert_eq!(
            arrange_order(&windows, "main-2", Layout::Stacked),
            ["main-2", "main", "main-10"]
        );
        assert_eq!(
            arrange_order(&windows, "main-10", Layout::SideBySide),
            ["main-10", "main", "main-2"]
        );
        // asked from somewhere that is not an arranged window: opened order
        assert_eq!(
            arrange_order(&windows, "palette", Layout::Cascade),
            ["main", "main-2", "main-10"]
        );
        assert!(
            arrange_order(&[win("palette", false, true)], "palette", Layout::Cascade).is_empty()
        );
    }

    #[test]
    fn the_layout_names_are_the_frontends() {
        let parse = |s: &str| serde_json::from_str::<Layout>(&format!("\"{s}\"")).unwrap();
        assert_eq!(parse("cascade"), Layout::Cascade);
        assert_eq!(parse("stacked"), Layout::Stacked);
        assert_eq!(parse("side-by-side"), Layout::SideBySide);
        let key = |s: &str| serde_json::from_str::<SnapKey>(&format!("\"{s}\"")).unwrap();
        assert_eq!(
            ["left", "right", "up", "down"].map(key),
            [SnapKey::Left, SnapKey::Right, SnapKey::Up, SnapKey::Down]
        );
    }
}
