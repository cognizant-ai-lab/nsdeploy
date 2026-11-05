"""Two ordinary static sites plus a tiny example existing business endpoint.

Run after the README's bundle-generation commands. All reservation records are
demonstrations held in memory, discarded on exit. No LLM or real booking service.
"""
import argparse
from datetime import date
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import uuid


class DemoHandler(SimpleHTTPRequestHandler):
    receipts = {}
    lock = threading.Lock()

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_POST(self):
        if self.path != "/api/reservations" or self.server.server_port != 8122:
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 4096:
                raise ValueError("body size")
            values = json.loads(self.rfile.read(length))
            if (set(values) != {"date", "partySize"} or type(values["partySize"]) is not int
                    or not 1 <= values["partySize"] <= 12):
                raise ValueError("invalid reservation")
            date.fromisoformat(values["date"])
            key = self.headers.get("Idempotency-Key", "")
            if not key or len(key) > 200:
                raise ValueError("missing request ID")
            with self.lock:
                if key in self.receipts and self.receipts[key]["request"] != values:
                    raise ValueError("request ID reused with different input")
                self.receipts.setdefault(key, {"receipt": str(uuid.uuid4()), "demo": True, "request": values})
                body = json.dumps(self.receipts[key]).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (ValueError, TypeError, KeyError):
            self.send_error(400, "Invalid demonstration reservation")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--caller", default=".nsdeploy/actions-demo/caller")
    parser.add_argument("--venue", default=".nsdeploy/actions-demo/venue")
    args = parser.parse_args()
    servers = []
    for port, directory in [(8121, args.caller), (8122, args.venue)]:
        if not (Path(directory) / "agent-manifest.json").is_file():
            parser.error(f"Build the bundle first: {directory}")
        server = ThreadingHTTPServer(("127.0.0.1", port), partial(DemoHandler, directory=directory))
        servers.append(server)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        print(f"http://127.0.0.1:{port}/ → {directory}", flush=True)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        for server in servers:
            server.shutdown()
