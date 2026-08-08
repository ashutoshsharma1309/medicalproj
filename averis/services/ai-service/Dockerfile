# ===========================================================================
# AVERIS AI inference service
#
# Multi-stage so the runtime image carries no compiler and no build cache. The
# scientific stack pulls in a lot; a single-stage build of this ships ~1.2 GB
# and most of it is things needed to *build* numpy rather than to run it.
# ===========================================================================
FROM python:3.13-slim AS builder

WORKDIR /build

# Build tools for anything without a manylinux wheel, discarded with this stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential \
 && rm -rf /var/lib/apt/lists/*

COPY services/ai-service/requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ---------------------------------------------------------------------------
FROM python:3.13-slim

# A non-root user, created before anything is copied so the COPYs land with the
# right ownership rather than needing a chown layer. This service is reachable
# from the ingest service and runs untrusted-shaped work (arbitrary numeric
# input through a scientific stack) — root would be a poor default anywhere and
# is a bad one here.
RUN useradd --create-home --uid 10001 averis

WORKDIR /app

COPY --from=builder /install /usr/local

# The engine is the payload; the service is a wrapper around it.
COPY --chown=averis:averis ai_engine/ ./ai_engine/
COPY --chown=averis:averis services/ai-service/app/ ./app/

# The trained fall model, baked in rather than fetched at boot. A cold start
# that downloads a model fails when the store is down, and the first request
# after a deploy is usually a health check.
COPY --chown=averis:averis ml/artifacts/ ./ml/artifacts/

USER averis

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8100

EXPOSE 8100

# Liveness only — it touches nothing. A healthcheck that ran an inference would
# fail under load and have the orchestrator restart a service that is busy.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,os,sys; sys.exit(0 if urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/api/health/live', timeout=2).status==200 else 1)"

# One worker per container. Scaling is the orchestrator's job, and two workers
# in one container share a CPU limit while hiding it from the scheduler.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 1"]
