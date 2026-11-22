#!/usr/bin/env python3
"""Serve the website on localhost to preview it, as GitHub Pages will.

    python3 -I tools/serve-site.py [PORT]        # default 8700, binds 127.0.0.1 only

Ported from OpenSeal's tools/serve-site.py. It serves the published tree:
tools/build-site.py --publish assembles site/ (without _src/) and the editor's demo copy
at app/ into target/site-published/ at start, and serves it under /opencanvas/, the
project path GitHub Pages uses, so the editor built with OC_EDITOR_BASE=./
works exactly as published. / redirects there.

Build the editor for it first:
    cd web && OC_EDITOR_BASE=./ pnpm --filter @opencanvas/editor build

Standard library only: `Cache-Control: no-store`, the pages' CSP sent as a header too,
never a public interface. site/_src/ is not served. Rebuild with tools/build-site.py.
"""
import http.server
import importlib.util
import pathlib
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
SITE = REPO / "site"
ROOT = REPO / "target/site-published"
PREFIX = "/opencanvas"
# The site's pages narrow this with their own meta policy. The editor needs inline
# styles (React style attributes), blob: and data: images, and wss: is never used in
# the demo. GitHub Pages sends no CSP header at all.
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
       "font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src https://www.youtube-nocookie.com; "
       "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'")


def publish() -> None:
    spec = importlib.util.spec_from_file_location("build_site", REPO / "tools/build-site.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.publish(ROOT)


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
        ".json": "application/json", ".webp": "image/webp", ".png": "image/png",
        ".mjs": "text/javascript", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
        ".xml": "application/xml",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def translate_path(self, path):
        return super().translate_path(path[len(PREFIX):] or "/")

    def do_GET(self):  # noqa: N802 (http.server's name)
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        if path in ("/", PREFIX):
            self.send_response(302)
            self.send_header("Location", PREFIX + "/")
            self.end_headers()
            return
        if not path.startswith(PREFIX + "/") or path.startswith(PREFIX + "/_src"):
            return self.not_found()
        if not pathlib.Path(self.translate_path(self.path)).exists():
            return self.not_found()
        super().do_GET()

    def not_found(self):
        body = (ROOT / "404.html").read_bytes() if (ROOT / "404.html").exists() else b"Not found"
        self.send_response(404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8700
    if not SITE.is_dir():
        print(f"serve-site: {SITE} does not exist; run tools/build-site.py", file=sys.stderr)
        return 1
    publish()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"serve-site: http://127.0.0.1:{port}{PREFIX}/ (site/ and the editor's demo copy, published)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
