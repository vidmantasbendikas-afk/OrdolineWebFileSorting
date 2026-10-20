#!/usr/bin/env python3
"""Static file server for the Ordoline dental photo sorting app.

Serves the project directory with correct MIME types for WASM/ES modules.
All model inference happens in the browser; this server only serves files.

Run:  python3 serve.py [--port 8000]
Then open http://localhost:8000
"""
import argparse
import http.server
import os
import socketserver
import sys
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent

BIG_FILE = 1 << 20


def human(n):
    if n < 1024:
        return f"{n} B"
    for unit in ("KB", "MB", "GB"):
        n /= 1024
        if n < 1024 or unit == "GB":
            return f"{n:.1f} {unit}"
    return f"{n:.1f} GB"


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".onnx": "application/octet-stream",
        ".json": "application/json",
        ".css": "text/css",
        ".html": "text/html; charset=utf-8",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # onnxruntime-web needs SharedArrayBuffer only for multi-threading;
        # we run single-threaded, but allow it anyway for future perf.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def do_GET(self):
        f = self.send_head()
        if f is None:
            return
        try:
            expected = os.fstat(f.fileno()).st_size
        except (OSError, ValueError):
            expected = None
        sent = 0
        try:
            while True:
                chunk = f.read(64 * 1024)
                if not chunk:
                    break
                sent += len(chunk)
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            if expected and expected >= BIG_FILE:
                self.log_message(
                    "TRANSFER INCOMPLETE %s: sent %s of %s (client disconnected)",
                    self.path, human(sent), human(expected),
                )
            self.close_connection = True
            try:
                f.close()
            except OSError:
                pass
            return
        if expected and expected >= BIG_FILE:
            self.log_message(
                "TRANSFER COMPLETE %s: sent %s of %s",
                self.path, human(sent), human(expected),
            )
        f.close()

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}", flush=True)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    with Server(("0.0.0.0", args.port), Handler) as httpd:
        url = f"http://localhost:{args.port}"
        print(f"Serving {ROOT} at {url}  (Ctrl+C to stop)", flush=True)
        if not args.no_browser:
            try:
                webbrowser.open(url)
            except Exception:
                pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped")


if __name__ == "__main__":
    main()
