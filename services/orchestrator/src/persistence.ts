import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Prisma } from "@prisma/client";
import { PrismaClient } from "@prisma/client";
import type { TaskRun, TaskStep } from "./state-machine";
import { runs } from "./state-machine";

const storagePath = process.env.ORCHESTRATOR_STORE_PATH || join(process.cwd(), ".data", "runs.json");
const usePostgres = Boolean(process.env.DATABASE_URL?.trim());

/** Terminal runs safe to drop after retention window (never delete active work). */
const TERMINAL_RUN_STATES = ["completed", "failed", "cancelled"] as const;

let prisma: PrismaClient | null = null;

function getClient(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}

export function persistenceBackend(): "postgres" | "file" {
  return usePostgres ? "postgres" : "file";
}

function rowToRun(row: {
  id: string;
  workspaceId: string;
  actorId: string;
  sessionId: string;
  idempotencyKey: string | null;
  prompt: string;
  state: string;
  phase: string;
  retryCount: number;
  maxRetries: number;
  checkpoints: unknown;
  steps: unknown;
  artifacts: unknown;
}): TaskRun {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    actorId: row.actorId,
    sessionId: row.sessionId,
    idempotencyKey: row.idempotencyKey ?? undefined,
    prompt: row.prompt,
    state: row.state as TaskRun["state"],
    phase: row.phase as TaskRun["phase"],
    retryCount: row.retryCount,
    maxRetries: row.maxRetries,
    checkpoints: row.checkpoints as string[],
    steps: row.steps as TaskStep[],
    artifacts: row.artifacts as TaskRun["artifacts"]
  };
}

function toCreateInput(run: TaskRun): Prisma.OrchestratorTaskRunCreateInput {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    actorId: run.actorId,
    sessionId: run.sessionId,
    idempotencyKey: run.idempotencyKey ?? null,
    prompt: run.prompt,
    state: run.state,
    phase: run.phase,
    retryCount: run.retryCount,
    maxRetries: run.maxRetries,
    checkpoints: run.checkpoints as unknown as Prisma.InputJsonValue,
    steps: run.steps as unknown as Prisma.InputJsonValue,
    artifacts: run.artifacts as unknown as Prisma.InputJsonValue
  };
}

export async function persistRun(run: TaskRun): Promise<void> {
  if (usePostgres) {
    const create = toCreateInput(run);
    await getClient().orchestratorTaskRun.upsert({
      where: { id: run.id },
      create,
      update: {
        workspaceId: create.workspaceId,
        actorId: create.actorId,
        sessionId: create.sessionId,
        idempotencyKey: create.idempotencyKey,
        prompt: create.prompt,
        state: create.state,
        phase: create.phase,
        retryCount: create.retryCount,
        maxRetries: create.maxRetries,
        checkpoints: create.checkpoints,
        steps: create.steps,
        artifacts: create.artifacts
      }
    });
    return;
  }
  await mkdir(dirname(storagePath), { recursive: true });
  await writeFile(storagePath, JSON.stringify([...runs.values()], null, 2), "utf8");
}

/**
 * When `ORCHESTRATOR_RETENTION_DAYS` is a positive integer and Postgres is enabled,
 * deletes terminal runs older than that many days so the table and hydrate cap stay bounded.
 */
export async function pruneTerminalRunsByRetention(): Promise<number> {
  if (!usePostgres) return 0;
  const raw = process.env.ORCHESTRATOR_RETENTION_DAYS?.trim();
  if (!raw) return 0;
  const days = Number.parseInt(raw, 10);
  if (!Number.isFinite(days) || days <= 0) return 0;

  const cutoff = new Date(Date.now() - days * 86_400_000);
  const result = await getClient().orchestratorTaskRun.deleteMany({
    where: {
      state: { in: [...TERMINAL_RUN_STATES] },
      updatedAt: { lt: cutoff }
    }
  });
  return result.count;
}

export async function loadRuns(): Promise<TaskRun[]> {
  if (usePostgres) {
    const rows = await getClient().orchestratorTaskRun.findMany({
      orderBy: { updatedAt: "desc" },
      take: 10_000
    });
    return rows.map(rowToRun);
  }
  try {
    const raw = await readFile(storagePath, "utf8");
    const parsed = JSON.parse(raw) as TaskRun[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function findRunByIdempotencyStored(workspaceId: string, idempotencyKey: string): Promise<TaskRun | null> {
  if (!usePostgres) return null;
  const row = await getClient().orchestratorTaskRun.findFirst({
    where: { workspaceId, idempotencyKey }
  });
  return row ? rowToRun(row) : null;
}

export async function pingPostgres(): Promise<{ ok: boolean; detail?: string }> {
  if (!usePostgres) return { ok: true };
  try {
    await getClient().$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Close the Prisma pool (call on SIGTERM/SIGINT so Docker/K8s restarts do not leak connections). */
export async function disconnectPersistence(): Promise<void> {
  if (!prisma) return;
  const client = prisma;
  prisma = null;
  await client.$disconnect();
}
