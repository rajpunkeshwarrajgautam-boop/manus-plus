import { randomUUID } from "node:crypto";

export type TaskState = "queued" | "running" | "waiting_user" | "completed" | "failed" | "cancelled";
export type TaskPhase = "plan" | "execute" | "verify" | "finalize";

export interface TaskStep {
  id: string;
  phase: TaskPhase;
  type: "thinking" | "tool_call" | "tool_result" | "checkpoint" | "response" | "error";
  content: string;
  createdAt: string;
}

export interface TaskRun {
  id: string;
  sessionId: string;
  workspaceId: string;
  actorId: string;
  idempotencyKey?: string;
  prompt: string;
  state: TaskState;
  phase: TaskPhase;
  retryCount: number;
  maxRetries: number;
  checkpoints: string[];
  steps: TaskStep[];
  artifacts: Array<{ id: string; kind: string; title: string; content?: string }>;
}

export const runs = new Map<string, TaskRun>();
let persistenceHook: ((run: TaskRun) => void | Promise<void>) | null = null;

export function setPersistenceHook(hook: ((run: TaskRun) => void | Promise<void>) | null) {
  persistenceHook = hook;
}

function notifyPersistence(run: TaskRun) {
  try {
    const r = persistenceHook?.(run);
    if (r && typeof (r as Promise<unknown>).then === "function") {
      void (r as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    // ignore hook failures
  }
}

export function hydrateRuns(initialRuns: TaskRun[]) {
  for (const run of initialRuns) {
    runs.set(run.id, run);
  }
}

export function createRun(prompt: string, sessionId: string, workspaceId: string, actorId: string, idempotencyKey?: string): TaskRun {
  const run: TaskRun = {
    id: randomUUID(),
    sessionId,
    workspaceId,
    actorId,
    idempotencyKey,
    prompt,
    state: "queued",
    phase: "plan",
    retryCount: 0,
    maxRetries: 3,
    checkpoints: [],
    steps: [],
    artifacts: []
  };
  runs.set(run.id, run);
  notifyPersistence(run);
  return run;
}

export function findRunByIdempotency(workspaceId: string, idempotencyKey: string): TaskRun | undefined {
  for (const run of runs.values()) {
    if (run.workspaceId === workspaceId && run.idempotencyKey === idempotencyKey) {
      return run;
    }
  }
  return undefined;
}

export function appendStep(run: TaskRun, step: Omit<TaskStep, "id" | "createdAt">): TaskStep {
  const created: TaskStep = { ...step, id: randomUUID(), createdAt: new Date().toISOString() };
  run.steps.push(created);
  notifyPersistence(run);
  return created;
}

export function checkpoint(run: TaskRun, name: string) {
  run.checkpoints.push(name);
  appendStep(run, { phase: run.phase, type: "checkpoint", content: `Checkpoint: ${name}` });
}
