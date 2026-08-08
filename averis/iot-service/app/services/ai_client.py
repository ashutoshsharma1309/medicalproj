"""Talking to the AI inference service — or doing it here when it is absent.

── The decision this module exists to make ────────────────────────────────

Extracting inference into its own service adds a network hop to a path that
matters. That is worth paying for the operational reasons in the service's own
docstring, but it introduces a failure that did not exist before: **the AI
service being down would stop assessments happening at all.**

For most systems that is acceptable — you page someone. For this one it is not.
An assessment is how a slow decline reaches a clinician, and "the inference
service was restarting" is not a reason a patient's deterioration should go
unnoticed for ten minutes.

So the local engine stays importable, and this client falls back to it. The
extraction buys the scaling and isolation; the fallback means it does not buy
them at the cost of an outage.

── Why this is not "just call the library" ────────────────────────────────

Because then the split would be decorative. When the service is configured and
healthy, inference happens there — separately scheduled, separately scaled,
holding no credentials. The fallback is for the minutes it is not, and it is
logged at warning every time so a permanently-failing service is visible rather
than silently absorbed.

── What is never sent ─────────────────────────────────────────────────────

No patient id, no device id, no name. The request carries readings and nothing
else, so the inference service has no identity to leak and no way to correlate
one window with another. That property is what lets it run at a lower trust
level than this service does.
"""

from __future__ import annotations

import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from ai_engine.prediction.engine import HealthAssessment, analyse_stream  # noqa: E402

logger = logging.getLogger("averis.ai_client")

# Short. This sits on the assessment path, and a caller waiting eight seconds
# for an inference service has already lost more than the fallback would cost.
REQUEST_TIMEOUT_SECONDS = 4.0


class AiClient:
    def __init__(self, base_url: str | None = None, token: str | None = None) -> None:
        self._base_url = (base_url or os.environ.get("AI_SERVICE_URL", "")).rstrip("/")
        self._token = token or os.environ.get("AI_SERVICE_TOKEN", "")
        self._client: httpx.AsyncClient | None = None

        # Both required. A URL with no token would produce a 401 on every
        # request and fall back every time — slower than not being configured
        # at all, and it would look like the service was working.
        self._remote_enabled = bool(self._base_url and self._token)

        if self._base_url and not self._token:
            logger.warning(
                "AI_SERVICE_URL is set but AI_SERVICE_TOKEN is not — running inference locally"
            )

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self._base_url,
                headers={
                    "Authorization": f"Bearer {self._token}",
                    "Content-Type": "application/json",
                },
                timeout=httpx.Timeout(REQUEST_TIMEOUT_SECONDS, connect=2.0),
            )
        return self._client

    @property
    def remote_enabled(self) -> bool:
        return self._remote_enabled

    async def assess(
        self, rows: list[dict], now: datetime | None = None
    ) -> tuple[dict, str]:
        """Assesses a window of readings.

        Returns `(assessment, source)` where source is "remote" or "local", so
        the caller can record which produced a stored prediction. A prediction
        whose provenance is unknown is one nobody can explain later.
        """
        if self._remote_enabled:
            try:
                response = await self._http().post(
                    "/api/v1/assess",
                    # Readings only. No identity crosses this boundary.
                    json={"readings": rows},
                )

                if response.status_code == 200:
                    return response.json(), "remote"

                # 4xx from the inference service is a bug in this client, not a
                # transient failure — logged as such so it is fixed rather than
                # absorbed by the fallback forever.
                logger.warning(
                    "ai service returned %d — falling back to local inference",
                    response.status_code,
                )
            except httpx.HTTPError as error:
                logger.warning(
                    "ai service unreachable (%s) — falling back to local inference",
                    type(error).__name__,
                )

        assessment: HealthAssessment = analyse_stream(
            rows, now=now or datetime.now(timezone.utc)
        )
        return assessment.to_dict(), "local"

    async def ping(self) -> bool:
        """Whether the remote service is reachable and ready.

        Used by the readiness probe. Returns True when no remote is configured:
        local inference is a supported deployment, not a degraded one, and a
        single-container install should not report itself unhealthy for
        choosing it.
        """
        if not self._remote_enabled:
            return True

        try:
            response = await self._http().get("/api/health/ready")
            return response.status_code < 500
        except httpx.HTTPError:
            return False
