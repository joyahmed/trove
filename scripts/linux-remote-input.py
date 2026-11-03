#!/usr/bin/env python3
"""Send keys and pointer input into a GNOME Shell through org.gnome.Mutter.RemoteDesktop.

Meant for the private headless shell from scripts/linux-gnome-headless.sh: it talks ONLY to
the bus in DBUS_SESSION_BUS_ADDRESS, and refuses to run when that is the user's normal bus
unless --allow-session-bus is given.

    eval "$(scripts/linux-gnome-headless.sh env)"   # or pass --bus ADDRESS
    scripts/linux-remote-input.py key ctrl+l type 'hello' key Return
    scripts/linux-remote-input.py click 640 400 wait 0.5 key Escape

Actions (any number, run in order):
    key COMBO        e.g. ctrl+l, alt+space, ctrl+alt+space, Return, F2 (X keysym names)
    type TEXT        types each character as a keysym
    move X Y         absolute pointer motion in monitor pixels (needs the ScreenCast stream)
    click X Y [BTN]  move then press/release a button (1 left, 2 middle, 3 right)
    dclick X Y       a double-click (two left clicks 60 ms apart)
    press X Y        move there and hold the left button (a drag starts here)
    release          let the left button go (ends a drag at the pointer)
    rmove DX DY      relative pointer motion (no stream needed)
    wait SECONDS

Absolute motion: mutter maps it through a ScreenCast stream linked to the remote desktop
session, so this script records the primary monitor (pipewire must run on the same
XDG_RUNTIME_DIR; linux-gnome-headless.sh starts one).

Keys land in an app launched with GH_BACKEND=x11. A native Wayland Trove ignored them
(2026-10-23, mutter 50.1), so launch the app under x11 for any key or click check.
"""
import os
import sys
import time

import gi

gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gio, GLib  # noqa: E402

BTN = {1: 0x110, 2: 0x112, 3: 0x111}  # BTN_LEFT, BTN_MIDDLE, BTN_RIGHT (evdev codes)
ALIASES = {
    "ctrl": "Control_L", "control": "Control_L", "shift": "Shift_L", "alt": "Alt_L",
    "super": "Super_L", "meta": "Super_L", "enter": "Return", "esc": "Escape",
    "space": "space", "tab": "Tab", "backspace": "BackSpace", "del": "Delete",
}
RD = "org.gnome.Mutter.RemoteDesktop"
SC = "org.gnome.Mutter.ScreenCast"


def keysym(name):
    name = ALIASES.get(name.lower(), name)
    ks = Gdk.keyval_from_name(name)
    if ks in (0, 0xFFFFFF):
        sys.exit(f"unknown key name: {name}")
    return ks


class Remote:
    def __init__(self, bus_addr, need_stream):
        self.bus = Gio.DBusConnection.new_for_address_sync(
            bus_addr,
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT
            | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
            None, None)
        self.loop = GLib.MainContext.default()
        (self.rd,) = self.call(RD, "/org/gnome/Mutter/RemoteDesktop", RD, "CreateSession", None)
        self.stream = None
        if need_stream:
            sid = self.get(self.rd, RD + ".Session", "SessionId")
            (sc,) = self.call(SC, "/org/gnome/Mutter/ScreenCast", SC, "CreateSession",
                              GLib.Variant("(a{sv})", ({"remote-desktop-session-id":
                                                        GLib.Variant("s", sid)},)))
            # "" = primary monitor. cursor-mode 1 = embedded, so screenshots show the pointer.
            (self.stream,) = self.call(SC, sc, SC + ".Session", "RecordMonitor",
                                       GLib.Variant("(sa{sv})", ("", {"cursor-mode":
                                                                      GLib.Variant("u", 1)})))
            self.node = None
            self.bus.signal_subscribe(SC, SC + ".Stream", "PipeWireStreamAdded", self.stream,
                                      None, 0, self._on_node)
        self.call(RD, self.rd, RD + ".Session", "Start", None)
        if need_stream:
            end = time.time() + 5
            while self.node is None and time.time() < end:
                self.loop.iteration(False)
                time.sleep(0.02)
            if self.node is None:
                sys.exit("ScreenCast stream never started (is pipewire running on this "
                         "XDG_RUNTIME_DIR?)")
        # Xwayland drops the very first key of a new virtual keyboard (seen on mutter 50.1:
        # the first letter of "type abc" never reached an X11 client). Spend it on Shift.
        sh = keysym("Shift_L")
        self.s("NotifyKeyboardKeysym", "(ub)", sh, True)
        self.s("NotifyKeyboardKeysym", "(ub)", sh, False)
        self.pump(0.2)

    def _on_node(self, _c, _s, _p, _i, _sig, params):
        self.node = params.unpack()[0]

    def call(self, dest, path, iface, method, args):
        res = self.bus.call_sync(dest, path, iface, method, args, None, 0, 10000, None)
        return res.unpack() if res is not None else ()

    def get(self, path, iface, prop):
        (v,) = self.call(RD, path, "org.freedesktop.DBus.Properties", "Get",
                         GLib.Variant("(ss)", (iface, prop)))
        return v

    def s(self, method, fmt, *args):
        self.call(RD, self.rd, RD + ".Session", method, GLib.Variant(fmt, args))

    def pump(self, secs):
        end = time.time() + secs
        while time.time() < end:
            self.loop.iteration(False)
            time.sleep(0.01)

    def key(self, combo):
        syms = [keysym(p) for p in combo.split("+")] if combo != "+" else [keysym("plus")]
        for k in syms:
            self.s("NotifyKeyboardKeysym", "(ub)", k, True)
            self.pump(0.02)
        for k in reversed(syms):
            self.s("NotifyKeyboardKeysym", "(ub)", k, False)
            self.pump(0.02)

    def type(self, text):
        for ch in text:
            ks = Gdk.unicode_to_keyval(ord(ch))
            self.s("NotifyKeyboardKeysym", "(ub)", ks, True)
            self.s("NotifyKeyboardKeysym", "(ub)", ks, False)
            self.pump(0.02)

    def move(self, x, y):
        self.s("NotifyPointerMotionAbsolute", "(sdd)", self.stream, float(x), float(y))
        self.pump(0.05)

    def rmove(self, dx, dy):
        self.s("NotifyPointerMotionRelative", "(dd)", float(dx), float(dy))
        self.pump(0.05)

    def click(self, x, y, btn=1):
        # WebKitGTK ignored a press that arrived with a single motion event (Trove's sidebar
        # never saw it); hovering first, then a 1 px step onto the target, makes it land.
        self.move(float(x) - 1, y)
        self.pump(0.15)
        self.move(x, y)
        self.pump(0.1)
        self.s("NotifyPointerButton", "(ib)", BTN[int(btn)], True)
        self.pump(0.05)
        self.s("NotifyPointerButton", "(ib)", BTN[int(btn)], False)
        self.pump(0.05)

    def dclick(self, x, y):
        # two separate `click`s land ~0.45 s apart, past GTK's 400 ms double-click time
        self.move(float(x) - 1, y)
        self.pump(0.15)
        self.move(x, y)
        self.pump(0.1)
        for _ in range(2):
            self.s("NotifyPointerButton", "(ib)", BTN[1], True)
            self.pump(0.03)
            self.s("NotifyPointerButton", "(ib)", BTN[1], False)
            self.pump(0.03)

    def press(self, x, y):
        self.move(float(x) - 1, y)
        self.pump(0.15)
        self.move(x, y)
        self.pump(0.1)
        self.s("NotifyPointerButton", "(ib)", BTN[1], True)
        self.pump(0.1)

    def release(self):
        self.s("NotifyPointerButton", "(ib)", BTN[1], False)
        self.pump(0.1)

    def close(self):
        self.pump(0.2)
        try:
            self.call(RD, self.rd, RD + ".Session", "Stop", None)
        except GLib.Error:
            pass


def main(argv):
    bus = os.environ.get("DBUS_SESSION_BUS_ADDRESS", "")
    allow = False
    while argv and argv[0].startswith("--"):
        opt = argv.pop(0)
        if opt == "--bus":
            bus = argv.pop(0)
        elif opt == "--allow-session-bus":
            allow = True
        else:
            sys.exit(__doc__)
    if not argv:
        sys.exit(__doc__)
    if not bus:
        sys.exit("no bus: eval \"$(scripts/linux-gnome-headless.sh env)\" or pass --bus")
    if not allow and bus.startswith("unix:path=/run/user/"):
        sys.exit(f"refusing: {bus} looks like the desktop session bus (use --allow-session-bus)")
    need_stream = any(a in ("move", "click", "dclick", "press") for a in argv)
    r = Remote(bus, need_stream)
    i = 0
    try:
        while i < len(argv):
            a = argv[i]
            if a == "key":
                r.key(argv[i + 1]); i += 2
            elif a == "type":
                r.type(argv[i + 1]); i += 2
            elif a == "move":
                r.move(argv[i + 1], argv[i + 2]); i += 3
            elif a == "rmove":
                r.rmove(argv[i + 1], argv[i + 2]); i += 3
            elif a == "click":
                has_btn = i + 3 < len(argv) and argv[i + 3].isdigit()
                r.click(argv[i + 1], argv[i + 2], argv[i + 3] if has_btn else 1)
                i += 4 if has_btn else 3
            elif a == "dclick":
                r.dclick(argv[i + 1], argv[i + 2]); i += 3
            elif a == "press":
                r.press(argv[i + 1], argv[i + 2]); i += 3
            elif a == "release":
                r.release(); i += 1
            elif a == "wait":
                r.pump(float(argv[i + 1])); i += 2
            else:
                sys.exit(f"unknown action {a!r}\n{__doc__}")
    finally:
        r.close()


if __name__ == "__main__":
    main(sys.argv[1:])
