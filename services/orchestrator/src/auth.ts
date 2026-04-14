import type { Request, Response, NextFunction } from "express";

export interface AuthContext {
  actorId: string;
  role: "user" | "admin";
  workspaceId: string;
}

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthContext;
  }
}

export function withAuth(req: Request, res: Response, next: NextFunction) {
  if (req.path === "/health") {
    return next();
  }
  const actorId = String(req.headers["x-actor-id"] || "");
  const workspaceId = String(req.headers["x-workspace-id"] || "");
  const roleHeader = String(req.headers["x-role"] || "user");
  const role: "user" | "admin" = roleHeader === "admin" ? "admin" : "user";

  if (!actorId || !workspaceId) {
    return res.status(401).json({ error: "x-actor-id and x-workspace-id are required" });
  }

  req.auth = { actorId, role, workspaceId };
  next();
}
