import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TaskRun } from "./state-machine";

const storagePath = process.env.ORCHESTRATOR_STORE_PATH || join(process.cwd(), ".data", "runs.json");

export async function loadRuns(): Promise<TaskRun[]> {
  try {
    const raw = await readFile(storagePath, "utf8");
    const parsed = JSON.parse(raw) as TaskRun[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveRuns(runs: TaskRun[]) {
  await mkdir(dirname(storagePath), { recursive: true });
  await writeFile(storagePath, JSON.stringify(runs, null, 2), "utf8");
}
