/**
 * Probes /health on core services. Uses node:http(s) instead of fetch for reliable exit on Windows.
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

function pickLib(url) {
  return url.protocol === "https:" ? https : http;
}

/**
 * @param {string} fullUrl
 * @param {{ timeoutMs?: number, maxBody?: number }} opts
 */
function httpGet(fullUrl, opts = {}) {
  const { timeoutMs = 8000, maxBody = 400 } = opts;
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

async function ping(name, base) {
  const url = `${base.replace(/\/$/, "")}/health`;
  try {
    const { ok, status, body } = await httpGet(url);
    return { name, ok, status, snippet: body.slice(0, 120) };
  } catch (e) {
    return { name, ok: false, status: 0, snippet: String(e) };
  }
}

async function main() {
  const results = [];
  for (const [name, base] of targets) {
    results.push(await ping(name, base));
  }

  const expectPostgresOrchestrator = Boolean(process.env.DATABASE_URL?.trim());
  if (expectPostgresOrchestrator) {
    const orch = results.find((r) => r.name === "orchestrator");
    if (!orch?.ok) {
      console.error("✗ orchestrator health failed; cannot assert persistence=postgres");
      process.exit(1);
    }
    try {
      const full = await httpGet(`${ORCH.replace(/\/$/, "")}/health`, { maxBody: 2048 });
      const j = JSON.parse(full.body);
      if (j.persistence !== "postgres") {
        console.error(
          `✗ orchestrator /health: expected persistence "postgres" when DATABASE_URL is set, got:`,
          j.persistence
        );
        process.exit(1);
      }
      console.log(`✓ orchestrator persistence=postgres (DATABASE_URL set)`);
    } catch (e) {
      console.error("✗ orchestrator /health JSON check failed:", e);
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
    console.log(`${r.ok ? "✓" : "✗"} ${r.name} (${r.status}) ${r.snippet}`);
  }
  console.log(`${webOk ? "✓" : "○"} web (${WEB}) ${webOk ? "responding" : "skipped or down"}`);
  const allCore = results.every((r) => r.ok);
  process.exit(allCore ? 0 : 1);
}

void main();
