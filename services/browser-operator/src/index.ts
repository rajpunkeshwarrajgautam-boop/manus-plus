import express from "express";
import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withAuth } from "./auth";
import { runBrowserAction } from "./runtime";
import { loadStore, saveStore } from "./persistence";

type BrowserSessionState = "active" | "waiting_user" | "closed";
interface BrowserSession {
  id: string;
  taskId: string;
  workspaceId: string;
  state: BrowserSessionState;
  currentUrl: string;
  secureVaultKeyRef: string;
  takeoverReason?: string;
}

const sessions = new Map<string, BrowserSession>();
const app = express();

function allowBrowserDev(req: Request, res: Response, next: NextFunction) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-actor-id, x-workspace-id, x-role");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
}

app.use(allowBrowserDev);
app.use(express.json());
app.use(withAuth);

const createSessionSchema = z.object({
  taskId: z.string().min(1),
  startUrl: z.string().url()
});
const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("goto"),
    url: z.string().url()
  }),
  z.object({
    action: z.literal("click"),
    url: z.string().url(),
    selector: z.string().min(1)
  }),
  z.object({
    action: z.literal("type"),
    url: z.string().url(),
    selector: z.string().min(1),
    text: z.string()
  })
]);
const versionInfo = {
  service: "browser-operator",
  version: "0.1.0",
  apiVersion: "v1"
};

app.post("/sessions", (req, res) => {
  const parsed = createSessionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });

  const session: BrowserSession = {
    id: randomUUID(),
    taskId: parsed.data.taskId,
    workspaceId: req.auth!.workspaceId,
    state: "active",
    currentUrl: parsed.data.startUrl,
    secureVaultKeyRef: `vault/${randomUUID()}`
  };
  sessions.set(session.id, session);
  saveStore([...sessions.values()]).catch(() => undefined);
  res.json(session);
});

app.post("/sessions/:id/navigate", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.workspaceId !== req.auth!.workspaceId) return res.status(403).json({ error: "Cross-workspace access denied" });
  if (session.state !== "active") return res.status(409).json({ error: "Session is not active" });

  const url = z.string().url().safeParse(req.body?.url);
  if (!url.success) return res.status(400).json({ error: "Invalid URL" });

  session.currentUrl = url.data;
  saveStore([...sessions.values()]).catch(() => undefined);
  res.json({ ok: true, id: session.id, currentUrl: session.currentUrl });
});

app.post("/sessions/:id/takeover/request", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.workspaceId !== req.auth!.workspaceId) return res.status(403).json({ error: "Cross-workspace access denied" });
  session.state = "waiting_user";
  session.takeoverReason = String(req.body?.reason || "verification_required");
  saveStore([...sessions.values()]).catch(() => undefined);
  res.json({ ok: true, state: session.state, reason: session.takeoverReason });
});

app.post("/sessions/:id/takeover/release", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.workspaceId !== req.auth!.workspaceId) return res.status(403).json({ error: "Cross-workspace access denied" });
  session.state = "active";
  session.takeoverReason = undefined;
  saveStore([...sessions.values()]).catch(() => undefined);
  res.json({ ok: true, state: session.state });
});

app.get("/sessions/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.workspaceId !== req.auth!.workspaceId) return res.status(403).json({ error: "Cross-workspace access denied" });
  res.json(session);
});

app.post("/sessions/:id/actions", async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.workspaceId !== req.auth!.workspaceId) return res.status(403).json({ error: "Cross-workspace access denied" });
  if (session.state !== "active") return res.status(409).json({ error: "Session is not active" });

  const payload = actionSchema.safeParse(req.body);
  if (!payload.success) return res.status(400).json({ error: payload.error.issues });

  const result = await runBrowserAction(payload.data);
  res.json(result);
});

app.get("/health", (_req, res) => {
  return res.json({
    ok: true,
    service: "browser-operator",
    uptimeSec: Math.round(process.uptime()),
    activeSessions: sessions.size
  });
});

app.get("/version", (_req, res) => {
  return res.json(versionInfo);
});

app.get("/readiness", (_req, res) => {
  return res.json({
    ok: true,
    checks: [
      { name: "session_store_loaded", status: "pass", details: `sessions=${sessions.size}` },
      { name: "action_schema_initialized", status: "pass" }
    ]
  });
});

const port = Number(process.env.PORT || 4101);
async function bootstrap() {
  const saved = await loadStore<BrowserSession>();
  for (const item of saved) {
    sessions.set(item.id, item);
  }
  const server = app.listen(port, () => {
    console.log(`browser-operator listening on ${port}`);
  });

  const shutdown = (signal: string) => {
    console.log(`browser-operator ${signal}, shutting down…`);
    const force = setTimeout(() => process.exit(0), 10_000).unref();
    server.close(() => {
      clearTimeout(force);
      process.exit(0);
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : "Unhandled browser-operator error";
  return res.status(500).json({ error: message });
});

void bootstrap();
