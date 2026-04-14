const PREFIX = "manus-plus.identity.";

export const identityKeys = {
  actorId: `${PREFIX}actorId`,
  workspaceId: `${PREFIX}workspaceId`,
  role: `${PREFIX}role`,
  sessionId: `${PREFIX}sessionId`,
  idempotencySeed: `${PREFIX}idempotencySeed`
} as const;

export function loadIdentityFromStorage(): {
  actorId: string | null;
  workspaceId: string | null;
  role: "user" | "admin" | null;
  sessionId: string | null;
  idempotencySeed: string | null;
} {
  if (typeof window === "undefined") {
    return { actorId: null, workspaceId: null, role: null, sessionId: null, idempotencySeed: null };
  }
  const roleRaw = window.localStorage.getItem(identityKeys.role);
  const role = roleRaw === "user" || roleRaw === "admin" ? roleRaw : null;
  return {
    actorId: window.localStorage.getItem(identityKeys.actorId),
    workspaceId: window.localStorage.getItem(identityKeys.workspaceId),
    role,
    sessionId: window.localStorage.getItem(identityKeys.sessionId),
    idempotencySeed: window.localStorage.getItem(identityKeys.idempotencySeed)
  };
}

export function saveIdentityToStorage(values: {
  actorId: string;
  workspaceId: string;
  role: "user" | "admin";
  sessionId: string;
  idempotencySeed: string;
}): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(identityKeys.actorId, values.actorId);
  window.localStorage.setItem(identityKeys.workspaceId, values.workspaceId);
  window.localStorage.setItem(identityKeys.role, values.role);
  window.localStorage.setItem(identityKeys.sessionId, values.sessionId);
  window.localStorage.setItem(identityKeys.idempotencySeed, values.idempotencySeed);
}

export function clearIdentityStorage(): void {
  if (typeof window === "undefined") return;
  Object.values(identityKeys).forEach((k) => window.localStorage.removeItem(k));
}
