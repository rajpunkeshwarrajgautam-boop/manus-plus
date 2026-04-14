/**
 * Thin E2E: POST /tasks (SSE), wait for task_completed, GET /tasks/:id to assert state.
 *
 * Prerequisites: orchestrator running (e.g. npm run dev:apis or smoke:services).
 * Only port 4100 is required for this script.
 *
 * Usage:
 *   npm run e2e:smoke
 * Env:
 *   ORCHESTRATOR_URL (default http://localhost:4100)
 *   E2E_ACTOR_ID, E2E_WORKSPACE_ID (defaults: e2e-actor, e2e-workspace)
 *   E2E_TIMEOUT_MS (default 90000)
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const ORCH = process.env.ORCHESTRATOR_URL || "http://localhost:4100";
const ACTOR = process.env.E2E_ACTOR_ID || "e2e-actor";
const WORKSPACE = process.env.E2E_WORKSPACE_ID || "e2e-workspace";
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 90_000);

const headers = {
  "content-type": "application/json",
  "x-actor-id": ACTOR,
  "x-workspace-id": WORKSPACE,
  "x-role": "user"
};

function pickLib(url) {
  return url.protocol === "https:" ? https : http;
}

/**
 * @param {string} chunk
 * @param {{ taskId: string | null, sawCompleted: boolean, sawFailed: boolean }} acc
 */
function consumeSseChunk(chunk, acc) {
  const lines = chunk.split("\n");
  const eventLine = lines.find((l) => l.startsWith("event: "));
  const dataLine = lines.find((l) => l.startsWith("data: "));
  const eventName = eventLine ? eventLine.slice(7).trim() : "";
  const dataRaw = dataLine ? dataLine.slice(6) : "{}";
  let data = {};
  try {
    data = JSON.parse(dataRaw);
  } catch {
    data = {};
  }
  if (eventName === "task_started" && data.taskId) acc.taskId = String(data.taskId);
  if (eventName === "task_completed") acc.sawCompleted = true;
  if (eventName === "task_failed") acc.sawFailed = true;
}

/**
 * @param {import('node:http').IncomingMessage} res
 */
function readSseStream(res) {
  const acc = { taskId: null, sawCompleted: false, sawFailed: false };
  let buffer = "";
  const start = Date.now();

  return new Promise((resolve, reject) => {
    if (res.statusCode !== 200) {
      let t = "";
      res.on("data", (c) => {
        t += c.toString();
      });
      res.on("end", () => {
        reject(new Error(`POST /tasks failed: ${res.statusCode} ${t.slice(0, 200)}`));
      });
      res.on("error", reject);
      return;
    }

    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      if (Date.now() - start > TIMEOUT_MS) {
        res.destroy();
        reject(new Error(`SSE timed out after ${TIMEOUT_MS}ms (taskId=${acc.taskId})`));
        return;
      }
      buffer += chunk;
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const p of parts) {
        consumeSseChunk(p, acc);
      }
    });
    res.on("end", () => {
      if (buffer.trim()) consumeSseChunk(buffer, acc);
      resolve(acc);
    });
    res.on("error", reject);
  });
}

function requestJson(method, fullUrl, reqHeaders, body) {
  const u = new URL(fullUrl);
  const lib = pickLib(u);
  const payload = body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined;
  const h = { ...reqHeaders };
  if (payload) h["content-length"] = String(Buffer.byteLength(payload));

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: h
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => {
          let json = {};
          try {
            json = JSON.parse(data);
          } catch {
            json = {};
          }
          resolve({ ok: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode || 0, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function postTasksStream(base, bodyObj) {
  const u = new URL("/tasks", base.endsWith("/") ? base : `${base}/`);
  const lib = pickLib(u);
  const body = JSON.stringify(bodyObj);
  const h = { ...headers, "content-length": String(Buffer.byteLength(body)) };

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: h
      },
      (res) => resolve(res)
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const sessionId = `e2e-${randomUUID()}`;
  const prompt =
    process.env.E2E_PROMPT ||
    "E2E smoke: summarize what a minimal task run should validate (quality gate, steps, completion).";

  const base = ORCH.replace(/\/$/, "");
  console.log(`[e2e] POST ${base}/tasks sessionId=${sessionId}`);

  const postRes = await postTasksStream(base, { prompt, sessionId, maxRetries: 5 });
  const { taskId, sawCompleted, sawFailed } = await readSseStream(postRes);

  if (sawFailed && !sawCompleted) {
    console.error("[e2e] SSE contained task_failed");
    process.exit(1);
  }
  if (!sawCompleted) {
    console.error("[e2e] SSE did not emit task_completed", { taskId });
    process.exit(1);
  }
  if (!taskId) {
    console.error("[e2e] No taskId from SSE");
    process.exit(1);
  }

  const verify = await requestJson("GET", `${base}/tasks/${encodeURIComponent(taskId)}`, headers);
  if (!verify.ok) {
    console.error("[e2e] GET /tasks/:id failed", verify.status, verify.json);
    process.exit(1);
  }
  const state = verify.json?.task?.state;
  if (state !== "completed") {
    console.error("[e2e] Expected task.state completed, got:", state);
    process.exit(1);
  }

  console.log(`[e2e] OK taskId=${taskId} state=${state}`);
  process.exit(0);
}

void main().catch((err) => {
  console.error("[e2e]", err instanceof Error ? err.message : err);
  process.exit(1);
});
