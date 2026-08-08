#!/usr/bin/env python3
"""AVERIS — transport validation.

    python3 scripts/hardware-validation/transport_validation.py \\
        --url https://ingest.example.org --token avd_... --duration 120

Measures what happens between a device and the backend: how long a reading
takes to be accepted, how many are lost, whether authentication behaves, and
whether a band that loses its link gets everything through afterwards.

── What this does and does not validate ────────────────────────────────────

It speaks the **exact wire protocol the ESP32 speaks** — the same JSON shape,
the same bearer token, the same batch endpoint — so everything it measures
about the *transport* is real: latency, loss, auth, replay. Those numbers
transfer directly to a band, because the band's HTTP exchange is this one.

It says **nothing about the sensors**. A MAX30102's agreement with a reference,
the MPU6050's behaviour during a real fall, the MLX90614 against a thermometer
— none of that can be measured by a program, and no number this tool prints
should be read as covering it. `docs/hardware_validation.md` carries the
sensor protocol, and it requires a person, a board, and a reference instrument.

The split is deliberate and worth stating plainly: the half that can be
automated is automated and measured; the half that cannot is written down as a
procedure and marked as not yet performed. Reporting a "validation pass" that
silently covered only the transport half would be the more comfortable
approach and would be a lie about which parts of AVERIS have been tested.

── On the numbers it prints ────────────────────────────────────────────────

Percentiles, not averages. A mean latency of 120 ms is compatible with one
reading in twenty taking four seconds, and for a monitoring system the tail is
the whole question — the reading that matters is the one carrying a
deterioration, and it is not the median one.

Nothing is hard-coded as a pass threshold except the two that are genuinely
absolute: an unauthenticated reading must be refused, and a buffered reading
must not be lost. Everything else is reported for a person to judge against
their own network.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

try:
    import httpx
except ImportError:  # pragma: no cover - environment guidance
    print("This tool needs httpx:  pip install httpx", file=sys.stderr)
    raise SystemExit(1)


# ---------------------------------------------------------------------------
# The payload the ESP32 sends.
#
# Kept identical to `firmware/averis-wearable/src/payload.h`. If these drift,
# this tool measures a protocol nothing speaks — so the shape lives in one
# obvious place rather than being assembled inline at three call sites.
# ---------------------------------------------------------------------------
def reading(device_key: str, *, hr=72.0, spo2=98.0, temp=36.6,
            movement="RESTING", recorded_at=None, battery=80) -> dict:
    return {
        "device_key": device_key,
        "heart_rate": hr,
        "spo2": spo2,
        "temperature": temp,
        "movement_status": movement,
        "battery_percentage": battery,
        "recorded_at": (recorded_at or datetime.now(timezone.utc)).isoformat().replace("+00:00", "Z"),
    }


@dataclass
class Check:
    name: str
    passed: bool | None      # None = could not be determined, never a pass
    detail: str


@dataclass
class Report:
    target: str
    started_at: str
    checks: list[Check] = field(default_factory=list)
    measurements: dict = field(default_factory=dict)

    def add(self, name: str, passed: bool | None, detail: str) -> None:
        self.checks.append(Check(name, passed, detail))

    @property
    def failed(self) -> int:
        return sum(1 for c in self.checks if c.passed is False)

    @property
    def undetermined(self) -> int:
        return sum(1 for c in self.checks if c.passed is None)


def percentiles(values: list[float]) -> dict:
    if not values:
        return {}
    ordered = sorted(values)

    def at(p: float) -> float:
        # Nearest-rank. With 40 samples an interpolated p99 invents a number
        # between two observations; the rank is an observation that happened.
        index = min(len(ordered) - 1, max(0, round(p / 100 * len(ordered)) - 1))
        return ordered[index]

    return {
        "n": len(ordered),
        "min_ms": round(ordered[0], 1),
        "p50_ms": round(at(50), 1),
        "p95_ms": round(at(95), 1),
        "p99_ms": round(at(99), 1),
        "max_ms": round(ordered[-1], 1),
        "mean_ms": round(statistics.fmean(ordered), 1),
    }


# ---------------------------------------------------------------------- auth
async def check_authentication(client: httpx.AsyncClient, url: str,
                               token: str, device_key: str, report: Report) -> None:
    """The two outcomes that are absolute, not a matter of network conditions."""
    body = reading(device_key)

    # No token at all.
    response = await client.post(f"{url}/api/v1/readings", json=body)
    report.add(
        "an unauthenticated reading is refused",
        response.status_code == 401,
        f"got HTTP {response.status_code}, expected 401",
    )

    # A token that is the right shape and not a real one. This is the case that
    # matters: a 500 here would mean the resolver is throwing rather than
    # deciding, and a service that errors on a bad token is one that can be
    # probed for which tokens exist by watching how it fails.
    response = await client.post(
        f"{url}/api/v1/readings",
        json=body,
        headers={"Authorization": "Bearer avd_0000000000000000000000000000"},
    )
    report.add(
        "an unregistered token is refused, not errored",
        response.status_code == 401,
        f"got HTTP {response.status_code}, expected 401",
    )

    # The real one.
    response = await client.post(
        f"{url}/api/v1/readings", json=body,
        headers={"Authorization": f"Bearer {token}"},
    )
    report.add(
        "a registered token is accepted",
        response.status_code in (200, 201, 202),
        f"got HTTP {response.status_code}: {response.text[:160]}",
    )


# ------------------------------------------------------------------- latency
async def measure_latency(client: httpx.AsyncClient, url: str, token: str,
                          device_key: str, count: int, interval: float,
                          report: Report) -> None:
    """Round-trip from sending a reading to the service confirming it stored it."""
    latencies: list[float] = []
    rejected = 0
    errors: dict[str, int] = {}

    headers = {"Authorization": f"Bearer {token}"}

    for i in range(count):
        body = reading(device_key, hr=70 + (i % 7), spo2=97 + (i % 2))
        started = time.perf_counter()
        try:
            response = await client.post(f"{url}/api/v1/readings", json=body, headers=headers)
        except httpx.HTTPError as error:
            # A transport failure is loss, and is counted as loss rather than
            # excluded from the sample. Dropping the failures is how a tool
            # reports excellent latency for a link that barely works.
            key = type(error).__name__
            errors[key] = errors.get(key, 0) + 1
            rejected += 1
        else:
            elapsed_ms = (time.perf_counter() - started) * 1000
            if response.status_code in (200, 201, 202):
                latencies.append(elapsed_ms)
            else:
                rejected += 1
                key = f"HTTP {response.status_code}"
                errors[key] = errors.get(key, 0) + 1

        if interval:
            await asyncio.sleep(interval)

    stats = percentiles(latencies)
    report.measurements["latency"] = stats
    report.measurements["attempted"] = count
    report.measurements["accepted"] = len(latencies)
    report.measurements["rejected"] = rejected
    report.measurements["errors"] = errors

    loss_percent = (rejected / count * 100) if count else 0.0
    report.measurements["loss_percent"] = round(loss_percent, 2)

    if latencies:
        report.add(
            "latency measured",
            True,
            f"p50 {stats['p50_ms']} ms · p95 {stats['p95_ms']} ms · p99 {stats['p99_ms']} ms "
            f"· max {stats['max_ms']} ms over {stats['n']} readings",
        )
    else:
        # Not a pass and not a fail: nothing got through, so there is no
        # latency to report. Printing 0 ms would be the worst of both.
        report.add("latency measured", None, "no reading was accepted — nothing to measure")

    report.add(
        "no readings lost",
        rejected == 0,
        f"{rejected} of {count} did not land ({loss_percent:.1f}%)"
        + (f" — {errors}" if errors else ""),
    )


# ------------------------------------------------------------------- recovery
async def check_reconnection(client: httpx.AsyncClient, url: str, token: str,
                             device_key: str, report: Report) -> None:
    """What the band does after a gap: replays its buffer through /batch.

    This is the path that decides whether an outage costs readings or only
    delays them, and it is the one most likely to be wrong, because it is the
    one nobody exercises during normal operation.
    """
    headers = {"Authorization": f"Bearer {token}"}

    # Five readings timestamped in the past, as a band's buffer would hold them
    # after five minutes offline. The timestamps are the point: they must land
    # where they were *measured*, not where they were delivered, or an outage
    # rewrites a patient's history into a spike at the reconnection moment.
    now = datetime.now(timezone.utc)
    buffered = [
        reading(device_key, hr=74 + i, recorded_at=now - timedelta(minutes=5 - i))
        for i in range(5)
    ]

    try:
        response = await client.post(
            f"{url}/api/v1/readings/batch", json={"readings": buffered}, headers=headers
        )
    except httpx.HTTPError as error:
        report.add("a buffered batch replays", False, f"{type(error).__name__}: {error}")
        return

    # 207 is a partial success and is a legitimate outcome — the endpoint is
    # built so one bad reading in a batch does not discard the rest.
    ok = response.status_code in (200, 201, 202, 207)
    detail = f"HTTP {response.status_code}"

    if ok:
        try:
            payload = response.json()
            accepted = payload.get("accepted", payload.get("stored"))
            if accepted is not None:
                ok = accepted == len(buffered)
                detail = f"{accepted} of {len(buffered)} accepted (HTTP {response.status_code})"
        except ValueError:
            detail = f"HTTP {response.status_code}, unparseable body"

    report.add("a buffered batch replays without loss", ok, detail)


# ---------------------------------------------------------------------- main
async def run(args) -> Report:
    report = Report(
        target=args.url,
        started_at=datetime.now(timezone.utc).isoformat(),
    )

    timeout = httpx.Timeout(args.timeout)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        # Reachability first. Every later failure is uninterpretable without it
        # — "0 of 200 accepted" means one thing against a live service and
        # another against a URL with nothing behind it.
        try:
            response = await client.get(f"{args.url}/api/health/live")
            report.add("the service is reachable", response.status_code == 200,
                       f"HTTP {response.status_code}")
        except httpx.HTTPError as error:
            report.add("the service is reachable", False, f"{type(error).__name__}: {error}")
            return report

        await check_authentication(client, args.url, args.token, args.device_key, report)
        await measure_latency(client, args.url, args.token, args.device_key,
                              args.count, args.interval, report)
        await check_reconnection(client, args.url, args.token, args.device_key, report)

    return report


def render(report: Report, as_json: bool) -> None:
    if as_json:
        print(json.dumps({
            "target": report.target,
            "started_at": report.started_at,
            "checks": [{"name": c.name, "passed": c.passed, "detail": c.detail}
                       for c in report.checks],
            "measurements": report.measurements,
            # Named so nobody quotes this file as a hardware validation.
            "scope": "transport only — sensor accuracy is not covered, see docs/hardware_validation.md",
        }, indent=2))
        return

    print(f"\nAVERIS transport validation — {report.target}")
    print(f"{report.started_at}\n")

    for check in report.checks:
        mark = "PASS" if check.passed else ("FAIL" if check.passed is False else "n/a ")
        print(f"  {mark}  {check.name}")
        print(f"        {check.detail}")

    print("\n  Scope: this measures the transport only. Sensor accuracy, fall")
    print("  detection on a real body, and battery life are not covered here —")
    print("  see docs/hardware_validation.md for the protocol that is.\n")

    if report.failed:
        print(f"  {report.failed} check(s) failed.\n")
    elif report.undetermined:
        print(f"  No failures, but {report.undetermined} check(s) could not be determined.\n")
    else:
        print("  Every transport check passed.\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", required=True, help="Ingest service base URL")
    parser.add_argument("--token", required=True, help="A registered device token")
    parser.add_argument("--device-key", default="AVERIS-VALIDATION", help="Device key in the payload")
    parser.add_argument("--count", type=int, default=100, help="Readings to send for the latency sample")
    parser.add_argument("--interval", type=float, default=0.05, help="Seconds between readings")
    parser.add_argument("--timeout", type=float, default=10.0, help="Per-request timeout")
    parser.add_argument("--json", action="store_true", help="Machine-readable output")
    args = parser.parse_args()

    report = asyncio.run(run(args))
    render(report, args.json)

    # Non-zero on failure only. An undetermined check is reported and does not
    # fail the run, because the alternative — treating "could not measure" as
    # "broken" — trains people to ignore the exit code.
    return 1 if report.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
