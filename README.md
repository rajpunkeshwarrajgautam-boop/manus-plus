# Manus Plus

Greenfield multi-surface autonomous agent platform: orchestrator, realtime collaboration, browser automation, skills registry, and web / desktop / mobile clients.

## Requirements

- **Node.js 20+** and npm
- This directory should be the **git repository root** when you push to GitHub so `.github/workflows` runs CI

## Quick start

```bash
npm install
npm run dev:apis
```

In another terminal:

```bash
npm run dev:web
```

Open http://localhost:3000. API ports: orchestrator **4100**, browser-operator **4101**, realtime **4102**, skills **4103**.

Health checks (with APIs running):

```bash
npm run verify:health
npm run e2e:smoke
```

Full local flow, scripts, Docker option, and identity persistence are documented in **[RUNBOOK.md](./RUNBOOK.md)**.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on push/PR to `main` or `master`: `npm ci`, typecheck, then integration (`dev:apis` + health + E2E). After your first push, enable **branch protection** on `main` and require this workflow to pass.

## Workspace layout

- `apps/web` — Next.js product surface
- `apps/desktop` — Electron shell
- `apps/mobile` — Expo mobile client
- `services/orchestrator` — task state machine, SSE, resume
- `services/browser-operator` — isolated browser sessions and takeover
- `services/realtime` — collaboration event layer
- `services/skills-registry` — skill publish/invoke APIs
- `packages/shared-types` — canonical contracts
- `packages/sdk` — API client helpers
- `packages/ui` — shared design system primitives

## License

Private / unlicensed unless you add a `LICENSE` file.
