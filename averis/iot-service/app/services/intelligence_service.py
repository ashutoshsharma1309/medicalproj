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

        try:
            await self._store.insert_prediction(patient_id, assessment.to_dict())
            if assessment.insights:
                await self._store.insert_insights(
                    patient_id, device_id, [i.to_dict() for i in assessment.insights]
                )
        except Exception:  # noqa: BLE001
            # Persisting is best-effort; the caller still gets the assessment.
            logger.warning("could not store assessment for patient %s", patient_id)

        return assessment
