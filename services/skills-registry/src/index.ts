import express from "express";
import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { logAccess, resolveRequestId } from "@manus-plus/observability";
import { z } from "zod";
import { loadStore, saveStore } from "./persistence";

interface SkillVersion {
  id: string;
  version: number;
  instructions: string;
  createdAt: string;
}

interface Skill {
  id: string;
  workspaceId: string;
  actorId: string;
  slug: string;
  title: string;
  versions: SkillVersion[];
}

const app = express();
let isReady = false;
let isShuttingDown = false;

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
app.use((req, res, next) => {
  const requestId = resolveRequestId(req.headers["x-request-id"]);
  const startedAt = Date.now();
  res.setHeader("x-request-id", requestId);
  res.on("finish", () => {
    logAccess({
      service: "skills-registry",
      requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      headers: req.headers
    });
  });
  next();
});
const skills = new Map<string, Skill>();

const createSkillSchema = z.object({
  workspaceId: z.string().min(1),
  actorId: z.string().min(1),
  slug: z.string().min(2),
  title: z.string().min(2),
  instructions: z.string().min(10)
});
const versionInfo = {
  service: "skills-registry",
  version: "0.1.0",
  apiVersion: "v1"
};

function sendError(
  res: express.Response,
  statusCode: number,
  errorCode: string,
  message: string,
  extra: Record<string, unknown> = {}
) {
  return res.status(statusCode).json({ errorCode, error: message, ...extra });
}

app.post("/skills", (req, res) => {
  const parsed = createSkillSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "invalid_skill_payload", "Invalid skill payload", { issues: parsed.error.issues });

  const existing = [...skills.values()].find((s) => s.workspaceId === parsed.data.workspaceId && s.slug === parsed.data.slug);
  if (existing) return sendError(res, 409, "skill_slug_conflict", "Skill slug already exists in workspace");

  const skill: Skill = {
    id: randomUUID(),
    workspaceId: parsed.data.workspaceId,
    actorId: parsed.data.actorId,
    slug: parsed.data.slug,
    title: parsed.data.title,
    versions: [{
      id: randomUUID(),
      version: 1,
      instructions: parsed.data.instructions,
      createdAt: new Date().toISOString()
    }]
  };
  skills.set(skill.id, skill);
  saveStore([...skills.values()]).catch(() => undefined);
  res.status(201).json(skill);
});

app.post("/skills/:id/versions", (req, res) => {
  const skill = skills.get(req.params.id);
  if (!skill) return sendError(res, 404, "skill_not_found", "Skill not found");
  const workspaceId = z.string().min(1).safeParse(req.body?.workspaceId);
  if (!workspaceId.success || workspaceId.data !== skill.workspaceId) {
    return sendError(res, 403, "cross_workspace_access_denied", "Cross-workspace access denied");
  }

  const instructions = z.string().min(10).safeParse(req.body?.instructions);
  if (!instructions.success) return sendError(res, 400, "instructions_required", "instructions required");

  const version: SkillVersion = {
    id: randomUUID(),
    version: skill.versions[skill.versions.length - 1].version + 1,
    instructions: instructions.data,
    createdAt: new Date().toISOString()
  };
  skill.versions.push(version);
  saveStore([...skills.values()]).catch(() => undefined);
  res.status(201).json(version);
});

app.post("/skills/:id/invoke", (req, res) => {
  const skill = skills.get(req.params.id);
  if (!skill) return sendError(res, 404, "skill_not_found", "Skill not found");
  const workspaceId = z.string().min(1).safeParse(req.body?.workspaceId);
  if (!workspaceId.success || workspaceId.data !== skill.workspaceId) {
    return sendError(res, 403, "cross_workspace_access_denied", "Cross-workspace access denied");
  }

  const current = skill.versions[skill.versions.length - 1];
  res.json({
    taskTemplate: {
      title: skill.title,
      prompt: `Run skill ${skill.slug} with payload: ${JSON.stringify(req.body?.payload ?? {})}`
    },
    instructions: current.instructions
  });
});

app.get("/skills", (_req, res) => {
  const workspaceId = String(_req.query.workspaceId || "");
  if (!workspaceId) {
    return sendError(res, 400, "workspace_id_required", "workspaceId query param is required");
  }
  res.json({ skills: [...skills.values()].filter((s) => s.workspaceId === workspaceId) });
});

app.get("/health", (_req, res) => {
  const status = isShuttingDown ? "shutting_down" : isReady ? "ready" : "starting";
  return res.json({
    ok: true,
    status,
    service: "skills-registry",
    uptimeSec: Math.round(process.uptime()),
    skillCount: skills.size
  });
});

app.get("/version", (_req, res) => {
  return res.json(versionInfo);
});

app.get("/readiness", (_req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({
      ok: false,
      checks: [{ name: "lifecycle", status: "fail", details: "shutting_down" }]
    });
  }
  const checks = [
    { name: "lifecycle", status: isReady ? "pass" : "fail", details: isReady ? "ready" : "starting" },
    { name: "skills_store_loaded", status: "pass", details: `skills=${skills.size}` },
    { name: "workspace_guardrails_enabled", status: "pass" }
  ];
  return res.json({
    ok: checks.every((check) => check.status === "pass"),
    checks
  });
});

const port = Number(process.env.PORT || 4103);
async function bootstrap() {
  const saved = await loadStore<Skill>();
  for (const skill of saved) {
    skills.set(skill.id, skill);
  }
  const server = app.listen(port, () => {
    isReady = true;
    console.log(`skills-registry listening on ${port}`);
  });

  const shutdown = (signal: string) => {
    console.log(`skills-registry ${signal}, shutting down…`);
    isShuttingDown = true;
    isReady = false;
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
  const message = err instanceof Error ? err.message : "Unhandled skills-registry error";
  return sendError(res, 500, "internal_error", message);
});

void bootstrap();
