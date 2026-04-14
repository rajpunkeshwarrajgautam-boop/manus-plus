export type TaskState = "queued" | "running" | "waiting_user" | "completed" | "failed" | "cancelled";
export type ExecutionPhase = "plan" | "execute" | "verify" | "finalize";

export interface TaskStepEvent {
  id: string;
  taskId: string;
  phase: ExecutionPhase;
  type: "thinking" | "tool_call" | "tool_result" | "checkpoint" | "response" | "error";
  content: string;
  createdAt: string;
}

export interface ArtifactRecord {
  id: string;
  taskId: string;
  kind: "file" | "report" | "image" | "chart";
  title: string;
  content?: string;
}
