import type { TaskRun } from "./state-machine";

export function scoreReliability(run: TaskRun): number {
  const total = run.steps.length || 1;
  const failures = run.steps.filter((s) => s.type === "error").length;
  const retriesPenalty = run.retryCount * 5;
  const raw = 100 - (failures / total) * 60 - retriesPenalty;
  return Math.max(0, Math.min(100, Number(raw.toFixed(2))));
}
