# Manus Plus — runbook

## Local development (default: npm)

1. Install: `npm install` at repo root `manus-plus/`.
2. Start all API processes (orchestrator, realtime, browser-operator, skills-registry):
   - **`npm run dev:apis`** — four dev servers, no probe; or  
   - **`npm run smoke:services`** — same four plus a waiter; stop when you see **`[smoke] All API services ready`**
3. Start the web UI in another terminal: **`npm run dev:web`** → http://localhost:3000  
   Or use one terminal: **`npm run smoke:stack`** (APIs + waiter + Next dev).

4. **Desktop (Electron)** — same product as the browser: **`npm run dev:desktop`** at repo root (requires step 2 + 3). Set **`MANUS_PLUS_WEB_URL`** if the web app is not on `http://localhost:3000` (see `.env.example`).

Health check (expects API processes running):

```bash
npm run verify:health
```

Consolidated preflight:

```bash
# Local full reliability pass (static + integration runtime checks)
npm run verify:ops
```

Readiness semantics: `GET /readiness` returns **200** only when a service is ready to serve traffic, and **503** during startup/shutdown (or dependency failures such as Postgres connectivity in orchestrator Postgres mode). `GET /health` also includes a lifecycle `status` field (`starting`, `ready`, `shutting_down`) for dashboards/alerts.

API services now emit one structured JSON access log per HTTP request (via shared `@manus-plus/observability` helpers), including propagated/generated `x-request-id`, method, path, status code, and duration in milliseconds. Clients can send `x-request-id` to correlate traces end-to-end; services echo it back in the response header. Sensitive values are redacted in logs (for example auth/cookie headers and secret-like query parameters such as `token`, `api_key`, and `password`).

Error responses in backend APIs now include a stable `errorCode` alongside `error` for 4xx/5xx outcomes, so dashboards and alerting can aggregate failure modes without relying on free-form message text.

`GET /health` now also includes lightweight reliability counters: `errorResponsesTotal` and `readinessFailuresTotal`, plus `reliabilityMetricsResetAt`. Operators can inspect the raw counters at `GET /ops/reliability` and reset them via `POST /ops/reliability/reset` to create rolling-window monitoring periods. Those `/ops/reliability` endpoints require **`x-role: admin`** (and, where the service uses auth middleware, the usual actor/workspace headers). This matches other `/ops/*` routes on the orchestrator.

End-to-end smoke (orchestrator on **4100** only: `POST /tasks` SSE until `task_completed`, then `GET /tasks/:id` asserts `state === completed`):

```bash
npm run e2e:smoke
```

Ports: orchestrator **4100**, browser-operator **4101**, realtime **4102** (HTTP `/health`; WebSocket for clients), skills **4103**, web **3000**.

### CI (GitHub Actions)

On push/PR to `main` or `master`, `.github/workflows/ci.yml` first validates Compose wiring with **`docker compose config`**, then runs **`npm ci`** and a single consolidated preflight command: **`npm run verify:ops:ci`**. That command runs **`verify:error-codes`**, **`type-check`**, **`migrate:deploy -w @manus-plus/orchestrator`** (against a **Postgres 16** service), and **`ci:integration`** (all four APIs + **Next.js dev** on **3000**, **`verify:health`**, **`verify:error-codes:runtime`**, **`e2e:smoke`**). CI sets **`DATABASE_URL`** so the orchestrator uses Postgres in that job.

For easier troubleshooting, `ci:integration` is composed from smaller scripts: `ci:start:apis`, `ci:start:web`, and `ci:checks:runtime`.

Locally, **`ci:integration`** still works **without** `DATABASE_URL` (orchestrator uses the JSON file store under `services/orchestrator/.data/runs.json`). Stop anything already bound to **4100–4103** and **3000** before running it, or you will get port conflicts.

### Optional: Docker

If you use Docker instead of local Node, see `docker-compose.yml` and run `npm run docker:up` (requires Docker Engine + Compose v2). Compose sets **`DATABASE_URL`** for the orchestrator container; the image runs **`prisma migrate deploy`** before starting the server.

Node API and web containers use Compose **`init: true`** (signal-friendly PID 1) and **`stop_grace_period: 15s`** so **SIGTERM** / **`docker compose stop`** can reach each process before forced exit. Services close HTTP (or WebSocket for realtime), and the orchestrator disconnects Prisma, matching local **SIGINT** / **SIGTERM** behavior (see in-process **~10s** fallback timers in each service). Compose healthchecks probe each service’s `/health` endpoint, and `web` waits for healthy APIs before startup to reduce cold-start races.

### Orchestrator persistence

- **File (default):** if **`DATABASE_URL`** is unset, task runs are stored in **`ORCHESTRATOR_STORE_PATH`** or, by default, **`services/orchestrator/.data/runs.json`** (relative to the orchestrator process cwd, usually the workspace package root).
- **Postgres:** set **`DATABASE_URL`** (see `.env.example`). Apply schema: **`npm run migrate:deploy -w @manus-plus/orchestrator`**. **`GET /health`** includes **`"persistence": "file"`** or **`"postgres"`** in the JSON body. Idempotent **`POST /tasks`** replays are resolved against Postgres when the in-memory map is cold.
- **Retention (Postgres):** optional **`ORCHESTRATOR_RETENTION_DAYS`** (positive integer). On startup, terminal runs (**`completed`**, **`failed`**, **`cancelled`**) older than that many days are deleted so storage stays bounded. Active runs (**`queued`**, **`running`**, **`waiting_user`**) are never removed.

### Local APIs with Postgres (optional)

1. Start only Postgres: **`docker compose up -d postgres`** (from repo root; waits until healthy on **5432**).
2. Apply schema once (or after migration changes): **`npm run migrate:deploy -w @manus-plus/orchestrator`** with the same **`DATABASE_URL`** as in `.env.example` (`postgresql://manus:manus@localhost:5432/manus`).
3. In the same shell session as the APIs, export **`DATABASE_URL`** (PowerShell: **`$env:DATABASE_URL="postgresql://manus:manus@localhost:5432/manus"`**), then **`npm run dev:apis`** (or **`npm run smoke:services`**). Confirm **`GET http://localhost:4100/health`** shows **`"persistence":"postgres"`** and **`GET /readiness`** is **200**.

## Environment

See `.env.example` at repo root. Copy the Next.js block into `apps/web/.env.local` for public URLs; use the Expo block in `apps/mobile/.env` on a device (LAN IP for hostnames).

For Expo on a physical device, set `EXPO_PUBLIC_ORCHESTRATOR_URL` and `EXPO_PUBLIC_REALTIME_URL` to your dev machine’s LAN IP.

## Desktop / mobile packaging

- Desktop: `npm run package:dir --workspace @manus-plus/desktop` (unpackaged build) or `npm run package:dist` for installers.
- Mobile: `npm run eas:preview --workspace @manus-plus/mobile` after `eas login` and project configuration.

## Identity persistence (web)

Workspace identity (`actorId`, `workspaceId`, `role`, `sessionId`, `idempotency seed`) is saved to `localStorage` and restored on reload. Use **Reset saved identity** in the sidebar to clear.
