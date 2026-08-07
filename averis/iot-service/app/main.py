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

from .alerts import evaluate_reading, should_raise
from .config import Settings, load_settings
from .hub import ConnectionHub
from .store import Store
from .validation import validate_reading

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
    settings: Settings = _state["settings"]
    store: Store = _state["store"]

    token = _bearer(authorization)
    if not token:
        # No detail about what was wrong: an unauthenticated caller learns only
        # that it is unauthenticated.
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    device = await store.resolve_device(token)
    if device is None:
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    if not _within_rate_limit(device.device_id, settings.max_readings_per_minute, time.monotonic()):
        return JSONResponse(
            {"error": "rate_limited", "limit_per_minute": settings.max_readings_per_minute},
            status_code=429,
            headers={"Retry-After": "60"},
        )

    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JSONResponse({"error": "invalid_json"}, status_code=400)

    result = validate_reading(body)
    if not result.ok:
        return JSONResponse({"error": "invalid_reading", "details": list(result.errors)}, status_code=422)

    reading = result.reading
    assert reading is not None

    # The payload names a device; the token proves one. A disagreement means
    # either a misconfigured device or a token being replayed from elsewhere,
    # and both deserve a refusal rather than a guess.
    if reading.device_key != device.device_key.upper():
        logger.warning("device key mismatch for device %s", device.device_id)
        return JSONResponse({"error": "device_mismatch"}, status_code=403)

    reading_id = await store.insert_reading(device, reading)

    try:
        await store.touch_device(device, reading)
    except Exception:  # noqa: BLE001 - status is not worth losing a reading over
        logger.warning("could not update device status for %s", device.device_id)

    raised = evaluate_reading(reading)
    if raised:
        open_alerts = await store.open_alerts(device.patient_id)
        raised = [a for a in raised if should_raise(a, open_alerts)]
        if raised:
            await store.insert_alerts(device, reading_id, raised)

    await hub.publish(
        device.patient_id,
        {
            "type": "reading",
            "device_id": device.device_id,
            "device_key": device.device_key,
            "device_name": device.device_name,
            "heart_rate": reading.heart_rate,
            "spo2": reading.spo2,
            "temperature": reading.temperature,
            "movement_status": reading.movement_status,
            "battery_percentage": reading.battery_percentage,
            "recorded_at": reading.recorded_at.isoformat(),
            "alerts": [
                {"type": a.alert_type, "severity": a.severity, "message": a.message}
                for a in raised
            ],
        },
    )

    return JSONResponse(
        {"status": "accepted", "reading_id": reading_id, "alerts_raised": len(raised)},
        status_code=201,
    )


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
