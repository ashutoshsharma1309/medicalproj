# Meridian — Deployment

## 1. Docker Compose (recommended)

Prerequisites: Docker 24+, an `.env` file.

```bash
cp .env.example .env
# REQUIRED: set a strong AUTH_SECRET (32+ random chars)
# OPTIONAL: ANTHROPIC_API_KEY to enable the LLM layer
# OPTIONAL: POSTGRES_PASSWORD to override the default

docker compose up --build -d
```

What happens on boot:
1. `db` (Postgres 16) starts and passes its healthcheck.
2. `app` runs `prisma migrate deploy` (idempotent) then starts the standalone Next.js server
   on port 3000.
3. `redis` runs as an LRU cache tier (wired via `REDIS_URL`).

Seed demo data (optional, one-off):

```bash
docker compose exec app node node_modules/prisma/build/index.js db seed
```

> If the seed command is unavailable in the runtime image, run it from a dev checkout against
> the same `DATABASE_URL`: `DATABASE_URL=postgresql://meridian:…@localhost:5432/meridian npm run db:seed`
> (add `-p 5432:5432` to the db service or use `docker compose exec db`).

## 2. Bare-metal / VM

```bash
npm ci
npx prisma generate
npm run build
npx prisma migrate deploy
node .next/standalone/server.js   # PORT=3000
```

Run under systemd or PM2; terminate TLS at nginx/Caddy in front.

## 3. Managed platforms

- **App**: any Node 22 host (Railway, Render, Fly.io, ECS). Build command
  `npm run build`, start `node .next/standalone/server.js`, release phase
  `npx prisma migrate deploy`.
- **Database**: managed Postgres (Neon, RDS, Supabase). Set `DATABASE_URL`.
- **Vercel**: works without the Docker bits — remove `output: "standalone"` or keep it; set
  env vars in the dashboard and run migrations from CI.

## Environment reference

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | ✅ | Postgres connection string |
| `AUTH_SECRET` | ✅ (prod) | JWT signing secret — rotate to invalidate all sessions |
| `ANTHROPIC_API_KEY` | — | Enables LLM extraction/narratives/RAG synthesis; absent → deterministic mode |
| `ANTHROPIC_MODEL` | — | Defaults to `claude-opus-5` |
| `REDIS_URL` | — | Cache tier (optional) |

## Production checklist

- [ ] `AUTH_SECRET` from a secrets manager, not the repo
- [ ] TLS in front of the app (the session cookie is `secure` in production)
- [ ] Postgres backups + encryption at rest
- [ ] Restrict `db`/`redis` to the internal network (compose already does not publish them)
- [ ] Set `ANTHROPIC_API_KEY` as a secret; monitor spend in the Anthropic console
- [ ] Review the audit-log retention policy for your jurisdiction (HIPAA: 6 years)
- [ ] Replace the demo seed with real onboarding before any live data
