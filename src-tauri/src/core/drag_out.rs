//! Drag OUT of the window, one native drag per OS, so a second Trove window, the system file
//! manager, a browser's upload box or an email client can take the drop. The in-app drag hands
//! over here the moment the pointer leaves the window, while the button is still down.
//!
//! - **Windows**: an OLE `DoDragDrop` with an `IDataObject` carrying `CF_HDROP` (the same
//!   `DROPFILES` block the clipboard writes) and `Preferred DropEffect`. It runs its own modal
//!   loop reading the mouse and returns when the drop lands.
//! - **Mac**: `-[NSView beginDraggingSessionWithItems:event:source:]` on the window's content
//!   view, one `NSDraggingItem` per file wrapping a file `NSURL`, started from the app's current
//!   mouse event (the button is down, so that is the drag's own `NSLeftMouseDragged`). AppKit
//!   runs the session in the main run loop and reports the outcome to the source object.
//! - **Linux (GTK 3)**: `gtk_drag_begin_with_coordinates` on the window widget with a
//!   `text/uri-list` target; `drag-data-get` supplies `file://` URIs, `drag-end` reports.
//!
//! The three do not block the same way (OLE blocks the main thread; AppKit and GTK return at
//! once and call back later), so [`start_drag`] takes a completion callback instead of
//! returning the outcome. It must be called on the main thread: only the thread that owns the
//! window the mouse went down in may take over the pointer.

use serde::Serialize;

/// What the drop target did with the files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub struct DragOutcome {
    pub effect: DragEffect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DragEffect {
    None,
    Copy,
    Move,
}

/// Called once, on the main thread, when the drag is over (dropped, cancelled or refused).
pub type Done = Box<dyn FnOnce(Result<DragOutcome, String>) + Send + 'static>;

/// OLE's `DROPEFFECT` bits: a move is reported as `DROPEFFECT_MOVE` (2), a copy as
/// `DROPEFFECT_COPY` (1); a link (4) or nothing (0) means the source stays and nothing of
/// ours needs doing.
#[cfg_attr(not(windows), allow(dead_code))] // the OLE path's; unit-tested on every OS
pub fn effect_from(drop_effect: u32) -> DragEffect {
    if drop_effect & 2 != 0 {
        DragEffect::Move
    } else if drop_effect & 1 != 0 {
        DragEffect::Copy
    } else {
        DragEffect::None
    }
}

/// AppKit's `NSDragOperation` bits. `NSDragOperationMove` (16) and `NSDragOperationGeneric`
/// (4) both mean "the target took the files" — Finder answers Generic for its same-volume
/// move, the Mac habit — so both re-read the folder. `NSDragOperationCopy` (1) and
/// `NSDragOperationLink` (2) leave the source where it was; `NSDragOperationNone` (0) is a
/// cancelled drag.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // the AppKit path's; unit-tested on every OS
pub fn effect_from_ns(operation: usize) -> DragEffect {
    if operation & (16 | 4) != 0 {
        DragEffect::Move
    } else if operation & (1 | 2) != 0 {
        DragEffect::Copy
    } else {
        DragEffect::None
    }
}

/// GDK's `GdkDragAction` bits at the end of a drag: `GDK_ACTION_MOVE` (4) means the target
/// moved the files (GNOME's file managers do the move themselves on a `text/uri-list` drop),
/// `GDK_ACTION_COPY` (2) or `GDK_ACTION_LINK` (8) leave the source alone, 0 is a cancel.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))] // the GTK path's; unit-tested on every OS
pub fn effect_from_gdk(action: u32) -> DragEffect {
    if action & 4 != 0 {
        DragEffect::Move
    } else if action & (2 | 8) != 0 {
        DragEffect::Copy
    } else {
        DragEffect::None
    }
}

/// `NSEventType` values (NSEvent.h) the Mac drag cares about.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // the AppKit path's; unit-tested on every OS
pub const NS_EVENT_TYPE_LEFT_MOUSE_DOWN: usize = 1;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // the AppKit path's; unit-tested on every OS
pub const NS_EVENT_TYPE_LEFT_MOUSE_UP: usize = 2;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // the AppKit path's; unit-tested on every OS
pub const NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED: usize = 6;

/// What a Mac event looks like to the "which event starts the drag" decision: its
/// `NSEventType` and the address of its `NSWindow` (0 when it has none).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // the AppKit path's; unit-tested on every OS
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MacEvent {
    pub kind: usize,
    pub window: usize,
}

/// The event `beginDraggingSessionWithItems:event:source:` is handed.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // the AppKit path's; unit-tested on every OS
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacDragEvent {
    /// `[NSApp currentEvent]`: the drag's own left-down / left-dragged in this window.
    Current,
    /// The last left-down / left-dragged the event monitor saw in this window.
    Cached,
    /// A fresh `NSEventTypeLeftMouseDragged` built at the pointer's position: the button is
    /// down in this window but neither real event is usable.
    Synthesized,
    /// The left button is already up — there is nothing to drag; end quietly.
    ButtonUp,
}

/// Is the event a left-button press or drag — the only kinds AppKit starts a session from?
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // the AppKit path's; unit-tested on every OS
pub fn is_left_press_or_drag(kind: usize) -> bool {
    kind == NS_EVENT_TYPE_LEFT_MOUSE_DOWN || kind == NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED
}

/// Both known and the same object.
#[cfg_attr(windows, allow(dead_code))] // the AppKit and GTK paths'; unit-tested on every OS
pub fn same_window(a: Option<usize>, b: Option<usize>) -> bool {
    matches!((a, b), (Some(a), Some(b)) if a != 0 && a == b)
}

/// Which event the Mac drag starts from. The handoff runs on the first move OUTSIDE the
/// window, dispatched through tauri's main-thread queue, so `[NSApp currentEvent]` is often
/// the `mouseExited` (type 9) or some later event — AppKit refuses those. The real
/// left-down / left-dragged the monitor cached is the next best (a true event of the press
/// sequence, with its event number and timestamp); a synthesized dragged event at the current
/// pointer position is the last resort and still starts the session (Chromium's drag on the
/// Mac does the same when its current event is not a mouse event).
///
/// `left_button_down` is `+[NSEvent pressedMouseButtons]`, and it only gates the synthesized
/// fallback. The page hands off from a `pointermove` whose `buttons` says left is down, and a
/// real press-or-drag event is proof enough on its own; `pressedMouseButtons` reads the HID
/// button state, which a trackpad's tap-to-drag or three-finger drag may not set, so gating
/// the real events on it turned those drags into quiet no-ops (unverified on hardware, but
/// the gate buys nothing there: a session begun as the button lifts ends at once with
/// `NSDragOperationNone`). With no real event AND no button, there is nothing to build a
/// dragged event from: the drag is simply over.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // the AppKit path's; unit-tested on every OS
pub fn pick_mac_drag_event(
    current: Option<MacEvent>,
    cached: Option<MacEvent>,
    view_window: usize,
    left_button_down: bool,
) -> Result<MacDragEvent, String> {
    if view_window == 0 {
        return Err("the view has no window".to_string());
    }
    let usable = |e: Option<MacEvent>| {
        e.is_some_and(|e| {
            is_left_press_or_drag(e.kind) && same_window(Some(e.window), Some(view_window))
        })
    };
    if usable(current) {
        Ok(MacDragEvent::Current)
    } else if usable(cached) {
        Ok(MacDragEvent::Cached)
    } else if !left_button_down {
        Ok(MacDragEvent::ButtonUp)
    } else {
        Ok(MacDragEvent::Synthesized)
    }
}

/// A `file://` URI for an absolute Unix path, every byte outside RFC 3986's unreserved set,
/// `/` and the sub-delims percent-encoded as UTF-8 — the spelling `g_filename_to_uri` and
/// Nautilus agree on. ⛔ `text/uri-list` lines are separated by CRLF and may not hold a raw
/// space or a non-ASCII byte; a target that gets one drops the whole list on the floor.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))] // see effect_from_gdk
pub fn file_uri(path: &str) -> String {
    const KEEP: &[u8] = b"-._~/!$&'()*+,;=:@";
    let mut uri = String::with_capacity(path.len() + 8);
    uri.push_str("file://");
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || KEEP.contains(&b) {
            uri.push(b as char);
        } else {
            uri.push_str(&format!("%{b:02X}"));
        }
    }
    uri
}

/// Every path as a `file://` URI, in the order given.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))] // see effect_from_gdk
pub fn uri_list(paths: &[String]) -> Vec<String> {
    paths.iter().map(|p| file_uri(p)).collect()
}

/// The one check every OS shares before touching a native API.
pub fn validate(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("nothing to drag".to_string());
    }
    Ok(())
}

/// Start the native drag for `paths` from `window`; `done` gets the outcome once it is over.
/// Must run on the main thread (the caller hops there with `run_on_main_thread`).
pub fn start_drag(window: &tauri::WebviewWindow, paths: &[String], allow_move: bool, done: Done) {
    if let Err(e) = validate(paths) {
        return done(Err(e));
    }
    imp::start_drag(window, paths, allow_move, done);
}

/// Called once per webview window, on the main thread, as soon as it is built: what the drag
/// later needs to have been watching (the Mac's NSEvent monitor, the Linux window's last
/// button press). Windows needs nothing — OLE reads the mouse itself.
pub fn prepare_window<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    imp::prepare_window(window);
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
mod imp {
    use super::Done;

    pub fn prepare_window<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) {}

    pub fn start_drag(
        _window: &tauri::WebviewWindow,
        _paths: &[String],
        _allow_move: bool,
        done: Done,
    ) {
        done(Err("drag out is not supported on this OS yet".to_string()));
    }
}

#[cfg(windows)]
mod imp {
    use super::{effect_from, Done, DragOutcome};
    use crate::core::clipboard::{encode_hdrop, DROPEFFECT_COPY, DROPEFFECT_MOVE};
    use windows::core::{implement, Result as WinResult, BOOL, HRESULT, PCWSTR};
    use windows::Win32::Foundation::{
        DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, DV_E_FORMATETC,
        E_NOTIMPL, HGLOBAL, OLE_E_ADVISENOTSUPPORTED, S_OK,
    };
    use windows::Win32::System::Com::{
        IAdviseSink, IDataObject, IDataObject_Impl, IEnumFORMATETC, IEnumSTATDATA,
        DVASPECT_CONTENT, FORMATETC, STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL,
    };
    use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::{
        DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, OleUninitialize, CF_HDROP,
        DROPEFFECT,
    };
    use windows::Win32::System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS};
    use windows::Win32::UI::Shell::SHCreateStdEnumFmtEtc;

    /// The registered format Explorer reads to decide copy vs move on paste/drop.
    fn preferred_drop_effect_format() -> u16 {
        let name: Vec<u16> = "Preferred DropEffect\0".encode_utf16().collect();
        // SAFETY: `name` is NUL-terminated and outlives the call.
        (unsafe { RegisterClipboardFormatW(PCWSTR(name.as_ptr())) }) as u16
    }

    /// Copy `bytes` into a fresh movable HGLOBAL, the way clipboard and OLE data travel.
    fn global_from(bytes: &[u8]) -> WinResult<HGLOBAL> {
        // SAFETY: a plain allocation of `bytes.len()` bytes; the handle is ours to lock.
        let h = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) }?;
        // SAFETY: `h` is a valid movable handle just allocated; the lock gives a pointer to at
        // least `bytes.len()` bytes, which we fill and unlock.
        unsafe {
            let p = GlobalLock(h) as *mut u8;
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
            let _ = GlobalUnlock(h);
        }
        Ok(h)
    }

    /// The data object: two formats, both as HGLOBALs, built once from the paths.
    #[implement(IDataObject)]
    struct PathsData {
        hdrop: Vec<u8>,
        effect: u32,
        effect_format: u16,
    }

    impl PathsData {
        fn formats(&self) -> [FORMATETC; 2] {
            let fmt = |cf: u16| FORMATETC {
                cfFormat: cf,
                ptd: std::ptr::null_mut(),
                dwAspect: DVASPECT_CONTENT.0,
                lindex: -1,
                tymed: TYMED_HGLOBAL.0 as u32,
            };
            [fmt(CF_HDROP.0), fmt(self.effect_format)]
        }

        fn supports(&self, f: &FORMATETC) -> bool {
            (f.cfFormat == CF_HDROP.0 || f.cfFormat == self.effect_format)
                && f.tymed & TYMED_HGLOBAL.0 as u32 != 0
                && f.dwAspect == DVASPECT_CONTENT.0
        }

        fn medium(&self, cf: u16) -> WinResult<STGMEDIUM> {
            let bytes: Vec<u8> = if cf == CF_HDROP.0 {
                self.hdrop.clone()
            } else {
                self.effect.to_le_bytes().to_vec()
            };
            let h = global_from(&bytes)?;
            Ok(STGMEDIUM {
                tymed: TYMED_HGLOBAL.0 as u32,
                u: STGMEDIUM_0 { hGlobal: h },
                pUnkForRelease: std::mem::ManuallyDrop::new(None),
            })
        }
    }

    impl IDataObject_Impl for PathsData_Impl {
        fn GetData(&self, pformatetcin: *const FORMATETC) -> WinResult<STGMEDIUM> {
            // SAFETY: OLE hands a valid FORMATETC pointer for the duration of the call.
            let f = unsafe { &*pformatetcin };
            if !self.supports(f) {
                return Err(DV_E_FORMATETC.into());
            }
            self.medium(f.cfFormat)
        }

        fn GetDataHere(&self, _f: *const FORMATETC, _m: *mut STGMEDIUM) -> WinResult<()> {
            Err(E_NOTIMPL.into())
        }

        fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
            // SAFETY: as in GetData.
            let f = unsafe { &*pformatetc };
            if self.supports(f) {
                S_OK
            } else {
                DV_E_FORMATETC
            }
        }

        fn GetCanonicalFormatEtc(&self, _i: *const FORMATETC, _o: *mut FORMATETC) -> HRESULT {
            E_NOTIMPL
        }

        fn SetData(&self, _f: *const FORMATETC, _m: *const STGMEDIUM, _r: BOOL) -> WinResult<()> {
            Err(E_NOTIMPL.into())
        }

        fn EnumFormatEtc(&self, _dwdirection: u32) -> WinResult<IEnumFORMATETC> {
            // SAFETY: the shell copies the slice into its own enumerator.
            unsafe { SHCreateStdEnumFmtEtc(&self.formats()) }
        }

        fn DAdvise(
            &self,
            _f: *const FORMATETC,
            _advf: u32,
            _sink: windows::core::Ref<'_, IAdviseSink>,
        ) -> WinResult<u32> {
            Err(OLE_E_ADVISENOTSUPPORTED.into())
        }

        fn DUnadvise(&self, _c: u32) -> WinResult<()> {
            Err(OLE_E_ADVISENOTSUPPORTED.into())
        }

        fn EnumDAdvise(&self) -> WinResult<IEnumSTATDATA> {
            Err(OLE_E_ADVISENOTSUPPORTED.into())
        }
    }

    /// The drop source: Escape cancels, releasing the left button drops, default cursors.
    #[implement(IDropSource)]
    struct Source;

    impl IDropSource_Impl for Source_Impl {
        fn QueryContinueDrag(&self, escape: BOOL, keys: MODIFIERKEYS_FLAGS) -> HRESULT {
            if escape.as_bool() {
                DRAGDROP_S_CANCEL
            } else if keys.0 & MK_LBUTTON.0 == 0 {
                DRAGDROP_S_DROP
            } else {
                S_OK
            }
        }

        fn GiveFeedback(&self, _effect: DROPEFFECT) -> HRESULT {
            DRAGDROP_S_USEDEFAULTCURSORS
        }
    }

    /// One OLE drag on the current (STA) thread; `OleInitialize` must already be done.
    fn drag_on_this_thread(hdrop: Vec<u8>, allow_move: bool) -> Result<DragOutcome, String> {
        let effect_format = preferred_drop_effect_format();
        let data: IDataObject = PathsData {
            hdrop,
            effect: if allow_move {
                DROPEFFECT_MOVE
            } else {
                DROPEFFECT_COPY
            },
            effect_format,
        }
        .into();
        let source: IDropSource = Source.into();
        let allowed = DROPEFFECT(DROPEFFECT_COPY | if allow_move { DROPEFFECT_MOVE } else { 0 });
        let mut effect = DROPEFFECT(0);
        // SAFETY: both objects live for the call; `effect` receives the target's choice.
        let hr = unsafe { DoDragDrop(&data, &source, allowed, &mut effect) };
        if hr == DRAGDROP_S_DROP {
            Ok(DragOutcome {
                effect: effect_from(effect.0),
            })
        } else if hr == DRAGDROP_S_CANCEL {
            Ok(DragOutcome {
                effect: super::DragEffect::None,
            })
        } else {
            Err(format!("DoDragDrop: {hr}"))
        }
    }

    /// OLE reads the mouse itself; nothing to watch ahead of the drag.
    pub fn prepare_window<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) {}

    /// Run `DoDragDrop` on the calling thread, which must be the thread that owns the window
    /// the mouse went down in — only the foreground window's thread may capture the mouse, so
    /// a drag started from a worker thread ends at once with no effect. The drag pumps its own
    /// messages, so the UI stays alive while it runs; `done` is called when it returns.
    pub fn start_drag(
        _window: &tauri::WebviewWindow,
        paths: &[String],
        allow_move: bool,
        done: Done,
    ) {
        let hdrop = encode_hdrop(paths);
        // SAFETY: OLE may already be initialised on this thread (the webview's is); a second
        // call answers S_FALSE and still needs its OleUninitialize, which follows below.
        let init = unsafe { OleInitialize(None) };
        let result = drag_on_this_thread(hdrop, allow_move);
        if init.is_ok() {
            // SAFETY: pairs with the OleInitialize above on this thread.
            unsafe { OleUninitialize() };
        }
        done(result);
    }
}

/// ⚠ Written and type-checked on Windows (`cargo check --target aarch64-apple-darwin`), not
/// yet run on a Mac. What a Mac must confirm: the drag image appears, Finder / the Desktop /
/// a browser upload box / Mail take the drop, ⌥ copies and ⌘ moves during the drag, and a
/// move re-reads the folder.
#[cfg(target_os = "macos")]
mod imp {
    use std::cell::RefCell;

    use block2::RcBlock;
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::{AnyObject, MessageReceiver, NSObject, NSObjectProtocol, Sel};
    use objc2::{class, define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::{NSArray, NSString};

    use super::{
        effect_from_ns, pick_mac_drag_event, Done, DragEffect, DragOutcome, MacDragEvent, MacEvent,
        NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED, NS_EVENT_TYPE_LEFT_MOUSE_UP,
    };

    /// `NSDragOperation` bits (NSDragging.h).
    const NS_DRAG_OPERATION_COPY: usize = 1;
    const NS_DRAG_OPERATION_GENERIC: usize = 4;
    const NS_DRAG_OPERATION_MOVE: usize = 16;
    /// `NSEventMask` bits (NSEvent.h): `1 << NSEventType`.
    const NS_EVENT_MASK_LEFT_MOUSE_DOWN: usize = 1 << 1;
    const NS_EVENT_MASK_LEFT_MOUSE_UP: usize = 1 << 2;
    const NS_EVENT_MASK_LEFT_MOUSE_DRAGGED: usize = 1 << 6;
    /// The drag image: the file's icon at this size, centred under the pointer.
    const ICON_PT: f64 = 32.0;

    struct Ivars {
        mask: usize,
        /// The NSWindow the press was in: where the synthetic left-up goes when the session ends.
        window: Retained<AnyObject>,
        done: RefCell<Option<Done>>,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements and `DragSource` has no Drop.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "TroveDragSource"]
        #[ivars = Ivars]
        struct DragSource;

        unsafe impl NSObjectProtocol for DragSource {}

        /// `NSDraggingSource`: the one required method and the end-of-drag report. AppKit
        /// looks the methods up by selector, so no protocol declaration is needed.
        impl DragSource {
            #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
            fn source_operation_mask(&self, _session: &AnyObject, _context: isize) -> usize {
                self.ivars().mask
            }

            #[unsafe(method(draggingSession:endedAtPoint:operation:))]
            fn ended(&self, _session: &AnyObject, _point: CGPoint, operation: usize) {
                // the press is over for every layer, before the page hears the outcome
                release_press(&self.ivars().window);
                if let Some(done) = self.ivars().done.borrow_mut().take() {
                    done(Ok(DragOutcome {
                        effect: effect_from_ns(operation),
                    }));
                }
            }

            #[unsafe(method(ignoreModifierKeysForDraggingSession:))]
            fn ignore_modifier_keys(&self, _session: &AnyObject) -> bool {
                // ⌥ copies, ⌘ moves, the Finder way
                false
            }
        }
    );

    impl DragSource {
        fn new(
            mtm: MainThreadMarker,
            mask: usize,
            window: Retained<AnyObject>,
            done: Done,
        ) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(Ivars {
                mask,
                window,
                done: RefCell::new(Some(done)),
            });
            // SAFETY: NSObject's plain init on a freshly allocated instance.
            unsafe { msg_send![super(this), init] }
        }

        fn take_done(&self) -> Option<Done> {
            self.ivars().done.borrow_mut().take()
        }
    }

    thread_local! {
        /// The source of the drag in flight. The session does not promise to retain its
        /// source, so it is held here until the next drag replaces it (one at a time).
        static LIVE: RefCell<Option<Retained<DragSource>>> = const { RefCell::new(None) };
        /// The last left-down / left-dragged the monitor saw, in any of our windows; cleared
        /// on left-up. Main-thread only, like every NSEvent.
        static LAST_LEFT: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
        /// The installed monitor, kept so it is installed once per process.
        static MONITOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
    }

    /// Set once the monitor is installed. `MONITOR` is thread-local, so other threads cannot see
    /// it; this flag is the process-wide answer to "is it installed".
    static INSTALLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

    /// `-[NSEvent type]`. ⛔ Not `msg_send![.., r#type]`: `stringify!` keeps the `r#`, so that
    /// registers the selector "r#type", which NSEvent does not answer — the raw selector.
    fn event_kind(event: &AnyObject) -> usize {
        // SAFETY: `-[NSEvent type]` takes nothing and returns NSEventType (NSUInteger).
        unsafe { MessageReceiver::send_message(event, Sel::register(c"type"), ()) }
    }

    /// The address of the object's `window` (NSEvent and NSView both answer it), 0 for nil.
    fn window_ptr(object: &AnyObject) -> usize {
        // SAFETY: `window` returns an NSWindow or nil.
        let window: Option<Retained<AnyObject>> = unsafe { msg_send![object, window] };
        window.map_or(0, |w| Retained::as_ptr(&w) as usize)
    }

    fn facts(event: &AnyObject) -> MacEvent {
        MacEvent {
            kind: event_kind(event),
            window: window_ptr(event),
        }
    }

    /// Install, once, a local NSEvent monitor for left-down / left-dragged / left-up that
    /// remembers the last press-or-drag and lets every event through unchanged. tao, wry and
    /// tauri install no monitor of their own (grepped at tao 0.35.3 / wry 0.55.1 / tauri
    /// 2.11.6), and a local monitor that returns its event is invisible to the webview.
    pub fn prepare_window<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) {
        // Windows opened by the async `open_window` command are built off the main thread, after
        // the main window's setup already installed the process-wide monitor: nothing to do.
        if INSTALLED.load(std::sync::atomic::Ordering::Acquire) {
            return;
        }
        if MainThreadMarker::new().is_none() {
            log::warn!("drag out: the event monitor must be installed on the main thread");
            return;
        }
        if MONITOR.with(|m| m.borrow().is_some()) {
            return;
        }
        let handler = RcBlock::new(|event: *mut AnyObject| -> *mut AnyObject {
            // SAFETY: AppKit hands a live NSEvent for the duration of the call (never nil).
            if let Some(e) = unsafe { event.as_ref() } {
                let next = if event_kind(e) == NS_EVENT_TYPE_LEFT_MOUSE_UP {
                    None
                } else {
                    // SAFETY: `event` is a valid object; retaining it keeps it alive in LAST_LEFT.
                    unsafe { Retained::retain(event) }
                };
                LAST_LEFT.with(|last| *last.borrow_mut() = next);
            }
            event
        });
        let mask = NS_EVENT_MASK_LEFT_MOUSE_DOWN
            | NS_EVENT_MASK_LEFT_MOUSE_DRAGGED
            | NS_EVENT_MASK_LEFT_MOUSE_UP;
        // SAFETY: a documented NSEvent class method taking an NSEventMask (NSUInteger) and a
        // `NSEvent * (^)(NSEvent *)` block; AppKit copies the block. Returns the monitor or nil.
        let monitor: Option<Retained<AnyObject>> = unsafe {
            msg_send![class!(NSEvent), addLocalMonitorForEventsMatchingMask: mask, handler: &*handler]
        };
        if monitor.is_none() {
            log::warn!("drag out: AppKit refused the event monitor");
        }
        let installed = monitor.is_some();
        MONITOR.with(|m| *m.borrow_mut() = monitor);
        INSTALLED.store(installed, std::sync::atomic::Ordering::Release);
    }

    /// A fresh `NSEventTypeLeftMouseDragged` for `window` at the pointer's current position,
    /// with the live modifier flags, the way Chromium starts its drag when the current event
    /// is unusable.
    fn synthesized_event(window: &AnyObject) -> Option<Retained<AnyObject>> {
        // SAFETY: documented NSWindow / NSEvent / NSProcessInfo getters taking nothing.
        let (location, number, flags, uptime): (CGPoint, isize, usize, f64) = unsafe {
            let info: Retained<AnyObject> = msg_send![class!(NSProcessInfo), processInfo];
            (
                msg_send![window, mouseLocationOutsideOfEventStream],
                msg_send![window, windowNumber],
                msg_send![class!(NSEvent), modifierFlags],
                msg_send![&*info, systemUptime],
            )
        };
        // SAFETY: the documented NSEvent factory; a nil graphics context is what AppKit wants
        // today, `pressure` is a C float. Returns the event or nil.
        unsafe {
            msg_send![
                class!(NSEvent),
                mouseEventWithType: NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED,
                location: location,
                modifierFlags: flags,
                timestamp: uptime,
                windowNumber: number,
                context: Option::<&AnyObject>::None,
                eventNumber: 0isize,
                clickCount: 1isize,
                pressure: 1.0f32
            ]
        }
    }

    /// The session ran its own event loop and ate the press's left-up, so neither the window
    /// nor WKWebView ever saw it. WebKit's `EventHandlerMac.mm` names that hole ("AppKit
    /// widgets run their own event loops and consume events while the mouse is down ... the
    /// mouseUp, which we never saw") and WKWebView closes it for its OWN drags from
    /// `draggingSession:endedAtPoint:operation:` (`WebViewImpl::draggingSessionEnded` →
    /// `sendDragEndToPage`); our source is not WKWebView, so that never runs. Left as is,
    /// WebCore's `PointerCaptureController` still has the mouse pointer "pressed" and turns
    /// the NEXT `mousedown` into a `pointermove` (its chorded-button rule), which is the Mac
    /// every-second-drag-loses-its-press. The cure is the up itself: a left-up through
    /// `-[NSWindow sendEvent:]`, which routes it to the view that took the down (WKWebView),
    /// so WebKit, its gesture recognizers and the page all end the press. Sent synchronously,
    /// before `done`, so the page's `pointerup` is on its way before the outcome lands.
    /// Its location is outside the view (-1, -1 in window space), where the pointer in truth
    /// is after a drop in another app. WebCore still fires a `click` at the row that took the
    /// down (measured on macOS 27); the page's armed `swallowClick` eats it, which is why the
    /// OS drag's `leave` mid-handoff must not disarm it (`drag.cancel`). The local monitor
    /// does not see a `sendEvent:`, so the cached press is cleared here too.
    fn release_press(window: &AnyObject) {
        // SAFETY: documented NSWindow / NSEvent / NSProcessInfo getters taking nothing.
        let (number, flags, uptime): (isize, usize, f64) = unsafe {
            let info: Retained<AnyObject> = msg_send![class!(NSProcessInfo), processInfo];
            (
                msg_send![window, windowNumber],
                msg_send![class!(NSEvent), modifierFlags],
                msg_send![&*info, systemUptime],
            )
        };
        // SAFETY: the documented NSEvent factory (see `synthesized_event`). Returns the event
        // or nil.
        let up: Option<Retained<AnyObject>> = unsafe {
            msg_send![
                class!(NSEvent),
                mouseEventWithType: NS_EVENT_TYPE_LEFT_MOUSE_UP,
                location: CGPoint::new(-1.0, -1.0),
                modifierFlags: flags,
                timestamp: uptime,
                windowNumber: number,
                context: Option::<&AnyObject>::None,
                eventNumber: 0isize,
                clickCount: 1isize,
                pressure: 0.0f32
            ]
        };
        match up {
            // SAFETY: `sendEvent:` takes an NSEvent; the window is retained by the source.
            Some(up) => unsafe {
                let _: () = msg_send![window, sendEvent: &*up];
                log::debug!("drag out: sent the left-up that ends the press to window {number}");
            },
            None => log::warn!("drag out: AppKit refused to build the left-up that ends the press"),
        }
        LAST_LEFT.with(|last| *last.borrow_mut() = None);
    }

    /// The event the session starts from, per [`pick_mac_drag_event`]; `Ok(None)` when the
    /// button is already up and there is nothing to drag.
    fn drag_event(view: &AnyObject) -> Result<Option<Retained<AnyObject>>, String> {
        // SAFETY: `+[NSApplication sharedApplication]`, `-currentEvent` (may be nil) and
        // `+[NSEvent pressedMouseButtons]` take nothing.
        let (current, pressed): (Option<Retained<AnyObject>>, usize) = unsafe {
            let app: Retained<AnyObject> = msg_send![class!(NSApplication), sharedApplication];
            (
                msg_send![&*app, currentEvent],
                msg_send![class!(NSEvent), pressedMouseButtons],
            )
        };
        let cached = LAST_LEFT.with(|last| last.borrow().clone());
        let view_window = window_ptr(view);
        let pick = pick_mac_drag_event(
            current.as_deref().map(facts),
            cached.as_deref().map(facts),
            view_window,
            pressed & 1 != 0,
        )?;
        log::debug!("drag out: starting from the {pick:?} event");
        match pick {
            MacDragEvent::Current => Ok(current),
            MacDragEvent::Cached => Ok(cached),
            MacDragEvent::ButtonUp => Ok(None),
            MacDragEvent::Synthesized => {
                // SAFETY: `window` returns an NSWindow; non-nil here (view_window != 0).
                let window: Option<Retained<AnyObject>> = unsafe { msg_send![view, window] };
                let window = window.ok_or_else(|| "the view has no window".to_string())?;
                synthesized_event(&window)
                    .map(Some)
                    .ok_or_else(|| "AppKit refused to build the drag's event".to_string())
            }
        }
    }

    /// One `NSDraggingItem` per path: a file URL as the pasteboard writer, the file's icon as
    /// the drag image, each a little further down-right so a stack of files reads as a stack.
    fn items(paths: &[String], at: CGPoint) -> Retained<NSArray<AnyObject>> {
        // SAFETY: `+[NSWorkspace sharedWorkspace]` takes nothing and returns the shared object.
        let ws: Retained<AnyObject> = unsafe { msg_send![class!(NSWorkspace), sharedWorkspace] };
        let items: Vec<Retained<AnyObject>> = paths
            .iter()
            .enumerate()
            // a path no file URL can hold (empty, or an archive member's with a NUL) is left
            // out rather than aborting the app on Foundation's nil
            .filter_map(|(i, path)| {
                let url = crate::core::open_with_mac::file_url(std::path::Path::new(path))?;
                let ns_path = NSString::from_str(path);
                // SAFETY: `initWithPasteboardWriter:` takes any NSPasteboardWriting object;
                // NSURL is one. `iconForFile:` returns an NSImage for any path.
                let item: Retained<AnyObject> = unsafe {
                    let alloc: Allocated<AnyObject> = msg_send![class!(NSDraggingItem), alloc];
                    msg_send![alloc, initWithPasteboardWriter: &*url]
                };
                let icon: Retained<AnyObject> = unsafe { msg_send![&*ws, iconForFile: &*ns_path] };
                let step = (i.min(3) as f64) * 4.0;
                let frame = CGRect::new(
                    CGPoint::new(at.x - ICON_PT / 2.0 + step, at.y - ICON_PT / 2.0 - step),
                    CGSize::new(ICON_PT, ICON_PT),
                );
                // SAFETY: a documented NSDraggingItem setter taking an NSRect and an NSImage.
                let _: () = unsafe { msg_send![&*item, setDraggingFrame: frame, contents: &*icon] };
                Some(item)
            })
            .collect();
        NSArray::from_retained_slice(&items)
    }

    /// Begin an AppKit dragging session from the window's content view. Returns at once; the
    /// session runs in the main run loop and `done` is called from the source's end report.
    pub fn start_drag(
        window: &tauri::WebviewWindow,
        paths: &[String],
        allow_move: bool,
        done: Done,
    ) {
        let Some(mtm) = MainThreadMarker::new() else {
            return done(Err("drag out must start on the main thread".to_string()));
        };
        let view = match window.ns_view() {
            Ok(v) if !v.is_null() => v,
            Ok(_) => return done(Err("the window has no view".to_string())),
            Err(e) => return done(Err(format!("ns view: {e}"))),
        };
        // SAFETY: tao hands back the window's content NSView, alive as long as the window.
        let view: &AnyObject = unsafe { &*(view as *const AnyObject) };
        let event = match drag_event(view) {
            Ok(Some(e)) => e,
            // the button is already up: the drag ended before it could leave the window
            Ok(None) => {
                return done(Ok(DragOutcome {
                    effect: DragEffect::None,
                }))
            }
            Err(e) => return done(Err(e)),
        };
        // SAFETY: `locationInWindow` returns an NSPoint; `convertPoint:fromView:` with a nil
        // view converts from window coordinates.
        let at: CGPoint = unsafe {
            let in_window: CGPoint = msg_send![&*event, locationInWindow];
            msg_send![view, convertPoint: in_window, fromView: Option::<&AnyObject>::None]
        };
        let mask = NS_DRAG_OPERATION_COPY
            | if allow_move {
                NS_DRAG_OPERATION_MOVE | NS_DRAG_OPERATION_GENERIC
            } else {
                0
            };
        // SAFETY: `window` returns an NSWindow or nil; `drag_event` already proved it is set.
        let window: Option<Retained<AnyObject>> = unsafe { msg_send![view, window] };
        let Some(window) = window else {
            return done(Err("the view has no window".to_string()));
        };
        let items = items(paths, at);
        if items.count() == 0 {
            return done(Err("nothing here can be dragged out".to_string()));
        }
        let source = DragSource::new(mtm, mask, window, done);
        // SAFETY: a documented NSView method; the items, the event and the source are all
        // alive for the call, and the source stays alive in LIVE for the session.
        let session: Option<Retained<AnyObject>> = unsafe {
            msg_send![view, beginDraggingSessionWithItems: &*items, event: &*event, source: &*source]
        };
        if session.is_none() {
            if let Some(done) = source.take_done() {
                done(Err("AppKit refused the drag".to_string()));
            }
            return;
        }
        LIVE.with(|live| *live.borrow_mut() = Some(source));
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::cell::RefCell;
    use std::rc::Rc;

    use gtk::gdk::{self, DragAction};
    use gtk::glib::{Propagation, SignalHandlerId};
    use gtk::prelude::*;

    use super::{effect_from_gdk, same_window, uri_list, Done, DragEffect, DragOutcome};

    thread_local! {
        /// The last left-button press in any of our webviews, cleared on its release. GTK's
        /// drag wants the press that started the gesture: it is passed so GTK has a real button
        /// event, with the right timestamp and window, to start from (the X11 grab uses its
        /// time). On Wayland GTK takes the serial from the seat's last press, not from this
        /// event. `gtk::current_event()` at handoff time is the leave-notify or a motion, not
        /// the press.
        static LAST_PRESS: RefCell<Option<gdk::Event>> = const { RefCell::new(None) };
        /// Every WebKit widget we watch, so the one under the drag's window can be handed the
        /// release the drag ate (see `release_press`). Weak: a closed window takes its own.
        static WEBVIEWS: RefCell<Vec<gtk::glib::WeakRef<gtk::Widget>>> = const { RefCell::new(Vec::new()) };
    }

    /// The toplevel GdkWindow's address under the event, 0 when it has none.
    fn toplevel_of(event: &gdk::Event) -> Option<usize> {
        event.window().map(|w| w.toplevel().as_ptr() as usize)
    }

    /// Watch the WebKit widget's button presses. ⛔ The webview is where the press lands and it
    /// handles it (stops propagation), so a handler on the toplevel window would never see
    /// it; a handler connected to the widget runs before WebKit's class handler and answers
    /// `Proceed`, so the page still gets the click.
    pub fn prepare_window<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
        if let Err(e) = window.with_webview(|webview| {
            let webview = webview.inner();
            let widget: gtk::Widget = webview.clone().upcast();
            WEBVIEWS.with(|all| {
                let mut all = all.borrow_mut();
                all.retain(|w| w.upgrade().is_some());
                all.push(widget.downgrade());
            });
            webview.connect_button_press_event(|_, event| {
                if event.button() == 1 {
                    let copy: gdk::Event = (**event).clone();
                    LAST_PRESS.with(|last| *last.borrow_mut() = Some(copy));
                }
                Propagation::Proceed
            });
            webview.connect_button_release_event(|_, event| {
                if event.button() == 1 {
                    LAST_PRESS.with(|last| *last.borrow_mut() = None);
                }
                Propagation::Proceed
            });
        }) {
            log::warn!("drag out: could not watch the webview's button presses: {e}");
        }
    }

    /// The event the drag starts from: the cached press when it was in this window, else
    /// whatever GTK is dispatching now (the pre-fix behaviour, as a fallback).
    fn drag_event(widget: &gtk::Widget) -> Option<gdk::Event> {
        let mine = widget.window().map(|w| w.toplevel().as_ptr() as usize);
        let cached = LAST_PRESS.with(|last| last.borrow().clone());
        match cached {
            Some(press) if same_window(toplevel_of(&press), mine) => {
                log::debug!("drag out: starting from the cached press");
                Some(press)
            }
            _ => {
                log::debug!("drag out: no cached press for this window, using the current event");
                gtk::current_event()
            }
        }
    }

    /// What the drag's signal handlers share; emptied by whichever of them ends the drag.
    struct Live {
        done: Done,
        handlers: Vec<SignalHandlerId>,
        /// `drag-data-delete` fired: the target asked for the source to go (a move).
        deleted: bool,
        /// `drag-failed` fired: nothing took the drop.
        failed: bool,
    }

    type Shared = Rc<RefCell<Option<Live>>>;

    /// The drag's grab ate the press's button-release, so WebKit never saw it: WebCore's
    /// `PointerCaptureController` still has the mouse "pressed" and turns the NEXT press into a
    /// `pointermove` (its chorded-button rule) — the same hole as the Mac's. GTK itself sends a
    /// release pair to the drag's source widget from `gtk_drag_end` (gtkdnd.c) for exactly
    /// this reason, but our source is the toplevel, not the WebKit widget, so WebKit gets
    /// nothing. The same pair, done by hand: the cached press, re-typed as a release at this
    /// moment, propagated to the WebKit widget under the drag's window. Sent before `done`.
    /// Moved to (-1, -1), just outside the widget, as on the Mac: left at the press's own
    /// spot, WebCore's `click` would land on the dragged row, and whether the page still
    /// swallows it would hang on whether it beats the drag's outcome there.
    fn release_press(window: &gtk::Widget) {
        let Some(press) = LAST_PRESS.with(|last| last.borrow_mut().take()) else {
            log::debug!("drag out: no original press to release, skipping the left-up");
            return;
        };
        let mine = window.window().map(|w| w.toplevel().as_ptr() as usize);
        let webview = WEBVIEWS.with(|all| {
            all.borrow()
                .iter()
                .filter_map(|w| w.upgrade())
                .find(|w| same_window(w.window().map(|g| g.toplevel().as_ptr() as usize), mine))
        });
        let Some(webview) = webview else {
            log::debug!("drag out: no WebKit widget under this window to hand the release to");
            return;
        };
        let mut release = press;
        if let Some(button) = release.downcast_mut::<gdk::EventButton>() {
            let raw = button.as_mut();
            raw.type_ = gdk::ffi::GDK_BUTTON_RELEASE;
            raw.time = gtk::current_event_time();
            raw.x_root -= raw.x + 1.0;
            raw.y_root -= raw.y + 1.0;
            raw.x = -1.0;
            raw.y = -1.0;
        }
        gtk::propagate_event(&webview, &mut release);
    }

    /// End the drag once: disconnect every handler, end the press, report.
    fn finish(widget: &gtk::Widget, shared: &Shared, action: DragAction) {
        let Some(live) = shared.borrow_mut().take() else {
            return;
        };
        for id in live.handlers {
            widget.disconnect(id);
        }
        release_press(widget);
        let effect = if live.failed {
            DragEffect::None
        } else if live.deleted {
            DragEffect::Move
        } else {
            effect_from_gdk(action.bits())
        };
        (live.done)(Ok(DragOutcome { effect }));
    }

    /// Begin a GTK drag from the window widget. Returns at once; GTK runs the drag in the main
    /// loop, asks `drag-data-get` for the URIs when a target wants them and ends with
    /// `drag-end` (after `drag-data-delete` for a move, `drag-failed` for a miss).
    pub fn start_drag(
        window: &tauri::WebviewWindow,
        paths: &[String],
        allow_move: bool,
        done: Done,
    ) {
        let widget: gtk::Widget = match window.gtk_window() {
            Ok(w) => w.upcast(),
            Err(e) => return done(Err(format!("gtk window: {e}"))),
        };
        let uris = uri_list(paths);
        let targets = gtk::TargetList::new(&[gtk::TargetEntry::new(
            "text/uri-list",
            gtk::TargetFlags::empty(),
            0,
        )]);
        let actions = DragAction::COPY
            | if allow_move {
                DragAction::MOVE
            } else {
                DragAction::empty()
            };
        let shared: Shared = Rc::new(RefCell::new(Some(Live {
            done,
            handlers: Vec::new(),
            deleted: false,
            failed: false,
        })));
        let get = widget.connect_drag_data_get(move |_, _, data, _, _| {
            let refs: Vec<&str> = uris.iter().map(String::as_str).collect();
            data.set_uris(&refs);
        });
        let delete = widget.connect_drag_data_delete({
            let shared = shared.clone();
            move |_, _| {
                if let Some(live) = shared.borrow_mut().as_mut() {
                    live.deleted = true;
                }
            }
        });
        let failed = widget.connect_drag_failed({
            let shared = shared.clone();
            move |_, _, _| {
                if let Some(live) = shared.borrow_mut().as_mut() {
                    live.failed = true;
                }
                // GTK still plays its snap-back animation
                Propagation::Proceed
            }
        });
        let end = widget.connect_drag_end({
            let shared = shared.clone();
            move |widget, context| finish(widget, &shared, context.selected_action())
        });
        if let Some(live) = shared.borrow_mut().as_mut() {
            live.handlers = vec![get, delete, failed, end];
        }
        // the pointer is still down from the row press: button 1, that press (GTK finds the
        // pointer position itself when x and y are -1)
        let event = drag_event(&widget);
        let context =
            widget.drag_begin_with_coordinates(&targets, actions, 1, event.as_ref(), -1, -1);
        if context.is_none() {
            let Some(live) = shared.borrow_mut().take() else {
                return;
            };
            for id in live.handlers {
                widget.disconnect(id);
            }
            (live.done)(Err("GTK refused the drag".to_string()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ole_effects_map_move_over_copy_and_ignore_link() {
        assert_eq!(effect_from(0), DragEffect::None);
        assert_eq!(effect_from(1), DragEffect::Copy);
        assert_eq!(effect_from(2), DragEffect::Move);
        assert_eq!(effect_from(3), DragEffect::Move);
        assert_eq!(effect_from(4), DragEffect::None);
    }

    #[test]
    fn appkit_operations_treat_generic_as_a_move_and_link_as_a_copy() {
        assert_eq!(effect_from_ns(0), DragEffect::None);
        assert_eq!(effect_from_ns(1), DragEffect::Copy);
        assert_eq!(effect_from_ns(2), DragEffect::Copy);
        assert_eq!(effect_from_ns(4), DragEffect::Move);
        assert_eq!(effect_from_ns(16), DragEffect::Move);
        assert_eq!(effect_from_ns(16 | 1), DragEffect::Move);
    }

    #[test]
    fn gdk_actions_map_move_copy_link_and_none() {
        assert_eq!(effect_from_gdk(0), DragEffect::None);
        assert_eq!(effect_from_gdk(2), DragEffect::Copy);
        assert_eq!(effect_from_gdk(4), DragEffect::Move);
        assert_eq!(effect_from_gdk(8), DragEffect::Copy);
        assert_eq!(effect_from_gdk(4 | 2), DragEffect::Move);
    }

    #[test]
    fn file_uris_keep_slashes_and_escape_spaces_and_utf8() {
        assert_eq!(file_uri("/home/alex/a.txt"), "file:///home/alex/a.txt");
        assert_eq!(
            file_uri("/home/alex/my file.txt"),
            "file:///home/alex/my%20file.txt"
        );
        assert_eq!(file_uri("/tmp/caf\u{e9}"), "file:///tmp/caf%C3%A9");
        assert_eq!(file_uri("/a/b#c?d%e"), "file:///a/b%23c%3Fd%25e");
        assert_eq!(file_uri("/a/it's (1).txt"), "file:///a/it's%20(1).txt");
    }

    #[test]
    fn a_uri_list_keeps_the_order() {
        let list = uri_list(&["/x/1".to_string(), "/x/2 2".to_string()]);
        assert_eq!(list, vec!["file:///x/1", "file:///x/2%202"]);
    }

    #[test]
    fn an_empty_drag_is_refused_before_any_native_call() {
        assert!(validate(&[]).is_err());
        assert!(validate(&["/x".to_string()]).is_ok());
    }

    const WIN: usize = 0x1000;
    const OTHER: usize = 0x2000;
    const MOUSE_EXITED: usize = 9;

    fn ev(kind: usize, window: usize) -> Option<MacEvent> {
        Some(MacEvent { kind, window })
    }

    #[test]
    fn same_window_needs_both_known_and_equal() {
        assert!(same_window(Some(WIN), Some(WIN)));
        assert!(!same_window(Some(WIN), Some(OTHER)));
        assert!(!same_window(None, Some(WIN)));
        assert!(!same_window(Some(WIN), None));
        assert!(!same_window(Some(0), Some(0)));
    }

    #[test]
    fn mac_uses_the_current_event_when_it_is_the_drags_own() {
        for kind in [
            NS_EVENT_TYPE_LEFT_MOUSE_DOWN,
            NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED,
        ] {
            assert_eq!(
                pick_mac_drag_event(ev(kind, WIN), None, WIN, true),
                Ok(MacDragEvent::Current)
            );
        }
    }

    #[test]
    fn mac_falls_back_to_the_cached_press_when_current_is_the_leave_event() {
        // the 12 of 23: currentEvent is mouseExited (type 9) at handoff time
        assert_eq!(
            pick_mac_drag_event(
                ev(MOUSE_EXITED, WIN),
                ev(NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED, WIN),
                WIN,
                true
            ),
            Ok(MacDragEvent::Cached)
        );
        // no current event at all
        assert_eq!(
            pick_mac_drag_event(None, ev(NS_EVENT_TYPE_LEFT_MOUSE_DOWN, WIN), WIN, true),
            Ok(MacDragEvent::Cached)
        );
    }

    #[test]
    fn mac_ignores_events_from_another_window() {
        assert_eq!(
            pick_mac_drag_event(
                ev(NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED, OTHER),
                ev(NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED, OTHER),
                WIN,
                true
            ),
            Ok(MacDragEvent::Synthesized)
        );
        assert_eq!(
            pick_mac_drag_event(
                ev(NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED, OTHER),
                ev(NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED, WIN),
                WIN,
                true
            ),
            Ok(MacDragEvent::Cached)
        );
    }

    #[test]
    fn mac_synthesizes_when_no_real_event_fits_but_the_button_is_down() {
        assert_eq!(
            pick_mac_drag_event(ev(MOUSE_EXITED, WIN), None, WIN, true),
            Ok(MacDragEvent::Synthesized)
        );
        assert_eq!(
            pick_mac_drag_event(None, ev(NS_EVENT_TYPE_LEFT_MOUSE_UP, WIN), WIN, true),
            Ok(MacDragEvent::Synthesized)
        );
    }

    #[test]
    fn mac_trusts_a_real_press_or_drag_over_the_hid_button_state() {
        // a trackpad's tap-to-drag / three-finger drag: the page saw the button down and a
        // real dragged event exists, but pressedMouseButtons may say nothing is pressed
        assert_eq!(
            pick_mac_drag_event(ev(NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED, WIN), None, WIN, false),
            Ok(MacDragEvent::Current)
        );
        assert_eq!(
            pick_mac_drag_event(
                ev(MOUSE_EXITED, WIN),
                ev(NS_EVENT_TYPE_LEFT_MOUSE_DOWN, WIN),
                WIN,
                false
            ),
            Ok(MacDragEvent::Cached)
        );
    }

    #[test]
    fn mac_ends_quietly_only_when_no_real_event_fits_and_the_button_is_up() {
        assert_eq!(
            pick_mac_drag_event(None, None, WIN, false),
            Ok(MacDragEvent::ButtonUp)
        );
        assert_eq!(
            pick_mac_drag_event(ev(MOUSE_EXITED, WIN), None, WIN, false),
            Ok(MacDragEvent::ButtonUp)
        );
        assert_eq!(
            pick_mac_drag_event(
                ev(NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED, OTHER),
                ev(NS_EVENT_TYPE_LEFT_MOUSE_UP, WIN),
                WIN,
                false
            ),
            Ok(MacDragEvent::ButtonUp)
        );
    }

    #[test]
    fn mac_refuses_a_view_without_a_window() {
        assert!(
            pick_mac_drag_event(ev(NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED, WIN), None, 0, true).is_err()
        );
    }
}
