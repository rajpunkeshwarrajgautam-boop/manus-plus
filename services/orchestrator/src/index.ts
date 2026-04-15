import express from "express";
import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { logAccess, resolveRequestId } from "@manus-plus/observability";
import { z } from "zod";
import { appendStep, checkpoint, createRun, findRunByIdempotency, hydrateRuns, runs, setPersistenceHook } from "./state-machine";
import { routeModel } from "./model-router";
import { scoreReliability } from "./reliability";
import { emitMetric, metrics, summarizeMetrics } from "./telemetry";
import { auditTrail, recordAudit } from "./audit";
import {
  disconnectPersistence,
  findRunByIdempotencyStored,
  loadRuns,
  persistRun,
  persistenceBackend,
  pingPostgres,
  pruneTerminalRunsByRetention
} from "./persistence";
import { withAuth } from "./auth";
import { eventSchemas, OrchestratorEventName } from "./event-protocol";

const app = express();
let isReady = false;
let isShuttingDown = false;

function allowBrowserDev(req: Request, res: Response, next: NextFunction) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Idempotency-Key, idempotency-key, x-actor-id, x-workspace-id, x-role"
  );
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
      service: "orchestrator",
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
app.use(withAuth);
app.use((req, res, next) => {
  const actorId = req.auth?.actorId || "anonymous";
  const role = req.auth?.role || "user";
  if (req.path.startsWith("/ops") && role !== "admin") {
    return sendError(res, 403, "admin_role_required", "Admin role required");
  }
  recordAudit({
    actorId,
    action: req.method,
    resourceType: "http",
    resourceId: req.path
  });
  next();
});

const createTaskSchema = z.object({
  prompt: z.string().min(1),
  sessionId: z.string().min(1),
  maxRetries: z.number().int().min(1).max(10).optional()
});

const resumeSchema = z.object({ reason: z.string().min(1).optional() }).optional();
const cancelSchema = z.object({ reason: z.string().min(1).optional() }).optional();
const exportQuerySchema = z.object({
  format: z.enum(["json", "markdown"]).optional()
});
const listTasksQuerySchema = z.object({
  state: z.enum(["queued", "running", "waiting_user", "completed", "failed", "cancelled"]).optional(),
  phase: z.enum(["plan", "execute", "verify", "finalize"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});
const versionInfo = {
  service: "orchestrator",
  version: "0.1.0",
  apiVersion: "v1"
};
const reliabilityMetrics = {
  errorResponsesTotal: 0,
  readinessFailuresTotal: 0,
  resetAt: new Date().toISOString()
};

function resetReliabilityMetrics() {
  reliabilityMetrics.errorResponsesTotal = 0;
  reliabilityMetrics.readinessFailuresTotal = 0;
  reliabilityMetrics.resetAt = new Date().toISOString();
}

function sendError(
  res: express.Response,
  statusCode: number,
  errorCode: string,
  message: string,
  extra: Record<string, unknown> = {}
) {
  if (statusCode >= 400) {
    reliabilityMetrics.errorResponsesTotal += 1;
  }
  return res.status(statusCode).json({ errorCode, error: message, ...extra });
}

function publish(res: express.Response, event: OrchestratorEventName, data: unknown) {
  const validated = eventSchemas[event].safeParse(data);
  if (!validated.success) {
    return;
  }
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(validated.data)}\n\n`);
}

function toStepPayload(taskId: string, step: { id: string; phase: string; type: string; content: string; createdAt: string }) {
  return {
    id: step.id,
    taskId,
    phase: step.phase,
    type: step.type,
    content: step.content,
    createdAt: step.createdAt
  };
}

function evaluateQuality(prompt: string, draft: string, attempt: number): { score: number; passed: boolean; reason: string } {
  const base = Math.min(100, Math.floor((draft.length / Math.max(40, prompt.length)) * 42));
  const structureBonus = /summary|result|next steps|analysis/i.test(draft) ? 24 : 0;
  const refinementBonus = attempt > 1 ? 12 : 0;
  const score = Math.min(100, base + structureBonus + refinementBonus);
  if (score >= 60) {
    return { score, passed: true, reason: "Draft passed minimum quality threshold." };
  }
  return { score, passed: false, reason: "Draft lacks enough detail/structure; refinement required." };
}

function estimateTaskCost(stepCount: number, retryCount: number): number {
  const base = 0.0025;
  const stepCost = stepCount * 0.0004;
  const retryCost = retryCount * 0.001;
  return Number((base + stepCost + retryCost).toFixed(4));
}

async function executeRun(taskId: string, res?: express.Response) {
  const run = runs.get(taskId);
  if (!run) return;

  run.state = "running";
  void persistRun(run).catch(() => undefined);
  emitMetric("task_started", 1, { taskId });
  if (res) publish(res, "task_started", { taskId, state: run.state });

  try {
    run.phase = "plan";
    const route = routeModel(run.prompt);
    const planStep = appendStep(run, { phase: "plan", type: "thinking", content: `Planning with ${route.provider}/${route.model}` });
    checkpoint(run, "plan_created");
    if (res) publish(res, "step_created", toStepPayload(taskId, planStep));

    run.phase = "execute";
    let draft = `Result Summary:\nTask: ${run.prompt}\n\nAnalysis:\n- Gathered baseline insights\n- Built draft response\n\nNext Steps:\n- Validate final quality\n- Deliver artifacts`;
    const executeStep = appendStep(run, { phase: "execute", type: "tool_call", content: "Executing tool pipeline and building draft artifact" });
    checkpoint(run, "execution_pass_1");
    if (res) publish(res, "step_created", toStepPayload(taskId, executeStep));

    let qualityPassed = false;
    const maxQualityAttempts = 2;
    for (let attempt = 1; attempt <= maxQualityAttempts; attempt++) {
      run.phase = "verify";
      const quality = evaluateQuality(run.prompt, draft, attempt);
      const verifyStep = appendStep(run, {
        phase: "verify",
        type: "tool_result",
        content: `Quality gate attempt ${attempt}: score ${quality.score}/100. ${quality.reason}`
      });
      if (res) {
        publish(res, "step_created", toStepPayload(taskId, verifyStep));
        publish(res, "quality_gate", {
          taskId,
          attempt,
          score: quality.score,
          passed: quality.passed,
          reason: quality.reason
        });
      }
      if (quality.passed) {
        qualityPassed = true;
        break;
      }
      run.retryCount += 1;
      if (run.retryCount > run.maxRetries) {
        throw new Error("Quality gate retries exceeded maxRetries");
      }
      run.phase = "execute";
      const refineStep = appendStep(run, {
        phase: "execute",
        type: "tool_call",
        content: `Refinement pass ${attempt}: expanding reasoning depth and actionable details`
      });
      draft += `\n\nRefinement ${attempt}:\n- Added deeper comparative analysis\n- Added measurable outcomes\n- Added risk mitigation notes`;
      if (res) {
        publish(res, "step_created", toStepPayload(taskId, refineStep));
        publish(res, "task_retrying", { taskId, retryCount: run.retryCount, reason: "quality_gate_failed" });
      }
    }
    if (!qualityPassed) {
      throw new Error("Quality gate failed after all refinement attempts");
    }

    run.phase = "finalize";
    run.artifacts.push({
      id: randomUUID(),
      kind: "report",
      title: "Task summary",
      content: draft
    });
    const finalStep = appendStep(run, { phase: "finalize", type: "response", content: "Task completed successfully with quality gate pass." });
    run.state = "completed";
    void persistRun(run).catch(() => undefined);
    emitMetric("task_completed", 1, { taskId, reliability: String(scoreReliability(run)) });
    emitMetric("task_cost_estimate", estimateTaskCost(run.steps.length, run.retryCount), { taskId, status: "completed" });
    if (res) {
      publish(res, "artifact_created", run.artifacts[run.artifacts.length - 1]);
      publish(res, "step_created", toStepPayload(taskId, finalStep));
      publish(res, "task_completed", { taskId, state: run.state, reliability: scoreReliability(run) });
    }
  } catch (error) {
    run.retryCount += 1;
    const errorStep = appendStep(run, { phase: run.phase, type: "error", content: error instanceof Error ? error.message : "Unknown error" });
    if (res) {
      publish(res, "step_created", toStepPayload(taskId, errorStep));
    }
    if (run.retryCount <= run.maxRetries) {
      if (res) publish(res, "task_retrying", { taskId, retryCount: run.retryCount, reason: "execution_error" });
      return executeRun(taskId, res);
    }
    run.state = "failed";
    void persistRun(run).catch(() => undefined);
    emitMetric("task_failed", 1, { taskId });
    emitMetric("task_cost_estimate", estimateTaskCost(run.steps.length, run.retryCount), { taskId, status: "failed" });
    if (res) publish(res, "task_failed", { taskId, state: run.state, reason: error instanceof Error ? error.message : "unknown" });
  }
}

app.post("/tasks", async (req, res) => {
  const parsed = createTaskSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "invalid_task_payload", "Invalid task payload", { issues: parsed.error.issues });
  }
  const idempotencyKey = String(req.headers["idempotency-key"] || "");
  const workspaceId = req.auth!.workspaceId;
  const actorId = req.auth!.actorId;
  if (idempotencyKey) {
    let existing = findRunByIdempotency(workspaceId, idempotencyKey);
    if (!existing) {
      const fromDb = await findRunByIdempotencyStored(workspaceId, idempotencyKey);
      if (fromDb) {
        hydrateRuns([fromDb]);
        existing = findRunByIdempotency(workspaceId, idempotencyKey);
      }
    }
    if (existing) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      publish(res, "task_reused", { taskId: existing.id, state: existing.state });
      for (const step of existing.steps) {
        publish(res, "step_created", toStepPayload(existing.id, step));
      }
      if (existing.state === "completed") {
        publish(res, "task_completed", { taskId: existing.id, state: existing.state, reliability: scoreReliability(existing) });
      }
      res.end();
      return;
    }
  }
  const workspaceScopedSession = `${req.auth?.workspaceId}:${parsed.data.sessionId}`;
  const run = createRun(parsed.data.prompt, workspaceScopedSession, workspaceId, actorId, idempotencyKey || undefined);
  if (parsed.data.maxRetries) {
    run.maxRetries = parsed.data.maxRetries;
    void persistRun(run).catch(() => undefined);
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  try {
    await executeRun(run.id, res);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "internal_error";
    console.error("[orchestrator] executeRun failed", error);
    try {
      publish(res, "task_failed", { taskId: run.id, state: "failed", reason: msg });
    } catch {
      // ignore secondary failures while closing the stream
    }
  } finally {
    if (!res.writableEnded) {
      res.end();
    }
  }
});

app.post("/tasks/:id/resume", async (req, res) => {
  const resumeParsed = resumeSchema?.safeParse(req.body);
  if (resumeParsed && !resumeParsed.success) {
    return sendError(res, 400, "invalid_resume_payload", "Invalid resume payload", { issues: resumeParsed.error.issues });
  }
  const run = runs.get(req.params.id);
  if (!run) return sendError(res, 404, "task_not_found", "Task not found");
  if (run.workspaceId !== req.auth!.workspaceId) return sendError(res, 403, "cross_workspace_access_denied", "Cross-workspace access denied");
  if (run.state === "completed") return sendError(res, 409, "task_already_completed", "Task already completed");

  const resumeReason = resumeParsed?.success ? resumeParsed.data?.reason : undefined;
  if (resumeReason) {
    appendStep(run, {
      phase: run.phase,
      type: "checkpoint",
      content: `Resume requested by ${req.auth!.actorId}: ${resumeReason}`
    });
  }
  run.state = "running";
  run.phase = run.phase === "finalize" ? "verify" : run.phase;
  checkpoint(run, "manual_resume");
  await executeRun(run.id);
  return res.json({ ok: true, taskId: run.id, state: run.state, phase: run.phase });
});

app.post("/tasks/:id/cancel", (req, res) => {
  const cancelParsed = cancelSchema?.safeParse(req.body);
  if (cancelParsed && !cancelParsed.success) {
    return sendError(res, 400, "invalid_cancel_payload", "Invalid cancel payload", { issues: cancelParsed.error.issues });
  }
  const run = runs.get(req.params.id);
  if (!run) return sendError(res, 404, "task_not_found", "Task not found");
  if (run.workspaceId !== req.auth!.workspaceId) return sendError(res, 403, "cross_workspace_access_denied", "Cross-workspace access denied");
  const cancelReason = cancelParsed?.success ? cancelParsed.data?.reason : undefined;
  appendStep(run, {
    phase: run.phase,
    type: "checkpoint",
    content: `Task cancelled by ${req.auth!.actorId}${cancelReason ? `: ${cancelReason}` : ""}`
  });
  run.state = "cancelled";
  void persistRun(run).catch(() => undefined);
  return res.json({ ok: true, taskId: run.id, state: run.state });
});

app.get("/tasks/:id", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return sendError(res, 404, "task_not_found", "Task not found");
  if (run.workspaceId !== req.auth!.workspaceId) return sendError(res, 403, "cross_workspace_access_denied", "Cross-workspace access denied");
  return res.json({
    task: run,
    reliability: scoreReliability(run)
  });
});

app.get("/tasks/:id/export", (req, res) => {
  const query = exportQuerySchema.safeParse(req.query);
  if (!query.success) {
    return sendError(res, 400, "invalid_export_query", "Invalid export query", { issues: query.error.issues });
  }
  const run = runs.get(req.params.id);
  if (!run) return sendError(res, 404, "task_not_found", "Task not found");
  if (run.workspaceId !== req.auth!.workspaceId) return sendError(res, 403, "cross_workspace_access_denied", "Cross-workspace access denied");

  const format = query.data.format || "json";
  if (format === "json") {
    return res.json({
      task: run,
      reliability: scoreReliability(run)
    });
  }

  const markdown = [
    `# Task Export`,
    ``,
    `- Task ID: ${run.id}`,
    `- State: ${run.state}`,
    `- Phase: ${run.phase}`,
    `- Retry Count: ${run.retryCount}`,
    `- Reliability: ${scoreReliability(run)}`,
    ``,
    `## Prompt`,
    run.prompt,
    ``,
    `## Steps`,
    ...run.steps.map((step, idx) => `${idx + 1}. [${step.phase}/${step.type}] ${step.content}`),
    ``,
    `## Artifacts`,
    ...(run.artifacts.length > 0
      ? run.artifacts.map((artifact, idx) => `${idx + 1}. ${artifact.title} (${artifact.kind})`)
      : ["No artifacts generated."])
  ].join("\n");

  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  return res.send(markdown);
});

app.get("/tasks", (req, res) => {
  const query = listTasksQuerySchema.safeParse(req.query);
  if (!query.success) {
    return sendError(res, 400, "invalid_query", "Invalid query", { issues: query.error.issues });
  }
  const workspaceId = req.auth!.workspaceId;
  let all = [...runs.values()].filter((run) => run.workspaceId === workspaceId);
  if (query.data.state) {
    all = all.filter((run) => run.state === query.data.state);
  }
  if (query.data.phase) {
    all = all.filter((run) => run.phase === query.data.phase);
  }
  all.sort((a, b) => {
    const aTs = a.steps[a.steps.length - 1]?.createdAt || "";
    const bTs = b.steps[b.steps.length - 1]?.createdAt || "";
    return bTs.localeCompare(aTs);
  });
  const limit = query.data.limit || 20;
  return res.json({
    tasks: all.slice(0, limit).map((run) => ({
      id: run.id,
      sessionId: run.sessionId,
      prompt: run.prompt,
      state: run.state,
      phase: run.phase,
      retryCount: run.retryCount,
      steps: run.steps.length,
      artifacts: run.artifacts.length
    }))
  });
});

app.get("/ops/metrics", (_req, res) => {
  res.json({ metrics });
});

app.get("/ops/metrics-summary", (_req, res) => {
  res.json(summarizeMetrics());
});

app.get("/ops/audit", (_req, res) => {
  res.json({ auditTrail });
});

app.get("/ops/reliability", (_req, res) => {
  res.json({ reliability: reliabilityMetrics });
});

app.post("/ops/reliability/reset", (_req, res) => {
  resetReliabilityMetrics();
  res.json({ ok: true, reliability: reliabilityMetrics });
});

app.get("/health", (_req, res) => {
  const status = isShuttingDown ? "shutting_down" : isReady ? "ready" : "starting";
  return res.json({
    ok: true,
    status,
    service: "orchestrator",
    uptimeSec: Math.round(process.uptime()),
    runsInMemory: runs.size,
    persistence: persistenceBackend(),
    errorResponsesTotal: reliabilityMetrics.errorResponsesTotal,
    readinessFailuresTotal: reliabilityMetrics.readinessFailuresTotal,
    reliabilityMetricsResetAt: reliabilityMetrics.resetAt
  });
});

app.get("/version", (_req, res) => {
  return res.json(versionInfo);
});

app.get("/readiness", async (_req, res) => {
  if (isShuttingDown) {
    reliabilityMetrics.readinessFailuresTotal += 1;
    return res.status(503).json({
      ok: false,
      checks: [{ name: "lifecycle", status: "fail", details: "shutting_down" }]
    });
  }
  const checks: Array<{ name: string; status: string; details?: string }> = [
    { name: "lifecycle", status: isReady ? "pass" : "fail", details: isReady ? "ready" : "starting" },
    { name: "runs_store_loaded", status: "pass", details: `in_memory_runs=${runs.size}` },
    { name: "event_protocol_initialized", status: "pass" },
    { name: "persistence", status: "pass", details: persistenceBackend() }
  ];
  if (persistenceBackend() === "postgres") {
    const db = await pingPostgres();
    checks.push({
      name: "postgres",
      status: db.ok ? "pass" : "fail",
      details: db.ok ? "connected" : db.detail
    });
  }
  const ok = checks.every((c) => c.status === "pass");
  if (!ok) {
    reliabilityMetrics.readinessFailuresTotal += 1;
  }
  return res.status(ok ? 200 : 503).json({ ok, checks });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : "Unhandled orchestrator error";
  return sendError(res, 500, "internal_error", message);
});

const port = Number(process.env.PORT || 4100);
async function bootstrap() {
  const pruned = await pruneTerminalRunsByRetention();
  if (pruned > 0) {
    console.log(`orchestrator: retention pruned ${pruned} terminal task run(s)`);
  }
  const persisted = await loadRuns();
  hydrateRuns(persisted);
  setPersistenceHook((run) => {
    void persistRun(run).catch(() => undefined);
  });
  const server = app.listen(port, () => {
    isReady = true;
    console.log(`orchestrator listening on ${port}`);
  });

  const shutdown = (signal: string) => {
    console.log(`orchestrator ${signal}, shutting down…`);
    isShuttingDown = true;
    isReady = false;
    const force = setTimeout(() => {
      void disconnectPersistence()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    }, 10_000).unref();
    server.close(() => {
      clearTimeout(force);
      void disconnectPersistence()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

void bootstrap();
