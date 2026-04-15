import type { Request, Response, NextFunction } from "express";

declare module "express-serve-static-core" {
  interface Request {
    auth?: { actorId: string; workspaceId: string; role: "user" | "admin" };
  }
}

export function withAuth(req: Request, res: Response, next: NextFunction) {
  if (req.path === "/health") {
    return next();
  }
  const actorId = String(req.headers["x-actor-id"] || "");
  const workspaceId = String(req.headers["x-workspace-id"] || "");
  const role = String(req.headers["x-role"] || "user") === "admin" ? "admin" : "user";

  if (!actorId || !workspaceId) {
    return res.status(401).json({
      errorCode: "auth_headers_required",
      error: "x-actor-id and x-workspace-id are required"
    });
  }
  req.auth = { actorId, workspaceId, role };
  next();
}
