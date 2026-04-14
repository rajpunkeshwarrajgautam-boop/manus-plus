export async function createTask(orchestratorUrl: string, payload: { prompt: string; sessionId: string }) {
  const response = await fetch(`${orchestratorUrl}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`Task creation failed with status ${response.status}`);
  }
  return response;
}
