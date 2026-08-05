# =============================================================================
# AVERIS — production image
#
# Multi-stage, targeting Cloud Run. Three things here are not boilerplate.
#
# 1. Debian, not Alpine.
#
#    Phase 5 added transformers.js, which pulls onnxruntime-node — and that
#    ships prebuilt glibc binaries. On Alpine (musl) the package installs
#    cleanly and then fails at require() time, so the image builds green and
#    dies on the first embedding call. The slim Debian base is ~40 MB larger
#    and actually runs.
#
# 2. The embedding model is baked in at build time.
#
#    all-MiniLM-L6-v2 is ~23 MB and transformers.js fetches it on first use.
#    In a container that means the first request after every cold start pays a
#    ~100 second download, and on Cloud Run — where instances scale to zero —
#    "after every cold start" is often. It also makes serving depend on
#    huggingface.co being reachable at request time, which is a runtime
#    dependency on a third party for a health record system.
#
# 3. The runtime stage receives no secrets.
#
#    Only NEXT_PUBLIC_* values are present at build, because Next.js inlines
#    those into the client bundle and they are publishable by definition.
#    GROQ_API_KEY and friends are read on the server at request time and are
#    injected by Cloud Run, never baked into a layer.
# =============================================================================

# ---------------------------------------------------------------- deps
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Copied alone so this layer stays cached until the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# --------------------------------------------------------------- model
# A separate stage because the download is slow and changes far less often
# than application code — it must not be invalidated by a source edit.
FROM deps AS model
WORKDIR /app

ENV HF_HOME=/opt/hf-cache
RUN mkdir -p /opt/hf-cache

COPY scripts/fetch-model.mjs ./scripts/fetch-model.mjs
RUN node scripts/fetch-model.mjs

# --------------------------------------------------------------- build
FROM deps AS build
WORKDIR /app

COPY . .

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ----------------------------------------------------------------- run
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HF_HOME=/opt/hf-cache \
    SERVICE_NAME=averis-web \
    PORT=8080 \
    HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 averis \
 && useradd --system --uid 1001 --gid averis averis

# `standalone` carries only the traced dependencies, not all of node_modules.
COPY --from=build --chown=averis:averis /app/.next/standalone ./
COPY --from=build --chown=averis:averis /app/.next/static ./.next/static
COPY --from=build --chown=averis:averis /app/public ./public
COPY --from=model --chown=averis:averis /opt/hf-cache /opt/hf-cache

# Cloud Run does not require a non-root user. A container that gets
# compromised anyway should not also be root.
USER averis
EXPOSE 8080

# Readiness, not the root page: the landing page renders for signed-out
# visitors even when the database is unreachable, so probing it would report
# healthy during exactly the outage that matters.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
