/**
 * Polls orchestrator + realtime HTTP /health until both return 200 or timeout.
 * Uses node:http(s) (no fetch) for reliable exit on Windows.
 */
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const ORCH = process.env.ORCHESTRATOR_URL || "http://localhost:4100";
const RT = process.env.REALTIME_HTTP_URL || "http://localhost:4102";
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

async function check(url) {
  return httpGetOk(`${url.replace(/\/$/, "")}/health`);
}

async function main() {
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    try {
      const [okO, okR] = await Promise.all([check(ORCH), check(RT)]);
      if (okO && okR) {
        console.log("[smoke] Orchestrator + Realtime ready");
        console.log(`  ${ORCH}/health`);
        console.log(`  ${RT}/health`);
        process.exit(0);
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  console.error("[smoke] Timeout waiting for services");
  process.exit(1);
}

void main();
