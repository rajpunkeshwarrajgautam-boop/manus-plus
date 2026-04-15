import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const versionInfo = {
  service: "realtime",
  version: "0.1.0",
  apiVersion: "v1"
};

let messagesIn = 0;
let messagesOut = 0;

const corsJsonHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-actor-id, x-workspace-id, x-role"
} as const;

const server = createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsJsonHeaders);
    res.end();
    return;
  }
  if (req.url === "/health") {
    res.writeHead(200, corsJsonHeaders);
    res.end(
      JSON.stringify({
        ok: true,
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
    res.writeHead(200, corsJsonHeaders);
    res.end(
      JSON.stringify({
        ok: true,
        checks: [
          { name: "ws_server_initialized", status: "pass" }
        ]
      })
    );
    return;
  }
  res.writeHead(404, corsJsonHeaders);
  res.end(JSON.stringify({ error: "Not found" }));
});
const wss = new WebSocketServer({ server });
const taskRooms = new Map<string, Set<WebSocket>>();
const socketRooms = new Map<WebSocket, Set<string>>();

wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    messagesIn += 1;
    const payload = JSON.parse(String(raw)) as { type: string; taskId?: string; body?: unknown };
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
  console.log(`realtime service listening on ${port}`);
});
