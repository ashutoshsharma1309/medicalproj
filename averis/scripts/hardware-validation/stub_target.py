#!/usr/bin/env python3
"""A conformant stub of the AVERIS ingest contract.

    python3 scripts/hardware-validation/stub_target.py --port 8231

**This is not AVERIS.** It exists for exactly one purpose: to check that
`transport_validation.py` measures and reports correctly — that it counts
losses as losses, refuses to invent a latency figure when nothing lands, and
fails the run when a check that must pass does not.

A measuring instrument that has never been pointed at a known quantity is not a
measuring instrument. Running the harness against production and seeing green
tells you nothing about whether the harness would have gone red.

So this implements the handful of endpoints the harness touches, with switches
for the failure modes worth rehearsing:

    --reject-auth      accept any token, so the auth checks fail
    --drop-rate 0.25   drop a quarter of readings, so loss is counted
    --latency-ms 40    add a fixed delay, so the latency figures are checkable
    --batch-partial    accept 3 of 5 in a batch, so replay-loss is caught

Nothing here is used by the product, no AVERIS module imports it, and it holds
no data beyond a counter. It is a target on a wall.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OPTIONS = {
    "reject_auth": False,
    "drop_rate": 0.0,
    "latency_ms": 0,
    "batch_partial": False,
    "seed": 1,
}

_random = random.Random(OPTIONS["seed"])


class Handler(BaseHTTPRequestHandler):
    # Quiet. The harness's output is the thing being read.
    def log_message(self, *args):  # noqa: D102
        pass

    def _send(self, code: int, body: dict) -> None:
        payload = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _authorised(self) -> bool:
        if OPTIONS["reject_auth"]:
            # The misbehaviour being rehearsed: accepting everything. The
            # harness must go red on this, and if it does not, the harness is
            # not checking authentication at all.
            return True

        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return False

        token = header[len("Bearer "):].strip()
        # One "registered" token, and the all-zeros one is deliberately not it.
        return token.startswith("avd_") and set(token[4:]) != {"0"}

    def do_GET(self):  # noqa: N802
        if self.path == "/api/health/live":
            self._send(200, {"status": "ok", "service": "stub"})
        else:
            self._send(404, {"error": "not_found"})

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"

        if OPTIONS["latency_ms"]:
            import time
            time.sleep(OPTIONS["latency_ms"] / 1000)

        if not self._authorised():
            self._send(401, {"error": "unauthorized"})
            return

        if self.path == "/api/v1/readings":
            if OPTIONS["drop_rate"] and _random.random() < OPTIONS["drop_rate"]:
                self._send(503, {"error": "dropped_by_stub"})
                return
            self._send(202, {"accepted": 1})
            return

        if self.path == "/api/v1/readings/batch":
            try:
                readings = json.loads(raw).get("readings", [])
            except ValueError:
                self._send(400, {"error": "invalid_json"})
                return

            if OPTIONS["batch_partial"]:
                self._send(207, {"accepted": max(0, len(readings) - 2)})
            else:
                self._send(202, {"accepted": len(readings)})
            return

        self._send(404, {"error": "not_found"})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8231)
    parser.add_argument("--reject-auth", action="store_true")
    parser.add_argument("--drop-rate", type=float, default=0.0)
    parser.add_argument("--latency-ms", type=int, default=0)
    parser.add_argument("--batch-partial", action="store_true")
    parser.add_argument("--seed", type=int, default=1)
    args = parser.parse_args()

    OPTIONS.update({
        "reject_auth": args.reject_auth,
        "drop_rate": args.drop_rate,
        "latency_ms": args.latency_ms,
        "batch_partial": args.batch_partial,
    })
    global _random
    _random = random.Random(args.seed)

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"stub target on http://127.0.0.1:{args.port} — not AVERIS", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
