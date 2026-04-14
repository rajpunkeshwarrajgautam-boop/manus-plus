# Manus Plus — runbook

## Local development (default: npm)

1. Install: `npm install` at repo root `manus-plus/`.
2. Start all API processes (orchestrator, realtime, browser-operator, skills-registry):
   - **`npm run dev:apis`** — four dev servers, no probe; or  
   - **`npm run smoke:services`** — same four plus a waiter; stop when you see **`[smoke] All API services ready`**
3. Start the web UI in another terminal: **`npm run dev:web`** → http://localhost:3000  
   Or use one terminal: **`npm run smoke:stack`** (APIs + waiter + Next dev).

Health check (expects API processes running):

```bash
npm run verify:health
```

End-to-end smoke (orchestrator on **4100** only: `POST /tasks` SSE until `task_completed`, then `GET /tasks/:id` asserts `state === completed`):

```bash
npm run e2e:smoke
```

Ports: orchestrator **4100**, browser-operator **4101**, realtime **4102** (HTTP `/health`; WebSocket for clients), skills **4103**, web **3000**.

### CI (GitHub Actions)

On push/PR to `main` or `master`, `.github/workflows/ci.yml` runs **`npm ci`**, **`npm run type-check`**, and **`npm run ci:integration`** (starts all four APIs, waits for `/health`, then **`verify:health`** + **`e2e:smoke`**). Stop anything already bound to **4100–4103** before running **`ci:integration`** locally, or you will get port conflicts.

### Optional: Docker

If you use Docker instead of local Node, see `docker-compose.yml` and run `npm run docker:up` (requires Docker Engine + Compose v2). That also starts Postgres **5432** (`manus` / `manus` / `manus`) for when Prisma is wired; the orchestrator still uses its on-disk run store until then.

## Environment

See `env.example` at repo root. Copy values into `apps/web/.env.local` for Next.js public URLs.

For Expo on a physical device, set `EXPO_PUBLIC_ORCHESTRATOR_URL` and `EXPO_PUBLIC_REALTIME_URL` to your dev machine’s LAN IP.

## Desktop / mobile packaging

- Desktop: `npm run package:dir --workspace @manus-plus/desktop` (unpackaged build) or `npm run package:dist` for installers.
- Mobile: `npm run eas:preview --workspace @manus-plus/mobile` after `eas login` and project configuration.

## Identity persistence (web)

Workspace identity (`actorId`, `workspaceId`, `role`, `sessionId`, `idempotency seed`) is saved to `localStorage` and restored on reload. Use **Reset saved identity** in the sidebar to clear.
