import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { loadStore, saveStore } from "./persistence";

interface SkillVersion {
  id: string;
  version: number;
  instructions: string;
  createdAt: string;
}

interface Skill {
  id: string;
  workspaceId: string;
  actorId: string;
  slug: string;
  title: string;
  versions: SkillVersion[];
}

const app = express();
app.use(express.json());
const skills = new Map<string, Skill>();

const createSkillSchema = z.object({
  workspaceId: z.string().min(1),
  actorId: z.string().min(1),
  slug: z.string().min(2),
  title: z.string().min(2),
  instructions: z.string().min(10)
});
const versionInfo = {
  service: "skills-registry",
  version: "0.1.0",
  apiVersion: "v1"
};

app.post("/skills", (req, res) => {
  const parsed = createSkillSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });

  const existing = [...skills.values()].find((s) => s.workspaceId === parsed.data.workspaceId && s.slug === parsed.data.slug);
  if (existing) return res.status(409).json({ error: "Skill slug already exists in workspace" });

  const skill: Skill = {
    id: randomUUID(),
    workspaceId: parsed.data.workspaceId,
    actorId: parsed.data.actorId,
    slug: parsed.data.slug,
    title: parsed.data.title,
    versions: [{
      id: randomUUID(),
      version: 1,
      instructions: parsed.data.instructions,
      createdAt: new Date().toISOString()
    }]
  };
  skills.set(skill.id, skill);
  saveStore([...skills.values()]).catch(() => undefined);
  res.status(201).json(skill);
});

app.post("/skills/:id/versions", (req, res) => {
  const skill = skills.get(req.params.id);
  if (!skill) return res.status(404).json({ error: "Skill not found" });
  const workspaceId = z.string().min(1).safeParse(req.body?.workspaceId);
  if (!workspaceId.success || workspaceId.data !== skill.workspaceId) {
    return res.status(403).json({ error: "Cross-workspace access denied" });
  }

  const instructions = z.string().min(10).safeParse(req.body?.instructions);
  if (!instructions.success) return res.status(400).json({ error: "instructions required" });

  const version: SkillVersion = {
    id: randomUUID(),
    version: skill.versions[skill.versions.length - 1].version + 1,
    instructions: instructions.data,
    createdAt: new Date().toISOString()
  };
  skill.versions.push(version);
  saveStore([...skills.values()]).catch(() => undefined);
  res.status(201).json(version);
});

app.post("/skills/:id/invoke", (req, res) => {
  const skill = skills.get(req.params.id);
  if (!skill) return res.status(404).json({ error: "Skill not found" });
  const workspaceId = z.string().min(1).safeParse(req.body?.workspaceId);
  if (!workspaceId.success || workspaceId.data !== skill.workspaceId) {
    return res.status(403).json({ error: "Cross-workspace access denied" });
  }

  const current = skill.versions[skill.versions.length - 1];
  res.json({
    taskTemplate: {
      title: skill.title,
      prompt: `Run skill ${skill.slug} with payload: ${JSON.stringify(req.body?.payload ?? {})}`
    },
    instructions: current.instructions
  });
});

app.get("/skills", (_req, res) => {
  const workspaceId = String(_req.query.workspaceId || "");
  if (!workspaceId) {
    return res.status(400).json({ error: "workspaceId query param is required" });
  }
  res.json({ skills: [...skills.values()].filter((s) => s.workspaceId === workspaceId) });
});

app.get("/health", (_req, res) => {
  return res.json({
    ok: true,
    service: "skills-registry",
    uptimeSec: Math.round(process.uptime()),
    skillCount: skills.size
  });
});

app.get("/version", (_req, res) => {
  return res.json(versionInfo);
});

app.get("/readiness", (_req, res) => {
  return res.json({
    ok: true,
    checks: [
      { name: "skills_store_loaded", status: "pass", details: `skills=${skills.size}` },
      { name: "workspace_guardrails_enabled", status: "pass" }
    ]
  });
});

const port = Number(process.env.PORT || 4103);
async function bootstrap() {
  const saved = await loadStore<Skill>();
  for (const skill of saved) {
    skills.set(skill.id, skill);
  }
  app.listen(port, () => {
    console.log(`skills-registry listening on ${port}`);
  });
}

void bootstrap();

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : "Unhandled skills-registry error";
  return res.status(500).json({ error: message });
});
