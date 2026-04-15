import { createServer } from "node:http";
import { logAccess, resolveRequestId } from "@manus-plus/observability";
import { WebSocket, WebSocketServer } from "ws";

const versionInfo = {
  service: "realtime",
  version: "0.1.0",
  apiVersion: "v1"
};

let messagesIn = 0;
let messagesOut = 0;
let isReady = false;
let isShuttingDown = false;

const corsJsonHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-actor-id, x-workspace-id, x-role"
} as const;

function writeError(res: import("node:http").ServerResponse, statusCode: number, errorCode: string, message: string) {
  res.writeHead(statusCode, corsJsonHeaders);
  res.end(JSON.stringify({ errorCode, error: message }));
}

const server = createServer((req, res) => {
  const requestId = resolveRequestId(req.headers["x-request-id"]);
  const startedAt = Date.now();
  const path = (req.url || "/").split("?")[0];
  res.setHeader("x-request-id", requestId);
  res.on("finish", () => {
    logAccess({
      service: "realtime",
      requestId,
      method: req.method || "GET",
      path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      headers: req.headers
    });
  });
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsJsonHeaders);
    res.end();
    return;
  }
  if (req.url === "/health") {
    const status = isShuttingDown ? "shutting_down" : isReady ? "ready" : "starting";
    res.writeHead(200, corsJsonHeaders);
    res.end(
      JSON.stringify({
        ok: true,
        status,
        service: "realtime",
        uptimeSec: Math.round(process.uptime()),
        activeRooms: taskRooms.size,
        activeSockets: socketRooms.size,
        messagesIn,
        messagesOut
      })
    );
    return;
  }
  if (req.url === "/version") {
    res.writeHead(200, corsJsonHeaders);
    res.end(JSON.stringify(versionInfo));
    return;
  }
  if (req.url === "/readiness") {
    const checks = [
      { name: "lifecycle", status: isReady && !isShuttingDown ? "pass" : "fail", details: isShuttingDown ? "shutting_down" : isReady ? "ready" : "starting" },
      { name: "ws_server_initialized", status: "pass" }
    ];
    const ok = checks.every((check) => check.status === "pass");
    res.writeHead(ok ? 200 : 503, corsJsonHeaders);
    res.end(
      JSON.stringify({
        ok,
        checks
      })
    );
    return;
  }
  writeError(res, 404, "not_found", "Not found");
});
const wss = new WebSocketServer({ server });
const taskRooms = new Map<string, Set<WebSocket>>();
const socketRooms = new Map<WebSocket, Set<string>>();

wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    messagesIn += 1;
    let payload: { type: string; taskId?: string; body?: unknown };
    try {
      payload = JSON.parse(String(raw)) as { type: string; taskId?: string; body?: unknown };
    } catch {
      socket.send(JSON.stringify({ type: "error", errorCode: "invalid_json", error: "Invalid JSON payload" }));
      messagesOut += 1;
      return;
    }
    if (payload.type === "join_task" && payload.taskId) {
      const room = taskRooms.get(payload.taskId) ?? new Set<WebSocket>();
      room.add(socket as WebSocket);
      taskRooms.set(payload.taskId, room);
      const memberships = socketRooms.get(socket as WebSocket) ?? new Set<string>();
      memberships.add(payload.taskId);
      socketRooms.set(socket as WebSocket, memberships);
      socket.send(JSON.stringify({ type: "joined", taskId: payload.taskId }));
      messagesOut += 1;
    }
    if (payload.type === "task_event" && payload.taskId) {
      const room = taskRooms.get(payload.taskId) ?? new Set<WebSocket>();
      room.forEach((member) => {
        member.send(JSON.stringify(payload));
        messagesOut += 1;
      });
    }
  });

  socket.on("close", () => {
    const memberships = socketRooms.get(socket as WebSocket) ?? new Set<string>();
    for (const taskId of memberships) {
      const room = taskRooms.get(taskId);
      if (!room) continue;
      room.delete(socket as WebSocket);
      if (room.size === 0) {
        taskRooms.delete(taskId);
      }
    }
    socketRooms.delete(socket as WebSocket);
  });
});

const port = Number(process.env.PORT || 4102);
server.listen(port, () => {
  isReady = true;
  console.log(`realtime service listening on ${port}`);
});

const shutdown = (signal: string) => {
  console.log(`realtime ${signal}, shutting down…`);
  isShuttingDown = true;
  isReady = false;
  const force = setTimeout(() => process.exit(0), 10_000).unref();
  wss.close((err) => {
    clearTimeout(force);
    if (err) console.error(err);
    process.exit(0);
  });
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
