# ===========================================================================
# AVERIS IoT ingest service
#
# The component exposed to devices on untrusted networks, and the one holding a
# service-role key. Both facts shape this file: minimal surface, non-root, and
# no build tooling in the runtime image.
# ===========================================================================
FROM python:3.13-slim AS builder

WORKDIR /build

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential \
 && rm -rf /var/lib/apt/lists/*

COPY iot-service/requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ---------------------------------------------------------------------------
FROM python:3.13-slim

RUN useradd --create-home --uid 10001 averis

WORKDIR /app

COPY --from=builder /install /usr/local
COPY --chown=averis:averis iot-service/app/ ./app/

# The engine travels with the ingest service as well as with the AI service —
# it is the local fallback. Without it, an unreachable inference service would
# stop assessments entirely, and "the model server was restarting" is not a
# reason a patient's deterioration goes unnoticed.
COPY --chown=averis:averis ai_engine/ ./ai_engine/
COPY --chown=averis:averis ml/artifacts/ ./ml/artifacts/

USER averis

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8000

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request,os,sys; sys.exit(0 if urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/api/health/live', timeout=2).status==200 else 1)"

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 1"]
