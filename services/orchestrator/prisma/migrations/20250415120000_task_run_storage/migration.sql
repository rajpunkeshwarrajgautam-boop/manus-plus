-- CreateTable
CREATE TABLE "TaskRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "prompt" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "checkpoints" JSONB NOT NULL,
    "steps" JSONB NOT NULL,
    "artifacts" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TaskRun_workspaceId_idx" ON "TaskRun"("workspaceId");

CREATE UNIQUE INDEX "TaskRun_workspaceId_idempotencyKey_key" ON "TaskRun"("workspaceId", "idempotencyKey");
