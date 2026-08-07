"""Database access, over PostgREST.

The service holds a service-role key, which bypasses RLS. That is deliberate —
a worker ingesting for the whole fleet cannot be scoped to one signed-in user —
and it is why every write here derives `patient_id` from the authenticated
device rather than from anything the caller supplied.

The rule, restated because it is the one that matters: **the owner comes from
the device row.** `resolve_device` is the only place a patient id enters the
write path.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import httpx

from .alerts import Alert
from .config import Settings
from .validation import Reading


@dataclass(frozen=True)
class Device:
    device_id: str
    patient_id: str
    device_key: str
    device_name: str
    status: str


def hash_token(token: str) -> str:
    """SHA-256, matching `hashDeviceToken` in lib/iot/device-identity.ts.

    Not bcrypt: the token is 256 bits of CSPRNG output, so there is no
    dictionary to slow down, and a KDF would add latency to a path that runs
    every two seconds per device without making the secret harder to guess.
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class Store:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client = httpx.AsyncClient(
            base_url=settings.rest_url,
            headers={
                "apikey": settings.service_role_key,
                "Authorization": f"Bearer {settings.service_role_key}",
                "Content-Type": "application/json",
            },
            timeout=httpx.Timeout(10.0, connect=5.0),
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def resolve_device(self, token: str) -> Device | None:
        """Turns a bearer token into a device and its owner.

        The only route by which a patient id enters an ingest request.
        """
        response = await self._client.post(
            "/rpc/resolve_device",
            json={"p_token_hash": hash_token(token)},
            headers={"Accept-Profile": "private", "Content-Profile": "private"},
        )
        response.raise_for_status()

        rows = response.json()
        if not rows:
            return None

        row = rows[0]
        return Device(
            device_id=row["device_id"],
            patient_id=row["patient_id"],
            device_key=row["device_key"],
            device_name=row["device_name"],
            status=row["status"],
        )

    async def insert_reading(self, device: Device, reading: Reading) -> int:
        """Writes one reading.

        `patient_id` is taken from `device`, never from the payload.
        """
        response = await self._client.post(
            "/sensor_readings",
            json={
                "device_id": device.device_id,
                "patient_id": device.patient_id,
                "heart_rate": reading.heart_rate,
                "spo2": reading.spo2,
                "temperature": reading.temperature,
                "movement_status": reading.movement_status,
                "battery_percentage": reading.battery_percentage,
                "recorded_at": reading.recorded_at.isoformat(),
            },
            headers={"Prefer": "return=representation"},
        )
        response.raise_for_status()
        return int(response.json()[0]["id"])

    async def touch_device(self, device: Device, reading: Reading) -> None:
        """Marks the device online and records what it last reported.

        Best-effort: a failure here costs a stale battery indicator, while the
        reading it accompanies is already stored. Raising would discard a good
        measurement over a status field.
        """
        payload: dict[str, Any] = {
            "connection_status": "ONLINE",
            "last_connected_at": datetime.now(timezone.utc).isoformat(),
            "last_reading_at": reading.recorded_at.isoformat(),
        }
        if reading.battery_percentage is not None:
            payload["battery_percentage"] = reading.battery_percentage

        await self._client.patch(
            "/iot_devices",
            params={"id": f"eq.{device.device_id}"},
            json=payload,
        )

    async def open_alerts(self, patient_id: str) -> list[dict]:
        response = await self._client.get(
            "/alerts",
            params={
                "patient_id": f"eq.{patient_id}",
                "status": "eq.ACTIVE",
                "select": "alert_type,severity",
            },
        )
        response.raise_for_status()
        return response.json()

    async def insert_alerts(
        self, device: Device, reading_id: int, alerts: list[Alert]
    ) -> None:
        if not alerts:
            return

        await self._client.post(
            "/alerts",
            json=[
                {
                    "patient_id": device.patient_id,
                    "device_id": device.device_id,
                    "reading_id": reading_id,
                    "alert_type": a.alert_type,
                    "severity": a.severity,
                    "message": a.message,
                    "observed_value": a.observed_value,
                    "threshold_value": a.threshold_value,
                }
                for a in alerts
            ],
        )

    async def ping(self) -> bool:
        """Readiness probe. A trivial query, not a connection check.

        A pool can hold an open socket to a database that has stopped
        answering.
        """
        try:
            response = await self._client.get("/iot_devices", params={"select": "id", "limit": "1"})
            return response.status_code < 500
        except httpx.HTTPError:
            return False
