#!/usr/bin/env python3
"""NC Viewer: tiny stdlib-only web server for WebManager app hosting.

Everything runs in the browser; this only serves static/ plus a health check.
(The static/ folder can also be deployed on its own as a WebManager static site.)

Run:  python3 server.py     (http://localhost:8080, or set PORT)
"""
import gzip
import json
import mimetypes
import os
import signal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

BASE = Path(__file__).resolve().parent
STATIC = (BASE / "static").resolve()
APP_VERSION = "1.0"

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; "
        "base-uri 'self'; frame-ancestors 'self'"
    ),
}
COMPRESSIBLE = {"text/html", "text/css", "text/javascript", "application/json", "image/svg+xml", "text/plain"}


class Handler(BaseHTTPRequestHandler):
    server_version = "NCViewer"
    sys_version = ""

    def log_message(self, fmt, *args):  # quieter, one line per request
        print("%s %s" % (self.address_string(), fmt % args), flush=True)

    def send_body(self, code, body, ctype, extra=None):
        gz = len(body) > 1024 and ctype.split(";")[0] in COMPRESSIBLE and "gzip" in self.headers.get("Accept-Encoding", "")
        if gz:
            body = gzip.compress(body, 6)
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if gz:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if path == "/api/health":
            body = json.dumps({"ok": True, "version": APP_VERSION}).encode()
            return self.send_body(200, body, "application/json", {"Cache-Control": "no-store"})
        if path.endswith("/"):
            path += "index.html"
        target = (STATIC / path.lstrip("/")).resolve()
        if STATIC not in target.parents or not target.is_file():
            return self.send_body(404, b"Not found", "text/plain; charset=utf-8")
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("image/svg+xml",):
            ctype += "; charset=utf-8"
        cache = "no-cache" if target.suffix == ".html" else "public, max-age=3600"
        if "/vendor/" in path:
            cache = "public, max-age=604800"
        return self.send_body(200, target.read_bytes(), ctype, {"Cache-Control": cache})

    def do_POST(self):
        self.send_body(405, b"Method not allowed", "text/plain; charset=utf-8", {"Allow": "GET, HEAD"})

    do_PUT = do_DELETE = do_PATCH = do_POST


def main():
    port = int(os.environ.get("PORT", "8080"))
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    httpd.daemon_threads = True
    def stop(*_):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    print("NC Viewer on http://0.0.0.0:%d" % port, flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
