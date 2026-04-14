import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const storePath = process.env.BROWSER_STORE_PATH || join(process.cwd(), ".data", "browser-sessions.json");

export async function loadStore<T>(): Promise<T[]> {
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as T[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveStore<T>(items: T[]) {
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(items, null, 2), "utf8");
}
