/**
 * Polls the web app root until HTTP 2xx (Next.js dev or prod). Uses node:http(s) like wait-apis.mjs.
 */
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const WEB = process.env.WEB_URL || "http://localhost:3000";
const TIMEOUT_MS = Number(process.env.SMOKE_WAIT_TIMEOUT_MS || 120000);
const INTERVAL_MS = 500;

function pickLib(url) {
  return url.protocol === "https:" ? https : http;
}

function httpGetRoot(fullUrl) {
  const u = new URL(fullUrl.endsWith("/") ? fullUrl : `${fullUrl}/`);
  const lib = pickLib(u);
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname || "/",
        method: "GET",
        timeout: 5000,
        headers: { Accept: "text/html,*/*" }
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          const code = res.statusCode || 0;
          const ok = code >= 200 && code < 400;
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

async function main() {
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    try {
      if (await httpGetRoot(WEB)) {
        console.log(`[smoke] Web app ready at ${WEB}`);
        process.exit(0);
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  console.error(`[smoke] Timeout waiting for web at ${WEB}`);
  process.exit(1);
}

void main();
