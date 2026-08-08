#!/usr/bin/env python3
"""AVERIS sensor simulator — a stand-in for an ESP32.

    python sensor_simulator/simulate.py --token avd_... --device-key AVR001

This is **not** fake UI data. It is a separate process that speaks the same
HTTP contract the firmware does: bearer token, same JSON body, same endpoint.

The hardware has now arrived — `firmware/averis-wearable` sends these exact
bytes — and this tool did not become obsolete, which was the point of building
it as a client rather than as a seeded table. It stays for the three jobs a
band cannot do: reproducing a scenario exactly (`--seed`), producing a
deterioration on demand rather than waiting for a patient to have one, and
running in CI where there is no wrist.

**The one thing it must never do is pass for a real device.** Every reading it
sends is stamped `is_simulated` on the row — from the device registration
rather than from this payload, because a simulator that could declare itself
real would make the flag worthless. Register the device as a simulator.

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
    # ── Normal mode ─────────────────────────────────────────────────────────
    # An ordinary resting adult. Nothing here should trip an alert, which makes
    # it the scenario that proves the alerting path is not firing on noise.
    "resting": {
        "heart_rate": VitalSign(72, 60, 100, 2.0),
        "spo2": VitalSign(98, 95, 100, 0.4),
        "temperature": VitalSign(36.7, 36.0, 37.5, 0.08, precision=1),
        "movement": ["RESTING", "RESTING", "NORMAL"],
    },
    "walking": {
        "heart_rate": VitalSign(96, 75, 118, 3.0),
        "spo2": VitalSign(97, 95, 100, 0.5),
        "temperature": VitalSign(37.0, 36.4, 37.5, 0.09, precision=1),
        "movement": ["ACTIVE", "ACTIVE", "NORMAL"],
    },
    "running": {
        # Deliberately brushes the 120 BPM warning threshold: exertion is a
        # legitimate reason for a high heart rate, and a monitor that cannot
        # tell exercise from distress will be muted by its user within a week.
        "heart_rate": VitalSign(138, 110, 165, 5.0),
        "spo2": VitalSign(96, 93, 99, 0.6),
        "temperature": VitalSign(37.6, 37.0, 38.4, 0.12, precision=1),
        "movement": ["ACTIVE"],
    },

    # ── Abnormal mode ───────────────────────────────────────────────────────
    # Drifts into alert territory, for exercising the alerting path end to end.
    "deteriorating": {
        "heart_rate": VitalSign(118, 95, 168, 5.0),
        "spo2": VitalSign(94, 84, 97, 0.9),
        "temperature": VitalSign(38.2, 37.4, 39.9, 0.15, precision=1),
        "movement": ["RESTING", "NORMAL"],
    },
    # Every channel abnormal at once, for checking that several alerts can be
    # raised from one reading without one masking the others.
    "critical": {
        "heart_rate": VitalSign(158, 145, 180, 4.0),
        "spo2": VitalSign(87, 82, 91, 0.8),
        "temperature": VitalSign(39.6, 39.0, 40.5, 0.12, precision=1),
        "movement": ["RESTING"],
    },
}

def build_payload(
    device_key: str,
    scenario: dict,
    rng: random.Random,
    battery: float,
    fall: bool = False,
    telemetry: dict | None = None,
) -> dict:
    movement = "FALL_SUSPECTED" if fall else rng.choice(scenario["movement"])

    # A real fall is not a movement label on an otherwise calm reading: the
    # impact spikes heart rate. Sending the label alone would test the alert
    # rule while testing nothing about how a fall actually presents.
    heart_rate = int(scenario["heart_rate"].tick(rng))
    if fall:
        heart_rate = min(200, heart_rate + rng.randint(25, 45))

    payload = {
        "device_id": device_key,
        "heart_rate": heart_rate,
        "spo2": int(scenario["spo2"].tick(rng)),
        "temperature": scenario["temperature"].tick(rng),
        "movement": movement,
        "battery": int(battery),
        # The device stamps its own time. Sending it exercises the same path a
        # device buffering through a network outage will use.
        "recorded_at": datetime.now(timezone.utc).isoformat(),
    }

    if telemetry is not None:
        payload["telemetry"] = telemetry

    return payload


def build_telemetry(
    sent: int,
    rng: random.Random,
    firmware: str,
    broken_sensor: str | None,
) -> dict:
    """The diagnostic block a real band sends.

    Included so the hardware dashboard has something to render before anyone
    owns an ESP32, and — more usefully — so the *failure* paths can be
    exercised on demand. `--break-sensor imu` produces the sensor-fault event
    that would otherwise require unsoldering something.

    `transport` says "simulator" and cannot say anything else. The device row
    decides provenance; this is the honest label on the wire to match it.
    """
    sensors = {"pulse": "ok", "thermometer": "ok", "imu": "ok"}
    if broken_sensor:
        sensors[broken_sensor] = "faulty"

    return {
        # A plausible indoor signal that wanders, so the dashboard's signal
        # column is exercised rather than constant.
        "rssi": int(rng.gauss(-58, 6)),
        "uptime_s": sent * 2,
        "boot_count": 1,
        "firmware": firmware,
        "transport": "simulator",
        "buffered": 0,
        "sensors": sensors,
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
    parser.add_argument("--url", default="http://localhost:8000/api/device/upload")
    parser.add_argument("--interval", type=float, default=2.0, help="Seconds between readings")
    parser.add_argument("--scenario", choices=sorted(SCENARIOS), default="resting")
    parser.add_argument("--count", type=int, default=0, help="Readings to send; 0 means run until stopped")
    parser.add_argument("--seed", type=int, default=None, help="Seed for a reproducible series")
    parser.add_argument(
        "--fall-after",
        type=int,
        default=0,
        help="Inject a fall event after N readings (0 = never)",
    )
    parser.add_argument(
        "--break-sensor",
        choices=["pulse", "thermometer", "imu"],
        default=None,
        help="Report a sensor as faulty, to exercise the hardware dashboard",
    )
    parser.add_argument(
        "--firmware",
        default="sim-1.0.0",
        help="Firmware version to report (deliberately not a real one by default)",
    )
    parser.add_argument(
        "--no-telemetry",
        action="store_true",
        help="Send only vital signs, as a minimal third-party device would",
    )
    args = parser.parse_args()

    rng = random.Random(args.seed)
    scenario = SCENARIOS[args.scenario]
    battery = 100.0

    print(f"AVERIS sensor simulator — SIMULATED DATA, not clinical measurements")
    print(f"  device   {args.device_key}")
    print(f"  scenario {args.scenario}")
    print(f"  target   {args.url}")
    print(f"  interval {args.interval}s")
    if args.break_sensor:
        print(f"  reporting {args.break_sensor} as FAULTY")
    print()

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

        fall = args.fall_after > 0 and sent + 1 == args.fall_after
        telemetry = (
            None
            if args.no_telemetry
            else build_telemetry(sent, rng, args.firmware, args.break_sensor)
        )
        payload = build_payload(
            args.device_key, scenario, rng, battery, fall=fall, telemetry=telemetry
        )
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
