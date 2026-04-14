export interface RoutingDecision {
  provider: "openai" | "anthropic" | "groq";
  model: string;
  reason: string;
}

export function routeModel(prompt: string): RoutingDecision {
  if (prompt.length > 1500) {
    return { provider: "anthropic", model: "claude-sonnet", reason: "Long-context task" };
  }
  if (/code|refactor|typescript|python/i.test(prompt)) {
    return { provider: "openai", model: "gpt-4.1", reason: "Code-specialized task" };
  }
  return { provider: "groq", model: "llama-3.3-70b", reason: "Low-latency default routing" };
}
