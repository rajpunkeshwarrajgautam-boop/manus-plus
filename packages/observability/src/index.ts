import { randomUUID } from "node:crypto";

export type AccessLogInput = {
  service: string;
  requestId: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  headers?: Record<string, string | string[] | undefined>;
};

const REDACTED = "[REDACTED]";
const SENSITIVE_HEADER_KEYS = new Set(["authorization", "cookie", "set-cookie", "proxy-authorization", "x-api-key"]);
const SENSITIVE_QUERY_KEYS = new Set(["token", "access_token", "refresh_token", "api_key", "apikey", "key", "secret", "password"]);

export function resolveRequestId(headerValue: string | string[] | undefined): string {
  if (typeof headerValue === "string" && headerValue.trim().length > 0) {
    return headerValue;
  }
  if (Array.isArray(headerValue) && headerValue.length > 0) {
    const first = headerValue[0]?.trim();
    if (first) return first;
  }
  return randomUUID();
}

export function logAccess(input: AccessLogInput): void {
  const sanitizedPath = sanitizePath(input.path);
  const redactedHeaders = sanitizeHeaders(input.headers);
  console.log(
    JSON.stringify({
      level: "info",
      service: input.service,
      requestId: input.requestId,
      method: input.method,
      path: sanitizedPath,
      headers: redactedHeaders,
      statusCode: input.statusCode,
      durationMs: input.durationMs
    })
  );
}

function sanitizePath(rawPath: string): string {
  const [pathname, query = ""] = rawPath.split("?");
  if (!query) return pathname;
  const params = new URLSearchParams(query);
  for (const key of params.keys()) {
    if (isSensitiveKey(key)) {
      params.set(key, REDACTED);
    }
  }
  return `${pathname}?${params.toString()}`;
}

function sanitizeHeaders(headers: AccessLogInput["headers"]): Record<string, string> {
  if (!headers) return {};
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();
    if (SENSITIVE_HEADER_KEYS.has(normalizedKey) || isSensitiveKey(normalizedKey)) {
      sanitized[normalizedKey] = REDACTED;
      continue;
    }
    if (typeof value === "string") {
      sanitized[normalizedKey] = value;
      continue;
    }
    if (Array.isArray(value)) {
      sanitized[normalizedKey] = value.join(",");
    }
  }
  return sanitized;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  if (SENSITIVE_QUERY_KEYS.has(normalized)) return true;
  return normalized.includes("token") || normalized.includes("secret") || normalized.includes("password");
}
