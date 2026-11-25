"""
Dev server with auto-rebuild for the tree preprocess outputs.

On startup and on every request for an HTML page, we stat tree-current.csv
against data/trees.js + data/tree_grid.js. If the CSV is newer (or the JS is
missing) we re-run preprocess.build_tree_outputs() before serving. When
nothing has changed the check is two os.stat calls and a no-op.

Why only trees: the lamp pipeline depends on an OSM Overpass fetch and
multiple large CSVs, so its outputs are not regenerated on page load.
Re-run `python work/scripts/preprocess.py` explicitly when those change.

Run:
  python work/scripts/serve.py                 # http://localhost:8000/, opens default browser
  python work/scripts/serve.py --port 8765     # pick a port
  python work/scripts/serve.py --no-open       # don't auto-open the browser
"""
import argparse
import http.server
import os
import socketserver
import sys
import time
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))     # the site: serve from here
sys.path.insert(0, HERE)                          # preprocess.py sits beside this file
os.chdir(ROOT)

TREE_INPUTS = ["work/raw/tree-current.csv"]
TREE_OUTPUTS = ["work/data/trees.js", "data/tree_grid.js"]


def _newest_mtime(paths):
    best = 0.0
    for p in paths:
        if os.path.exists(p):
            m = os.path.getmtime(p)
            if m > best:
                best = m
    return best


def _oldest_mtime(paths):
    """Returns -inf if any output is missing (= definitely stale)."""
    best = float("inf")
    for p in paths:
        if not os.path.exists(p):
            return float("-inf")
        m = os.path.getmtime(p)
        if m < best:
            best = m
    return best


_last_rebuild = 0.0
_REBUILD_DEBOUNCE_S = 1.0  # avoid double-rebuild from a flurry of asset requests


def rebuild_trees_if_stale():
    global _last_rebuild
    if time.time() - _last_rebuild < _REBUILD_DEBOUNCE_S:
        return
    if _oldest_mtime(TREE_OUTPUTS) >= _newest_mtime(TREE_INPUTS):
        return
    t0 = time.time()
    print("  [build] tree outputs stale, rebuilding...", flush=True)
    # Import lazily so a syntax error in preprocess.py doesn't kill the server.
    import importlib
    import preprocess
    importlib.reload(preprocess)
    preprocess.build_tree_outputs(preprocess.TREE_REFERENCE_DATE)
    _last_rebuild = time.time()
    print(f"  [build] done in {_last_rebuild - t0:.1f}s", flush=True)


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html") or path.endswith(".html"):
            try:
                rebuild_trees_if_stale()
            except Exception as ex:
                print(f"  [build] error: {ex}", file=sys.stderr)
        return super().do_GET()

    def end_headers(self):
        # Development server: never let the browser reuse stale JS/CSS/HTML.
        if not self.path.startswith("/data/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Quieter access log: skip 200s for static assets.
        if args and args[1:2] == ("200",) and self.path.startswith(("/data/", "/style.css", "/js/")):
            return
        super().log_message(fmt, *args)


class ReusableTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-open", action="store_true", help="don't auto-open the browser")
    args = ap.parse_args()

    try:
        rebuild_trees_if_stale()
    except Exception as ex:
        print(f"  [build] startup error: {ex}", file=sys.stderr)

    with ReusableTCPServer(("", args.port), Handler) as httpd:
        url = f"http://localhost:{args.port}/"
        print(f"Serving {url}  (rebuild-on-load enabled, Ctrl+C to stop)")
        if not args.no_open:
            try:
                webbrowser.open(url)
            except Exception:
                pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
