/**
 * Runtime smoke checks for stable backend errorCode responses.
 * Assumes services are already running (e.g. via dev:apis / CI integration).
 */
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const ORCH = process.env.ORCHESTRATOR_URL || "http://localhost:4100";
const BROWSER = process.env.BROWSER_OPERATOR_URL || "http://localhost:4101";
const RT = process.env.REALTIME_HTTP_URL || "http://localhost:4102";
const SKILLS = process.env.SKILLS_REGISTRY_URL || "http://localhost:4103";
const ACTOR = process.env.E2E_ACTOR_ID || "e2e-actor";
const WORKSPACE = process.env.E2E_WORKSPACE_ID || "e2e-workspace";

const authHeaders = {
  "x-actor-id": ACTOR,
  "x-workspace-id": WORKSPACE,
  "x-role": "user"
};

function pickLib(url) {
  return url.protocol === "https:" ? https : http;
}

function requestJson(method, fullUrl, headers = {}) {
  const u = new URL(fullUrl);
  const lib = pickLib(u);
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let json = {};
          try {
            json = JSON.parse(data);
          } catch {
            json = {};
          }
          resolve({ status: res.statusCode || 0, json });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function assertCase(name, method, url, expectedStatus, expectedErrorCode, headers = {}) {
  const res = await requestJson(method, url, headers);
  const actualCode = res.json?.errorCode;
  const pass = res.status === expectedStatus && actualCode === expectedErrorCode;
  if (!pass) {
    console.error(`[error-smoke] FAIL ${name}`);
    console.error(`  expected: status=${expectedStatus} errorCode=${expectedErrorCode}`);
    console.error(`  actual:   status=${res.status} errorCode=${String(actualCode)}`);
    console.error(`  body: ${JSON.stringify(res.json)}`);
    process.exit(1);
  }
  console.log(`[error-smoke] OK ${name} -> ${expectedStatus}/${expectedErrorCode}`);
}

async function main() {
  await assertCase(
    "orchestrator missing auth",
    "GET",
    `${ORCH.replace(/\/$/, "")}/tasks/smoke-missing-auth`,
    401,
    "auth_headers_required"
  );
  await assertCase(
    "orchestrator task not found",
    "GET",
    `${ORCH.replace(/\/$/, "")}/tasks/smoke-not-found`,
    404,
    "task_not_found",
    authHeaders
  );
  await assertCase(
    "browser-operator missing auth",
    "GET",
    `${BROWSER.replace(/\/$/, "")}/sessions/smoke-missing-auth`,
    401,
    "auth_headers_required"
  );
  await assertCase(
    "browser-operator session not found",
    "GET",
    `${BROWSER.replace(/\/$/, "")}/sessions/smoke-not-found`,
    404,
    "session_not_found",
    authHeaders
  );
  await assertCase(
    "skills-registry missing workspaceId",
    "GET",
    `${SKILLS.replace(/\/$/, "")}/skills`,
    400,
    "workspace_id_required"
  );
  await assertCase(
    "realtime not found",
    "GET",
    `${RT.replace(/\/$/, "")}/definitely-not-found`,
    404,
    "not_found"
  );
}

void main().catch((error) => {
  console.error("[error-smoke] unexpected failure:", error instanceof Error ? error.message : error);
  process.exit(1);
});
