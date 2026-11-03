#!/usr/bin/env python3
"""Which video src can WebKitGTK's player load from a page served on a custom scheme, as Trove's is?
Tries file://, the custom scheme (answering Range), http://127.0.0.1 and blob:, one line each:
LOADS duration=..., ERROR <code>, or TIMEOUT. Plan 02 2.9: rerun after a WebKitGTK upgrade - if
the custom scheme ever LOADS, Linux can stream through preview:// and media-src.ts can go.

    scripts/linux-gnome-headless.sh start
    GH_BACKEND=x11 scripts/linux-gnome-headless.sh launch /usr/bin/python3 \
        scripts/linux-webkit-media-probe.py VIDEO.mp4 OUT.txt   # FILE_ACCESS=1 to allow file access
"""
import os, sys, gi
gi.require_version("Gtk", "3.0"); gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2, GLib, Gio

VIDEO, OUT = sys.argv[1], sys.argv[2]
DATA = open(VIDEO, "rb").read()
log = open(OUT, "w")
ranges = []

PAGE = """<!doctype html><body><script>
const out = (m) => window.webkit.messageHandlers.r.postMessage(m);
const tryOne = (name, src) => new Promise((done) => {
  const v = document.createElement('video'); v.muted = true; document.body.append(v);
  const t = setTimeout(() => { out(name + ': TIMEOUT readyState=' + v.readyState); done(); }, 6000);
  v.onerror = () => { clearTimeout(t); out(name + ': ERROR ' + (v.error && v.error.code) + ' ' + (v.error && v.error.message)); done(); };
  v.onloadedmetadata = () => { clearTimeout(t); out(name + ': LOADS duration=' + v.duration); done(); };
  v.src = src;
});
(async () => {
  await tryOne('file', 'file://VIDEO');
  await tryOne('custom', 'probe://media/test.mp4');
  await tryOne('http', 'http://127.0.0.1:PORT/test.mp4');
  const b = await (await fetch('probe://media/test.mp4')).blob();
  await tryOne('blob', URL.createObjectURL(b));
  out('DONE');
})();
</script></body>""".replace("VIDEO", VIDEO)


def on_scheme(req):
    path = req.get_path()
    if path == "/page":
        body, ctype, status = PAGE.encode(), "text/html", 200
        hdr = None
    else:
        rng = None
        try:
            h = req.get_http_headers()
            rng = h.get_one("Range") if h else None
        except Exception:
            pass
        ranges.append(rng)
        start, end = 0, len(DATA) - 1
        status = 200
        if rng and rng.startswith("bytes="):
            a, _, b = rng[6:].partition("-")
            start = int(a or 0); end = int(b) if b else len(DATA) - 1
            status = 206
        body, ctype = DATA[start:end + 1], "video/mp4"
        hdr = (start, end)
    stream = Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(body))
    resp = WebKit2.URISchemeResponse.new(stream, len(body))
    resp.set_status(status, None)
    resp.set_content_type(ctype)
    from gi.repository import Soup
    hs = Soup.MessageHeaders.new(Soup.MessageHeadersType.RESPONSE)
    hs.append("Accept-Ranges", "bytes")
    hs.append("Access-Control-Allow-Origin", "*")
    if hdr:
        hs.append("Content-Range", f"bytes {hdr[0]}-{hdr[1]}/{len(DATA)}")
    resp.set_http_headers(hs)
    req.finish_with_response(resp)


import http.server, threading, functools
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.dirname(VIDEO)))
threading.Thread(target=srv.serve_forever, daemon=True).start()
PAGE = PAGE.replace("PORT", str(srv.server_address[1]))
ctx = WebKit2.WebContext.get_default()
ctx.register_uri_scheme("probe", on_scheme)
ctx.get_security_manager().register_uri_scheme_as_cors_enabled("probe")
ctx.get_security_manager().register_uri_scheme_as_secure("probe")
ucm = WebKit2.UserContentManager()
ucm.register_script_message_handler("r")


def on_msg(_m, res):
    s = res.get_js_value().to_string()
    log.write(s + "\n"); log.flush()
    if s == "DONE":
        log.write("custom-scheme Range headers seen: %r\n" % ranges[:6]); log.close()
        Gtk.main_quit()


ucm.connect("script-message-received::r", on_msg)
view = WebKit2.WebView.new_with_user_content_manager(ucm)
st = view.get_settings(); st.set_enable_media(True)
if os.environ.get("FILE_ACCESS"):
    st.set_allow_file_access_from_file_urls(True); st.set_allow_universal_access_from_file_urls(True)
w = Gtk.Window(); w.set_default_size(400, 300); w.add(view); w.show_all()
view.load_uri("probe://app/page")
GLib.timeout_add_seconds(40, lambda: (log.write("GLOBAL TIMEOUT\n"), log.close(), Gtk.main_quit()))
Gtk.main()
