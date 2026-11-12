# SPDX-License-Identifier: GPL-2.0-only
"""Fake GitHub + fake mivnav health endpoint for deploy/tests/test_update.sh.

    python3 fake_server.py <www-dir> <mivnav-root> <broken-versions-file> <port-file>

- ``GET /api/healthz`` answers like the real backend *after a restart*: it
  reports the version ``<mivnav-root>/current`` points at — or 503 if that
  version is listed in ``<broken-versions-file>`` (a release that won't start).
- Anything else is a file under ``<www-dir>`` (query string ignored);
  ``/repos/<o>/<r>/releases`` is served from ``releases.json`` in that dir,
  since ``releases/`` is also a directory.

Binds an ephemeral port on 127.0.0.1 and writes it to ``<port-file>``.
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WWW, ROOT, BROKEN, PORT_FILE = (Path(a) for a in sys.argv[1:5])


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # quiet
        pass

    def _send(self, code: int, body: bytes, ctype: str = "application/octet-stream") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/api/healthz":
            cur = ROOT / "current"
            if not cur.is_symlink():
                return self._send(503, b"down")
            ver = cur.resolve().name
            broken = BROKEN.read_text().split() if BROKEN.exists() else []
            if ver in broken:
                return self._send(503, b"broken")
            body = json.dumps({"status": "ok", "version": ver}).encode()
            return self._send(200, body, "application/json")
        f = WWW / path.lstrip("/")
        if f.is_dir():
            f = f.with_suffix(".json") if f.name == "releases" else f / "index.html"
        if f.is_file():
            return self._send(200, f.read_bytes())
        return self._send(404, b"not found")


srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
PORT_FILE.write_text(str(srv.server_address[1]))
srv.serve_forever()
