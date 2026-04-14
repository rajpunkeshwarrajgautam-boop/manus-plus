import { randomUUID } from "node:crypto";

export interface AuditEvent {
  id: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  createdAt: string;
}

export const auditTrail: AuditEvent[] = [];

export function recordAudit(event: Omit<AuditEvent, "id" | "createdAt">) {
  auditTrail.push({
    ...event,
    id: randomUUID(),
    createdAt: new Date().toISOString()
  });
}
