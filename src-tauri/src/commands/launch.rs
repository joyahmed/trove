use std::sync::Mutex;

use tauri::State;

use crate::core::launch::{self, Launch};

/// A launch waiting for the main window's frontend to ask for it, and whether that frontend
/// has asked yet. Managed state on the app.
///
/// On Windows and Linux every launch arrives as argv: this process's own (read below) or a
/// second process's (the single-instance handler emits it). macOS sends neither — Finder's
/// "Open With", a folder dropped on the Dock icon and `open -a Trove <dir>` all arrive as
/// `RunEvent::Opened` (`commands::dock`), often before the webview has loaded. Such a launch
/// is parked here and handed over by `initial_launch`, because an event emitted before the
/// frontend listens is simply lost. So is a second process's launch while `main` is gone or
/// still booting (`GateState::second_launch`).
#[derive(Default)]
pub struct LaunchGate(pub Mutex<GateState>);

#[derive(Default)]
pub struct GateState {
    /// The main window's frontend has called `initial_launch`, so it listens for `launch` now.
    /// Read by `commands::dock` and by `GateState::second_launch`.
    pub delivered: bool,
    /// What the next `initial_launch` returns instead of argv.
    pub pending: Option<Launch>,
    /// This process's own argv has been handed out. It describes the FIRST launch only, so a
    /// `main` rebuilt later (tray "Open", Dock) must not read it again.
    argv_served: bool,
}

impl GateState {
    /// Route a second process's launch (the single-instance handler) and record what the route
    /// needs. Returns the launch when it is to be emitted to a listening `main`; `None` when it
    /// was parked for the next `initial_launch`.
    ///
    /// ⛔ **A `main` that is gone must get the NEW launch.** With Keep running on, `main` can be
    /// destroyed while the process lives on; `show_main` then rebuilds it, and its frontend asks
    /// `initial_launch` — which, with nothing parked, reads THIS process's argv: the first
    /// launch's folder, not the one just asked for. The event emitted beside the rebuild was
    /// lost as well, because the new webview was not listening yet. Seen on Ubuntu, plan 15
    /// D.3.4.
    pub fn second_launch(&mut self, main_exists: bool, launch: Launch) -> Option<Launch> {
        if !main_exists {
            // a new `main` is about to be built: it will ask again
            self.delivered = false;
        }
        if main_exists && self.delivered {
            return Some(launch);
        }
        // not listening yet (a rebuild, or a `main` still booting): the last one wins
        if let Some(old) = self.pending.replace(launch) {
            log::warn!("second launch before the window was ready; the earlier one was replaced");
            log::debug!("replaced launch: {old:?}");
        }
        None
    }

    /// What `initial_launch` hands out instead of argv, if anything. The frontend that asked
    /// listens for `launch` from here on.
    fn take_parked(&mut self) -> Option<Launch> {
        self.delivered = true;
        self.pending.take()
    }

    /// What `initial_launch` returns: a parked launch first, else this process's argv once,
    /// else an empty launch (a normal open: restored tabs or Home, never hidden).
    fn next_launch(&mut self, argv: impl FnOnce() -> Launch) -> Launch {
        if let Some(l) = self.take_parked() {
            log::info!("launch parked for this window");
            log::debug!("parked launch: {l:?}");
            return l;
        }
        if std::mem::replace(&mut self.argv_served, true) {
            return Launch::default();
        }
        argv()
    }
}

/// What this process was started with. Read once by the frontend on mount.
#[tauri::command(async)]
pub fn initial_launch(gate: State<'_, LaunchGate>) -> Launch {
    let Ok(mut g) = gate.0.lock() else {
        return Launch::default();
    };
    g.next_launch(|| {
        let argv: Vec<String> = std::env::args().collect();
        // what Chrome's "Show in folder", VS Code's Reveal and others actually send
        // a count at info, the paths only at debug (plan 15 D.8.2: release logs no paths)
        log::info!("launch: {} arg(s)", argv.len());
        log::debug!("launch argv {argv:?}");
        let cwd = std::env::current_dir().unwrap_or_default();
        launch::parse_own(argv.get(1..).unwrap_or_default(), &cwd)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn to(path: &str) -> Launch {
        Launch {
            path: Some(path.into()),
            ..Launch::default()
        }
    }

    #[test]
    fn a_listening_main_gets_the_launch_as_an_event() {
        let mut g = GateState::default();
        assert_eq!(g.take_parked(), None);
        assert_eq!(g.second_launch(true, to("/b")), Some(to("/b")));
        assert_eq!(g.pending, None);
    }

    #[test]
    fn a_rebuilt_main_gets_the_new_launch_not_the_first() {
        let mut g = GateState::default();
        // the first `main` booted from argv and listened
        assert_eq!(g.take_parked(), None);
        // it was destroyed (Keep running on); a second launch asks for /b
        assert_eq!(g.second_launch(false, to("/b")), None);
        assert!(!g.delivered);
        // the rebuilt `main` asks: it gets /b, not argv
        assert_eq!(g.take_parked(), Some(to("/b")));
        // and listens from then on
        assert_eq!(g.second_launch(true, to("/c")), Some(to("/c")));
    }

    #[test]
    fn a_launch_while_the_rebuilt_main_boots_is_parked_too() {
        let mut g = GateState::default();
        g.take_parked();
        assert_eq!(g.second_launch(false, to("/b")), None);
        // `main` exists again but has not asked yet: the last launch wins
        assert_eq!(g.second_launch(true, to("/c")), None);
        assert_eq!(g.take_parked(), Some(to("/c")));
    }

    #[test]
    fn argv_is_handed_out_once_then_an_empty_launch() {
        let mut g = GateState::default();
        let first = Launch {
            hidden: true,
            ..to("/a")
        };
        assert_eq!(g.next_launch(|| first.clone()), first);
        // a rebuilt main (tray Open): not the first folder, not hidden
        let again = g.next_launch(|| panic!("argv read twice"));
        assert_eq!(again, Launch::default());
        assert!(!again.hidden);
    }

    #[test]
    fn a_parked_launch_still_wins_over_argv() {
        let mut g = GateState::default();
        g.second_launch(false, to("/b"));
        assert_eq!(g.next_launch(|| panic!("argv read")), to("/b"));
        // the parked one did not use up argv
        assert_eq!(g.next_launch(|| to("/a")), to("/a"));
    }
}
