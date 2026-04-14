import { z } from "zod";

export const eventSchemas = {
  task_started: z.object({
    taskId: z.string(),
    state: z.string()
  }),
  task_reused: z.object({
    taskId: z.string(),
    state: z.string()
  }),
  step_created: z.object({
    id: z.string(),
    taskId: z.string(),
    phase: z.string(),
    type: z.string(),
    content: z.string(),
    createdAt: z.string()
  }),
  artifact_created: z.object({
    id: z.string(),
    kind: z.string(),
    title: z.string(),
    content: z.string().optional()
  }),
  task_retrying: z.object({
    taskId: z.string(),
    retryCount: z.number(),
    reason: z.string().optional()
  }),
  quality_gate: z.object({
    taskId: z.string(),
    attempt: z.number(),
    score: z.number(),
    passed: z.boolean(),
    reason: z.string()
  }),
  task_completed: z.object({
    taskId: z.string(),
    state: z.string(),
    reliability: z.number()
  }),
  task_failed: z.object({
    taskId: z.string(),
    state: z.string(),
    reason: z.string().optional()
  })
} as const;

export type OrchestratorEventName = keyof typeof eventSchemas;
