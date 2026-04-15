#!/usr/bin/env node
/**
 * Cross-platform local preflight: free common dev ports, then run `npm run verify:ops`.
 *
 * Windows: uses PowerShell Get-NetTCPConnection (same behavior as the legacy .ps1 helper).
 * macOS/Linux: uses `lsof` + `kill` when available.
 *
 * Usage:
 *   node scripts/preflight-local.mjs
 *   node scripts/preflight-local.mjs --skip-verify-ops   # port cleanup only
 */
import { execSync, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ports = [3000, 4100, 4101, 4102, 4103];

function log(msg) {
  console.log(`[preflight] ${msg}`);
}

function clearPortWindows(port) {
  const cmd =
    "Get-NetTCPConnection " +
    `-LocalPort ${port} -State Listen -ErrorAction SilentlyContinue ` +
    "| ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }";
  try {
    spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd], {
      stdio: "inherit"
    });
  } catch {
    // ignore
  }
}

function clearPortUnix(port) {
  try {
    const out = execSync(`lsof -ti :${port}`, { encoding: "utf8" });
    const pids = out
      .split(/\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const pid of pids) {
      try {
        execSync(`kill -9 ${pid}`);
        log(`Stopped PID ${pid} on port ${port}`);
      } catch {
        // ignore
      }
    }
  } catch {
    // no listeners or lsof missing
  }
}

function clearPorts() {
  log(`Clearing listeners on ports: ${ports.join(", ")}`);
  if (process.platform === "win32") {
    for (const port of ports) {
      clearPortWindows(port);
    }
    return;
  }
  try {
    execSync("command -v lsof", { stdio: "ignore", shell: true });
  } catch {
    log("warning: `lsof` not found; skipping automatic port cleanup on this OS");
    return;
  }
  for (const port of ports) {
    clearPortUnix(port);
  }
}

const skipVerify = process.argv.includes("--skip-verify-ops");

clearPorts();

if (skipVerify) {
  log("Port cleanup completed; skipping verify:ops");
  process.exit(0);
}

log("Running npm run verify:ops");
const result = spawnSync("npm", ["run", "verify:ops"], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: true,
  env: process.env
});

const code = result.status ?? 1;
if (code === 0) {
  log("verify:ops PASSED");
} else {
  console.error(`[preflight] verify:ops FAILED (exit code: ${code})`);
}

process.exit(code);
