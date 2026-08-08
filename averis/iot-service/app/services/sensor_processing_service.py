"""Sensor processing pipeline.

Extracted from `main.py` so the request handler does routing and this does the
work. One place now owns the sequence every reading goes through, in order:

    authenticate device → validate → normalise → persist → evaluate
        → escalate → publish

The order is not incidental. Authentication comes first because the owner it
resolves is required by every later step; persistence comes before alerting
because an alert referencing a reading that failed to store is an alert nobody
can check; escalation comes after alerting because an emergency is raised from
the alerts that actually got through the suppression, not from every candidate;
publishing comes last because a dashboard is the one consumer that can afford
to miss a message.

**The rule this module enforces:** the patient is read from the authenticated
device, never from the payload. It appears once, in `_persist`, and there is no
other path by which a patient id reaches a write.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone

from ..alerts import Alert, evaluate_reading, should_raise
from ..escalation import Emergency, escalations_for, notice_title
from ..store import Device, Store
from ..validation import Reading, validate_reading

logger = logging.getLogger("averis.processing")


class ProcessingError(Exception):
    """Carries the status a handler should return, so routing stays thin."""

    def __init__(self, status: int, code: str, details: list[str] | None = None) -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.details = details or []


@dataclass(frozen=True)
class ProcessedReading:
    reading_id: int
    device: Device
    reading: Reading
    alerts: list[Alert]
    emergencies: list[Emergency] = field(default_factory=list)

    def to_event(self) -> dict:
        """The shape pushed to a dashboard socket."""
        return {
            "type": "reading",
            "device_id": self.device.device_id,
            "device_key": self.device.device_key,
            "device_name": self.device.device_name,
            "heart_rate": self.reading.heart_rate,
            "spo2": self.reading.spo2,
            "temperature": self.reading.temperature,
            "movement_status": self.reading.movement_status,
            "battery_percentage": self.reading.battery_percentage,
            "recorded_at": self.reading.recorded_at.isoformat(),
            "alerts": [
                {"type": a.alert_type, "severity": a.severity, "message": a.message}
                for a in self.alerts
            ],
            # Carried so an open dashboard reflects the escalation without
            # waiting for a refresh. The durable record is the database row;
            # this is the tile.
            "emergencies": [
                {"type": e.event_type, "severity": e.severity, "summary": e.summary}
                for e in self.emergencies
            ],
        }


class SensorProcessingService:
    def __init__(self, store: Store) -> None:
        self._store = store

    async def process(self, token: str | None, body: object) -> ProcessedReading:
        device = await self._authenticate(token)
        reading = self._validate(body, device)
        reading_id = await self._persist(device, reading)
        alerts = await self._evaluate(device, reading, reading_id)
        emergencies = await self._escalate(device, alerts)

        return ProcessedReading(
            reading_id=reading_id,
            device=device,
            reading=reading,
            alerts=alerts,
            emergencies=emergencies,
        )

    # ------------------------------------------------------------- steps
    async def _authenticate(self, token: str | None) -> Device:
        if not token:
            # No detail: an unauthenticated caller learns only that it is
            # unauthenticated, never whether a token exists or is merely wrong.
            raise ProcessingError(401, "unauthorized")

        device = await self._store.resolve_device(token)
        if device is None:
            raise ProcessingError(401, "unauthorized")

        return device

    def _validate(self, body: object, device: Device) -> Reading:
        result = validate_reading(body)
        if not result.ok:
            raise ProcessingError(422, "invalid_reading", list(result.errors))

        reading = result.reading
        assert reading is not None

        # The payload names a device; the token proves one. A disagreement is
        # either a misconfigured device or a token replayed from elsewhere, and
        # both deserve refusal rather than a guess about which was meant.
        if reading.device_key != device.device_key.upper():
            logger.warning("device key mismatch for device %s", device.device_id)
            raise ProcessingError(403, "device_mismatch")

        return reading

    async def _persist(self, device: Device, reading: Reading) -> int:
        # The single point at which an owner enters the write path.
        reading_id = await self._store.insert_reading(device, reading)

        try:
            await self._store.touch_device(device, reading)
        except Exception:  # noqa: BLE001
            # Status is a convenience; the measurement is the record. Losing a
            # battery indicator must not lose a vital sign.
            logger.warning("could not update device status for %s", device.device_id)

        return reading_id

    async def _evaluate(
        self, device: Device, reading: Reading, reading_id: int
    ) -> list[Alert]:
        candidates = evaluate_reading(reading)
        if not candidates:
            return []

        open_alerts = await self._store.open_alerts(device.patient_id)
        fresh = [a for a in candidates if should_raise(a, open_alerts)]

        if fresh:
            await self._store.insert_alerts(device, reading_id, fresh)

        return fresh

    async def _escalate(self, device: Device, alerts: list[Alert]) -> list[Emergency]:
        """Turns the critical alerts into events somebody has to answer.

        Only the alerts that were *raised* are considered, not every candidate.
        A suppressed repeat is a finding the care team was already told about,
        and escalating it again would produce the notification storm the
        suppression exists to prevent.

        Failures here are logged and swallowed. The reading is stored and the
        alert is on the patient's chart either way, and losing a measurement
        because a notification could not be sent would be the wrong trade — but
        the log is an error, not a warning, because a missed escalation is the
        most serious thing this service can silently do.
        """
        if not alerts:
            return []

        candidates = [a for a in alerts if a.severity == "CRITICAL"]
        if not candidates:
            return []

        try:
            open_events = await self._store.open_emergencies(device.patient_id)
            pending = escalations_for(alerts=candidates, open_events=open_events)
            if not pending:
                return []

            name = await self._store.patient_name(device.patient_id)

            raised: list[Emergency] = []
            for emergency in pending:
                event_id = await self._store.raise_emergency(
                    device.patient_id,
                    device.device_id,
                    emergency,
                    notice_title(emergency, name),
                )
                # None means an equivalent event was already open — the
                # database deduplicated it, and the clinician already has it.
                if event_id is not None:
                    raised.append(emergency)
                    logger.info(
                        "escalated %s for patient %s", emergency.event_type, device.patient_id
                    )

            return raised
        except Exception:  # noqa: BLE001
            logger.error(
                "escalation failed for patient %s — alerts stored, care team not notified",
                device.patient_id,
                exc_info=True,
            )
            return []


def normalise_clock_skew(reading: Reading, received: datetime | None = None) -> Reading:
    """Reports how far a device's clock is from the server's.

    Not corrected — only observed. Rewriting a device's timestamps would destroy
    the one signal that distinguishes a device buffering through a network
    outage from one whose clock is simply wrong, and both look identical after
    the correction.
    """
    received = received or datetime.now(timezone.utc)
    skew = (received - reading.recorded_at).total_seconds()

    if abs(skew) > 300:
        logger.info("device clock skew %.0fs on %s", skew, reading.device_key)

    return reading
