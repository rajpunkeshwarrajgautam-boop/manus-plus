/**
 * Polls orchestrator, browser-operator, realtime, and skills-registry /health until all return 200 or timeout.
 * Uses node:http(s) (no fetch) for reliable exit on Windows CI and dev machines.
 */
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const ORCH = process.env.ORCHESTRATOR_URL || "http://localhost:4100";
const BROWSER = process.env.BROWSER_OPERATOR_URL || "http://localhost:4101";
const RT = process.env.REALTIME_HTTP_URL || "http://localhost:4102";
const SKILLS = process.env.SKILLS_REGISTRY_URL || "http://localhost:4103";
const TIMEOUT_MS = Number(process.env.SMOKE_WAIT_TIMEOUT_MS || 120000);
const INTERVAL_MS = 500;

function pickLib(url) {
  return url.protocol === "https:" ? https : http;
}

function httpGetOk(fullUrl) {
  const u = new URL(fullUrl);
  const lib = pickLib(u);
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        timeout: 3000
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300;
          resolve(ok);
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

async function check(base) {
  return httpGetOk(`${base.replace(/\/$/, "")}/health`);
}

async function main() {
  const bases = [
    ["orchestrator", ORCH],
    ["browser-operator", BROWSER],
    ["realtime", RT],
    ["skills-registry", SKILLS]
  ];
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    try {
      const results = await Promise.all(bases.map(([, url]) => check(url)));
      if (results.every(Boolean)) {
        console.log("[smoke] All API services ready");
        for (const [name, url] of bases) {
          console.log(`  ${url}/health (${name})`);
        }
        process.exit(0);
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  console.error("[smoke] Timeout waiting for API services");
  process.exit(1);
}

void main();
