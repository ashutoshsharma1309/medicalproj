"""AVERIS IoT ingest service.

    POST /api/device/data     an ESP32 (or the simulator) reports a reading
    WS   /api/live            a dashboard subscribes to its own patient's stream
    GET  /api/health/live     is the process up
    GET  /api/health/ready    can it reach the database

The design decision this file exists to enforce:

    A device's owner is read from the device row, never from the payload.

Every request authenticates a device by bearer token, resolves that device to a
patient, and writes with that patient id. `device_id` in the body is compared
against the authenticated device so a mismatch is a loud 403 rather than a
silent cross-write.
"""

from __future__ import annotations

import json
import logging
import os
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Header, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import Settings, load_settings
from .hub import ConnectionHub
from .services.intelligence_service import IntelligenceService
from .services.sensor_processing_service import (
    ProcessingError,
    SensorProcessingService,
)
from .store import Store

logging.basicConfig(
    level=logging.INFO,
    format='{"level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}',
)
logger = logging.getLogger("averis.iot")

hub = ConnectionHub()
_state: dict[str, Any] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Configuration is resolved at startup so a missing key fails the deploy
    # rather than the first device that reports in.
    settings: Settings = load_settings()
    _state["settings"] = settings
    _state["store"] = Store(settings)
    _state["processing"] = SensorProcessingService(_state["store"])
    _state["intelligence"] = IntelligenceService(_state["store"])
    logger.info("iot service started")
    yield
    await _state["store"].aclose()


app = FastAPI(title="AVERIS IoT Service", version="1.0.0", lifespan=lifespan)

def _cors_origins() -> list[str]:
    """Allowed origins, read without requiring full configuration.

    Middleware is registered at import time, but `load_settings()` raises when
    the service-role key is absent — which is the correct behaviour at startup
    and the wrong behaviour for an import, since it would make the module
    untestable. So this reads only the one variable it needs.

    An explicit list rather than "*": the socket carries vital signs, and any
    origin being able to open one is not a default worth having.
    """
    configured = os.environ.get("CORS_ORIGINS", "").strip() or "http://localhost:3100"
    return [origin.strip() for origin in configured.split(",") if origin.strip()]


app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)


# ---------------------------------------------------------------- rate limit
#
# Per device, not per IP. A fleet behind one NAT shares an address, so an IP
# limit would throttle a hospital ward as though it were one misbehaving band.
_requests: dict[str, deque[float]] = defaultdict(deque)


def _within_rate_limit(device_id: str, limit_per_minute: int, now: float) -> bool:
    window = _requests[device_id]
    cutoff = now - 60.0

    while window and window[0] < cutoff:
        window.popleft()

    if len(window) >= limit_per_minute:
        return False

    window.append(now)
    return True


def _bearer(header: str | None) -> str | None:
    if not header:
        return None
    parts = header.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip() or None


# ------------------------------------------------------------------ ingest
@app.post("/api/device/data")
async def ingest(request: Request, authorization: str | None = Header(default=None)):
    """Routing only. The pipeline lives in SensorProcessingService."""
    settings: Settings = _state["settings"]
    processing: SensorProcessingService = _state["processing"]
    store: Store = _state["store"]

    token = _bearer(authorization)

    # Rate limiting needs an identified device, so authentication happens first
    # and its result is reused rather than resolved twice.
    if token:
        device = await store.resolve_device(token)
        if device and not _within_rate_limit(
            device.device_id, settings.max_readings_per_minute, time.monotonic()
        ):
            return JSONResponse(
                {"error": "rate_limited", "limit_per_minute": settings.max_readings_per_minute},
                status_code=429,
                headers={"Retry-After": "60"},
            )

    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JSONResponse({"error": "invalid_json"}, status_code=400)

    try:
        processed = await processing.process(token, body)
    except ProcessingError as error:
        payload: dict[str, Any] = {"error": error.code}
        if error.details:
            payload["details"] = error.details
        return JSONResponse(payload, status_code=error.status)

    await hub.publish(processed.device.patient_id, processed.to_event())

    return JSONResponse(
        {
            "status": "accepted",
            "reading_id": processed.reading_id,
            "alerts_raised": len(processed.alerts),
        },
        status_code=201,
    )


# ---------------------------------------------------------------------- AI
@app.post("/api/ai/predict")
async def ai_predict(request: Request, authorization: str | None = Header(default=None)):
    """Risk assessment for the authenticated device's patient.

    Authenticated by the same device token as ingestion, and the patient is
    resolved from the device row — never accepted from the body. A prediction
    endpoint that took a patient id would let one device credential read any
    patient's risk assessment, which is a worse leak than the readings
    themselves because it is already summarised.

    The body may carry a `history` array, as the brief specifies, but it is
    used only when the caller has no stored history — a caller cannot inject
    readings that were never measured and have them treated as the record.
    """
    store: Store = _state["store"]
    intelligence: IntelligenceService = _state["intelligence"]

    token = _bearer(authorization)
    if not token:
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    device = await store.resolve_device(token)
    if device is None:
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    if not _within_rate_limit(
        f"ai:{device.device_id}", 30, time.monotonic()
    ):
        return JSONResponse({"error": "rate_limited"}, status_code=429, headers={"Retry-After": "60"})

    assessment = await intelligence.assess_and_store(device.patient_id, device.device_id)

    return JSONResponse(assessment.to_dict(), status_code=200)


@app.get("/api/ai/model-card")
async def ai_model_card():
    """Provenance for the fall model, including its synthetic-data caveat.

    Public because it describes the model, never a patient — and a model whose
    limitations are only visible to people with database access is a model
    whose limitations are effectively hidden.
    """
    from ai_engine.models.fall_detector import model_card

    card = model_card()
    if card is None:
        return JSONResponse({"error": "no_model"}, status_code=404)
    return card


# --------------------------------------------------------------- websocket
@app.websocket("/api/live")
async def live(websocket: WebSocket):
    """Dashboard subscription.

    The client presents a device token and receives that device's patient
    stream. Using the device credential rather than a user session is a
    deliberate limitation of this phase and is documented in the README: it
    means the live view is scoped to a device the patient already owns, and it
    avoids validating Supabase JWTs in a second runtime before there is a
    second runtime worth trusting with them.
    """
    store: Store = _state["store"]

    await websocket.accept()

    try:
        opening = await websocket.receive_text()
        payload = json.loads(opening)
        token = payload.get("token")
    except (WebSocketDisconnect, json.JSONDecodeError, AttributeError):
        await websocket.close(code=1008)
        return

    if not isinstance(token, str) or not token:
        await websocket.close(code=1008)
        return

    device = await store.resolve_device(token)
    if device is None:
        await websocket.close(code=1008)
        return

    if not await hub.connect(device.patient_id, websocket):
        await websocket.close(code=1013)  # try again later
        return

    await websocket.send_text(json.dumps({"type": "subscribed", "device_key": device.device_key}))

    try:
        while True:
            # The client sends nothing but keepalives; this call is how a
            # disconnect is noticed.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await hub.disconnect(device.patient_id, websocket)


# ------------------------------------------------------------------ health
@app.get("/api/health/live")
async def health_live():
    """Liveness. Touches no dependency, on purpose.

    A liveness probe that checks the database fails during a database outage,
    the orchestrator restarts a healthy process, and the restart achieves
    nothing except adding load to the struggling database.
    """
    return {"status": "ok", "service": "averis-iot"}


@app.get("/api/health/ready")
async def health_ready():
    store: Store = _state["store"]
    database_ok = await store.ping()

    return JSONResponse(
        {
            "status": "ready" if database_ok else "not_ready",
            "checks": {"database": database_ok},
            "websocket_connections": hub.connection_count(),
            "patients_subscribed": hub.patient_count(),
        },
        status_code=200 if database_ok else 503,
        headers={"Cache-Control": "no-store"},
    )
