"""Runs the health intelligence engine and persists what it finds.

Kept apart from the ingest path on purpose. Ingestion must stay fast and must
never fail because analysis did: a reading that reached the database is a
measurement, and losing it to a modelling error would be trading the record for
an opinion about the record.
"""

from __future__ import annotations

import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ai_engine lives beside iot-service in the repo rather than being packaged.
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from ai_engine.prediction.engine import HealthAssessment, analyse_stream  # noqa: E402

from ..escalation import (  # noqa: E402
    assessment_from_dict,
    escalations_for,
    notice_title,
)
from ..store import Store  # noqa: E402

logger = logging.getLogger("averis.intelligence")

# How far back the engine looks. Six hours covers the anomaly baseline; the
# feature windows inside it are much shorter.
LOOKBACK = timedelta(hours=6)


class IntelligenceService:
    def __init__(self, store: Store) -> None:
        self._store = store

    async def assess_patient(
        self, patient_id: str, now: datetime | None = None
    ) -> HealthAssessment:
        now = now or datetime.now(timezone.utc)
        rows = await self._store.recent_readings(patient_id, since=now - LOOKBACK)
        return analyse_stream(rows, now=now)

    async def assess_and_store(
        self, patient_id: str, device_id: str | None = None
    ) -> HealthAssessment:
        assessment = await self.assess_patient(patient_id)
        payload = assessment.to_dict()

        try:
            await self._store.insert_prediction(patient_id, payload)
            if assessment.insights:
                await self._store.insert_insights(
                    patient_id, device_id, [i.to_dict() for i in assessment.insights]
                )
        except Exception:  # noqa: BLE001
            # Persisting is best-effort; the caller still gets the assessment.
            logger.warning("could not store assessment for patient %s", patient_id)

        await self._escalate(patient_id, device_id, payload)

        return assessment

    async def _escalate(
        self, patient_id: str, device_id: str | None, payload: dict
    ) -> None:
        """Raises an emergency when the assessment itself is the finding.

        This is the path the thresholds cannot cover. Every reading in a slow
        decline can sit inside the normal band, so no alert fires — and the
        patient still needs someone to look before the trend arrives somewhere
        that does trip a threshold.

        Attempted even when persisting the assessment failed. The prediction
        row is a record; the escalation is a person being told, and the second
        matters more than the first.
        """
        try:
            candidates = escalations_for(
                assessment=assessment_from_dict(payload),
                open_events=await self._store.open_emergencies(patient_id),
            )
            if not candidates:
                return

            name = await self._store.patient_name(patient_id)

            for emergency in candidates:
                event_id = await self._store.raise_emergency(
                    patient_id, device_id, emergency, notice_title(emergency, name)
                )
                if event_id is not None:
                    logger.info(
                        "AI escalated %s for patient %s", emergency.event_type, patient_id
                    )
        except Exception:  # noqa: BLE001
            logger.error(
                "AI escalation failed for patient %s — care team not notified",
                patient_id,
                exc_info=True,
            )
