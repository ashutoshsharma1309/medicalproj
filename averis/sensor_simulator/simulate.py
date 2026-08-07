#!/usr/bin/env python3
"""AVERIS sensor simulator — a stand-in for an ESP32.

    python sensor_simulator/simulate.py --token avd_... --device-key AVR001

This is **not** fake UI data. It is a separate process that speaks the same
HTTP contract the firmware will: bearer token, same JSON body, same endpoint.
When the hardware arrives, the ESP32 replaces this process and nothing else in
the system changes. That is the whole reason it exists as a client rather than
as a seeded table.

**On the numbers.** They come from a random walk with physiological bounds and
inertia, not from `random.uniform` per tick. Independent samples produce a heart
rate that jumps 62 → 118 → 57 between readings, which no body does and no
trend detector can work with — it would make the dashboard look alive while
being useless for testing anything downstream. A walk produces a series that
moves the way a real one does.

They are still simulated, and the tool says so on every run. Nothing labels
this data as clinical, and it is never written anywhere the UI would present it
as measured from a person.
"""

from __future__ import annotations

import argparse
import json
import random
import signal
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone


@dataclass
class VitalSign:
    """One signal doing a bounded random walk."""

    value: float
    low: float
    high: float
    step: float
    precision: int = 0

    def tick(self, rng: random.Random) -> float:
        # Drift plus a pull back toward the middle, so the walk does not
        # wander to a bound and sit there.
        centre = (self.low + self.high) / 2
        pull = (centre - self.value) * 0.02
        self.value += rng.uniform(-self.step, self.step) + pull
        self.value = max(self.low, min(self.high, self.value))
        return round(self.value, self.precision)


SCENARIOS = {
    # Ordinary resting adult. Nothing here should trip an alert.
    "resting": {
        "heart_rate": VitalSign(68, 58, 82, 2.0),
        "spo2": VitalSign(98, 96, 100, 0.4),
        "temperature": VitalSign(36.7, 36.3, 37.1, 0.08, precision=1),
        "movement": ["RESTING", "RESTING", "NORMAL"],
    },
    "active": {
        "heart_rate": VitalSign(105, 88, 135, 4.0),
        "spo2": VitalSign(97, 94, 100, 0.5),
        "temperature": VitalSign(37.2, 36.8, 37.8, 0.1, precision=1),
        "movement": ["ACTIVE", "ACTIVE", "NORMAL"],
    },
    # Drifts into alert territory, for exercising the alerting path end to end.
    "deteriorating": {
        "heart_rate": VitalSign(115, 95, 165, 5.0),
        "spo2": VitalSign(94, 86, 97, 0.9),
        "temperature": VitalSign(38.1, 37.4, 39.8, 0.15, precision=1),
        "movement": ["RESTING", "NORMAL"],
    },
}


def build_payload(device_key: str, scenario: dict, rng: random.Random, battery: float) -> dict:
    return {
        "device_id": device_key,
        "heart_rate": int(scenario["heart_rate"].tick(rng)),
        "spo2": int(scenario["spo2"].tick(rng)),
        "temperature": scenario["temperature"].tick(rng),
        "movement": rng.choice(scenario["movement"]),
        "battery": int(battery),
        # The device stamps its own time. Sending it exercises the same path a
        # device buffering through a network outage will use.
        "recorded_at": datetime.now(timezone.utc).isoformat(),
    }


def post(url: str, token: str, payload: dict, timeout: float = 10.0) -> tuple[int, str]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "averis-sensor-simulator/1.0",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as error:
        return 0, str(error.reason)


def main() -> int:
    parser = argparse.ArgumentParser(description="Simulate an AVERIS wearable.")
    parser.add_argument("--token", required=True, help="Device token issued at registration (avd_...)")
    parser.add_argument("--device-key", required=True, help="Device key, e.g. AVR001")
    parser.add_argument("--url", default="http://localhost:8000/api/device/data")
    parser.add_argument("--interval", type=float, default=2.0, help="Seconds between readings")
    parser.add_argument("--scenario", choices=sorted(SCENARIOS), default="resting")
    parser.add_argument("--count", type=int, default=0, help="Readings to send; 0 means run until stopped")
    parser.add_argument("--seed", type=int, default=None, help="Seed for a reproducible series")
    args = parser.parse_args()

    rng = random.Random(args.seed)
    scenario = SCENARIOS[args.scenario]
    battery = 100.0

    print(f"AVERIS sensor simulator — SIMULATED DATA, not clinical measurements")
    print(f"  device   {args.device_key}")
    print(f"  scenario {args.scenario}")
    print(f"  target   {args.url}")
    print(f"  interval {args.interval}s\n")

    running = True

    def stop(_signum, _frame):
        nonlocal running
        running = False
        print("\nstopping…")

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    sent = 0
    failures = 0

    while running and (args.count == 0 or sent < args.count):
        # Roughly a day of battery at a two-second interval.
        battery = max(0.0, battery - 0.0025)

        payload = build_payload(args.device_key, scenario, rng, battery)
        status, body = post(args.url, args.token, payload)

        if status == 201:
            sent += 1
            failures = 0
            alerts = json.loads(body).get("alerts_raised", 0)
            flag = f"  ⚠ {alerts} alert(s)" if alerts else ""
            print(
                f"  {payload['heart_rate']:>3} BPM  "
                f"SpO2 {payload['spo2']:>3}%  "
                f"{payload['temperature']:>4.1f}°C  "
                f"{payload['movement']:<14} → {status}{flag}"
            )
        else:
            failures += 1
            print(f"  ✗ {status}: {body[:160]}", file=sys.stderr)

            # A device that cannot authenticate will never succeed by retrying,
            # so it stops rather than hammering the endpoint forever.
            if status in (401, 403):
                print("  authentication rejected — check the token and device key", file=sys.stderr)
                return 1

            if failures >= 5:
                print("  giving up after 5 consecutive failures", file=sys.stderr)
                return 1

        if running and (args.count == 0 or sent < args.count):
            time.sleep(args.interval)

    print(f"\nsent {sent} reading(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
