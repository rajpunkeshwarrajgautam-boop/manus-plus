/**
 * Probes /health on core services. Uses node:http(s) instead of fetch for reliable exit on Windows.
 * Validates JSON shape for API services: lifecycle status + reliability counters.
 */
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const ORCH = process.env.ORCHESTRATOR_URL || "http://localhost:4100";
const BROWSER = process.env.BROWSER_OPERATOR_URL || "http://localhost:4101";
const RT = process.env.REALTIME_HTTP_URL || "http://localhost:4102";
const SKILLS = process.env.SKILLS_REGISTRY_URL || "http://localhost:4103";
const WEB = process.env.WEB_URL || "http://localhost:3000";

const targets = [
  ["orchestrator", ORCH],
  ["browser-operator", BROWSER],
  ["realtime", RT],
  ["skills-registry", SKILLS]
];

const LIFECYCLE_STATUSES = new Set(["starting", "ready", "shutting_down"]);

function pickLib(url) {
  return url.protocol === "https:" ? https : http;
}

/**
 * @param {string} fullUrl
 * @param {{ timeoutMs?: number, maxBody?: number }} opts
 */
function httpGet(fullUrl, opts = {}) {
  const { timeoutMs = 8000, maxBody = 4096 } = opts;
  const u = new URL(fullUrl);
  const lib = pickLib(u);

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        timeout: timeoutMs
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (data.length >= maxBody) return;
          const s = chunk.toString();
          data += s.slice(0, maxBody - data.length);
        });
        res.on("end", () => {
          const status = res.statusCode || 0;
          const ok = status >= 200 && status < 300;
          resolve({ ok, status, body: data });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

/**
 * @param {string} name
 * @param {unknown} j
 */
function assertApiHealthContract(name, j) {
  if (!j || typeof j !== "object") {
    throw new Error(`${name}: /health body is not a JSON object`);
  }
  const o = /** @type {Record<string, unknown>} */ (j);
  if (o.ok !== true) {
    throw new Error(`${name}: expected ok: true`);
  }
  if (typeof o.status !== "string" || !LIFECYCLE_STATUSES.has(o.status)) {
    throw new Error(`${name}: expected status in [starting, ready, shutting_down], got: ${String(o.status)}`);
  }
  if (typeof o.errorResponsesTotal !== "number" || !Number.isFinite(o.errorResponsesTotal)) {
    const hint =
      !("errorResponsesTotal" in o) ? " (restart API processes after upgrading so /health includes reliability fields)" : "";
    throw new Error(`${name}: expected numeric errorResponsesTotal${hint}`);
  }
  if (typeof o.readinessFailuresTotal !== "number" || !Number.isFinite(o.readinessFailuresTotal)) {
    throw new Error(`${name}: expected numeric readinessFailuresTotal`);
  }
  if (typeof o.reliabilityMetricsResetAt !== "string" || !o.reliabilityMetricsResetAt) {
    throw new Error(`${name}: expected string reliabilityMetricsResetAt`);
  }
}

async function checkApiService(name, base) {
  const url = `${base.replace(/\/$/, "")}/health`;
  try {
    const { ok, status, body } = await httpGet(url);
    if (!ok) {
      return { name, ok: false, status, snippet: body.slice(0, 120), contractError: null };
    }
    let j;
    try {
      j = JSON.parse(body);
    } catch (e) {
      return { name, ok: false, status, snippet: body.slice(0, 120), contractError: `invalid JSON: ${e}` };
    }
    try {
      assertApiHealthContract(name, j);
    } catch (e) {
      return {
        name,
        ok: false,
        status,
        snippet: body.slice(0, 120),
        contractError: e instanceof Error ? e.message : String(e)
      };
    }
    return { name, ok: true, status, snippet: body.slice(0, 120), contractError: null, json: j };
  } catch (e) {
    return { name, ok: false, status: 0, snippet: String(e), contractError: null };
  }
}

async function main() {
  const results = [];
  for (const [name, base] of targets) {
    results.push(await checkApiService(name, base));
  }

  const expectPostgresOrchestrator = Boolean(process.env.DATABASE_URL?.trim());
  if (expectPostgresOrchestrator) {
    const orch = results.find((r) => r.name === "orchestrator");
    if (!orch?.ok) {
      console.error("✗ orchestrator health failed; cannot assert persistence=postgres");
      process.exit(1);
    }
    const j = orch.json;
    if (j && typeof j === "object" && "persistence" in j) {
      if (/** @type {{ persistence?: string }} */ (j).persistence !== "postgres") {
        console.error(
          `✗ orchestrator /health: expected persistence "postgres" when DATABASE_URL is set, got:`,
          /** @type {{ persistence?: string }} */ (j).persistence
        );
        process.exit(1);
      }
      console.log(`✓ orchestrator persistence=postgres (DATABASE_URL set)`);
    } else {
      console.error("✗ orchestrator /health: missing persistence field");
      process.exit(1);
    }
  }

  let webOk = false;
  try {
    const w = await httpGet(WEB, { maxBody: 200 });
    webOk = w.ok;
  } catch {
    webOk = false;
  }

  for (const r of results) {
    const contract = r.contractError ? ` CONTRACT: ${r.contractError}` : "";
    console.log(`${r.ok ? "✓" : "✗"} ${r.name} (${r.status}) ${r.snippet}${contract}`);
  }
  console.log(`${webOk ? "✓" : "○"} web (${WEB}) ${webOk ? "responding" : "skipped or down"}`);
  const allCore = results.every((r) => r.ok);
  process.exit(allCore ? 0 : 1);
}

void main();
