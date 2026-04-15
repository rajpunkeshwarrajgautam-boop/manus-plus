"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./page.module.css";
import { clearIdentityStorage, loadIdentityFromStorage, saveIdentityToStorage } from "../lib/identity-storage";

const ORCHESTRATOR_URL = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "http://localhost:4100";
const BROWSER_URL = process.env.NEXT_PUBLIC_BROWSER_OPERATOR_URL || "http://localhost:4101";
const SKILLS_URL = process.env.NEXT_PUBLIC_SKILLS_REGISTRY_URL || "http://localhost:4103";
const REALTIME_URL = process.env.NEXT_PUBLIC_REALTIME_URL || "ws://localhost:4102";
const REALTIME_HTTP_URL = REALTIME_URL.replace(/^ws/i, "http");

const iconForEvent = (event: string): string => {
  if (event.includes("task_started")) return "▶";
  if (event.includes("step_created")) return "◆";
  if (event.includes("artifact_created")) return "▣";
  if (event.includes("quality_gate")) return "◎";
  if (event.includes("task_retrying")) return "↻";
  if (event.includes("task_completed")) return "✓";
  if (event.includes("task_failed")) return "!";
  return "•";
};

interface StepEvent {
  id?: string;
  taskId?: string;
  content?: string;
  type?: string;
  phase?: string;
  reason?: string;
  score?: number;
  passed?: boolean;
  retryCount?: number;
  attempt?: number;
  reliability?: number;
}

type ForgeTab = "plan" | "browser" | "files" | "skills";
type BrowserActionMode = "goto" | "click" | "type";
type QuickMode = "research" | "build" | "analyze" | "design";
type TimelineScope = "all" | "local" | "remote";
interface TelemetrySnapshot {
  client?: string;
  generatedAt?: string;
  status?: string;
  timelineScope?: string;
  localEventCount?: number;
  remoteEventCount?: number;
  dedupedRemoteCount?: number;
  taskId?: string | null;
}

type ServiceStatus = "checking" | "online" | "offline";
interface ServiceHealthBadge {
  key: "orchestrator" | "browser-operator" | "skills-registry" | "realtime";
  label: string;
  url: string;
  status: ServiceStatus;
  latencyMs?: number;
  lastCheckedAt?: string;
  lastErrorReason?: string;
}
const SERVICE_BADGE_DEFS: Array<Omit<ServiceHealthBadge, "status">> = [
  { key: "orchestrator", label: "Orchestrator", url: ORCHESTRATOR_URL },
  { key: "browser-operator", label: "Browser", url: BROWSER_URL },
  { key: "skills-registry", label: "Skills", url: SKILLS_URL },
  { key: "realtime", label: "Realtime", url: REALTIME_HTTP_URL }
];

function formatCheckedAt(ts?: string): string {
  if (!ts) return "-";
  const date = new Date(ts);
  if (Number.isNaN(date.valueOf())) return "-";
  return date.toLocaleTimeString();
}

function formatErrorReason(err: unknown): string {
  if (err instanceof DOMException && err.name === "AbortError") return "timeout";
  if (err instanceof Error) return err.message || err.name || "request failed";
  return "request failed";
}

function parseOpsPanelJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed || /^No .+ yet\.?$/i.test(trimmed)) {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { _unparsed: true, raw };
  }
}

export default function HomePage() {
  const [prompt, setPrompt] = useState("Research AI agent pricing and summarize GTM angles.");
  const [sessionId, setSessionId] = useState("session-main");
  const [taskId, setTaskId] = useState("");
  const [taskEvents, setTaskEvents] = useState<string[]>([]);
  const [parsedEvents, setParsedEvents] = useState<Array<{ event: string; text: string; source?: string }>>([]);
  const [browserSessionId, setBrowserSessionId] = useState("");
  const [browserOutput, setBrowserOutput] = useState("No browser action yet.");
  const [skillId, setSkillId] = useState("");
  const [skillOutput, setSkillOutput] = useState("No skill operation yet.");
  const [forgeTab, setForgeTab] = useState<ForgeTab>("plan");
  const [artifacts, setArtifacts] = useState<Array<{ title: string; kind: string; content?: string }>>([]);
  const [isTaskStreaming, setIsTaskStreaming] = useState(false);
  const [actorId, setActorId] = useState("demo-user");
  const [workspaceId, setWorkspaceId] = useState("demo-workspace");
  const [role, setRole] = useState<"user" | "admin">("admin");
  const [presence, setPresence] = useState<string[]>([]);
  const [collabSocket, setCollabSocket] = useState<WebSocket | null>(null);
  const [idempotencySeed, setIdempotencySeed] = useState("first-run");
  const [maxRetries, setMaxRetries] = useState(3);
  const [browserAction, setBrowserAction] = useState<BrowserActionMode>("goto");
  const [browserUrl, setBrowserUrl] = useState("https://example.com");
  const [browserSelector, setBrowserSelector] = useState("#main");
  const [browserText, setBrowserText] = useState("hello");
  const [availableSkills, setAvailableSkills] = useState<Array<{ id: string; title: string; slug: string }>>([]);
  const [taskList, setTaskList] = useState<Array<{ id: string; state: string; phase?: string; prompt: string; steps?: number; artifacts?: number }>>([]);
  const [copiedTaskId, setCopiedTaskId] = useState("");
  const [metricsSummary, setMetricsSummary] = useState<string>("No metrics yet.");
  const [taskFilterState, setTaskFilterState] = useState<"" | "queued" | "running" | "waiting_user" | "completed" | "failed" | "cancelled">("");
  const [taskFilterPhase, setTaskFilterPhase] = useState<"" | "plan" | "execute" | "verify" | "finalize">("");
  const [diagnostics, setDiagnostics] = useState<string>("No diagnostics yet.");
  const [serviceHealth, setServiceHealth] = useState<string>("No health data yet.");
  const [opsSnapshotCopyState, setOpsSnapshotCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [opsBundleCopyState, setOpsBundleCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [opsRefreshState, setOpsRefreshState] = useState<"idle" | "refreshing" | "failed">("idle");
  const [serviceVersions, setServiceVersions] = useState<string>("No version data yet.");
  const [serviceReadiness, setServiceReadiness] = useState<string>("No readiness data yet.");
  const [quickMode, setQuickMode] = useState<QuickMode>("research");
  const [taskExportPreview, setTaskExportPreview] = useState<string>("No export generated yet.");
  const [showAdvancedComposer, setShowAdvancedComposer] = useState(false);
  const [timelineScope, setTimelineScope] = useState<TimelineScope>("all");
  const [dedupedRemoteCount, setDedupedRemoteCount] = useState(0);
  const [telemetryA, setTelemetryA] = useState<TelemetrySnapshot | null>(null);
  const [telemetryB, setTelemetryB] = useState<TelemetrySnapshot | null>(null);
  const [telemetryCompareResult, setTelemetryCompareResult] = useState("Upload two telemetry snapshots to compare.");
  const seenRemoteEventsRef = useRef<Set<string>>(new Set());
  const [identityHydrated, setIdentityHydrated] = useState(false);
  const [orchestratorStatus, setOrchestratorStatus] = useState<"checking" | "online" | "offline">("checking");
  const [healthAutoRefresh, setHealthAutoRefresh] = useState(true);
  const [serviceBadges, setServiceBadges] = useState<ServiceHealthBadge[]>(
    SERVICE_BADGE_DEFS.map((service) => ({ ...service, status: "checking" }))
  );

  const probeOrchestrator = useCallback(async () => {
    setOrchestratorStatus("checking");
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${ORCHESTRATOR_URL}/health`, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal
      });
      if (!response.ok) {
        setOrchestratorStatus("offline");
        return;
      }
      const data = (await response.json()) as { ok?: boolean };
      setOrchestratorStatus(data.ok === true ? "online" : "offline");
    } catch {
      setOrchestratorStatus("offline");
    } finally {
      window.clearTimeout(timer);
    }
  }, []);

  const probeServiceBadges = useCallback(async () => {
    setServiceBadges((prev) => prev.map((item) => ({ ...item, status: "checking" })));
    const probes = await Promise.allSettled(
      SERVICE_BADGE_DEFS.map(async (service) => {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 4000);
        const startedAt = performance.now();
        const checkedAt = new Date().toISOString();
        try {
          const response = await fetch(`${service.url}/health`, {
            method: "GET",
            cache: "no-store",
            signal: controller.signal
          });
          return {
            key: service.key,
            status: response.ok ? ("online" as const) : ("offline" as const),
            latencyMs: Math.round(performance.now() - startedAt),
            lastCheckedAt: checkedAt,
            lastErrorReason: response.ok ? undefined : `HTTP ${response.status}`
          };
        } catch (error) {
          return {
            key: service.key,
            status: "offline" as const,
            latencyMs: Math.round(performance.now() - startedAt),
            lastCheckedAt: checkedAt,
            lastErrorReason: formatErrorReason(error)
          };
        } finally {
          window.clearTimeout(timeout);
        }
      })
    );
    const resultByKey = new Map<
      ServiceHealthBadge["key"],
      Pick<ServiceHealthBadge, "status" | "latencyMs" | "lastCheckedAt" | "lastErrorReason">
    >();
    for (const probe of probes) {
      if (probe.status === "fulfilled") {
        resultByKey.set(probe.value.key, {
          status: probe.value.status,
          latencyMs: probe.value.latencyMs,
          lastCheckedAt: probe.value.lastCheckedAt,
          lastErrorReason: probe.value.lastErrorReason
        });
      }
    }
    setServiceBadges((prev) =>
      prev.map((item) => {
        const next = resultByKey.get(item.key);
        if (!next) {
          return {
            ...item,
            status: "offline",
            lastCheckedAt: new Date().toISOString(),
            lastErrorReason: "no probe result"
          };
        }
        return { ...item, ...next };
      })
    );
  }, []);

  useEffect(() => {
    const stored = loadIdentityFromStorage();
    if (stored.actorId) setActorId(stored.actorId);
    if (stored.workspaceId) setWorkspaceId(stored.workspaceId);
    if (stored.role) setRole(stored.role);
    if (stored.sessionId) setSessionId(stored.sessionId);
    if (stored.idempotencySeed) setIdempotencySeed(stored.idempotencySeed);
    setIdentityHydrated(true);
  }, []);

  useEffect(() => {
    if (!identityHydrated) return;
    saveIdentityToStorage({ actorId, workspaceId, role, sessionId, idempotencySeed });
  }, [identityHydrated, actorId, workspaceId, role, sessionId, idempotencySeed]);

  const runtimeConfig = useMemo(
    () =>
      JSON.stringify(
        {
          orchestratorUrl: ORCHESTRATOR_URL,
          browserOperatorUrl: BROWSER_URL,
          skillsRegistryUrl: SKILLS_URL,
          realtimeUrl: REALTIME_URL,
          actorId,
          workspaceId,
          role
        },
        null,
        2
      ),
    [actorId, role, workspaceId]
  );

  const defaultHeaders = useMemo(() => ({
    "Content-Type": "application/json",
    "x-actor-id": actorId,
    "x-workspace-id": workspaceId,
    "x-role": role
  }), [actorId, role, workspaceId]);

  const taskStatus = useMemo(() => {
    if (taskEvents.some((e) => e.includes("task_failed"))) return "failed";
    if (taskEvents.some((e) => e.includes("task_completed"))) return "completed";
    if (taskEvents.length > 0) return "running";
    return "idle";
  }, [taskEvents]);

  const statusToneClass = useMemo(() => {
    if (taskStatus === "completed") return styles.statusOk;
    if (taskStatus === "failed") return styles.statusFail;
    if (taskStatus === "running") return styles.statusRun;
    return styles.statusIdle;
  }, [taskStatus]);

  const quickActions: Array<{ mode: QuickMode; title: string; desc: string; prompt: string }> = [
    { mode: "research", title: "Research", desc: "Find and summarize", prompt: "Research top AI agent products and summarize pricing + positioning." },
    { mode: "build", title: "Build", desc: "Create working output", prompt: "Build a go-to-market launch plan with milestones and owners." },
    { mode: "analyze", title: "Analyze", desc: "Break down data", prompt: "Analyze this task setup and recommend reliability improvements." },
    { mode: "design", title: "Design", desc: "Shape artifacts", prompt: "Create a product narrative for Manus Plus in markdown." }
  ];

  const visibleParsedEvents = useMemo(() => {
    if (timelineScope === "all") return parsedEvents;
    if (timelineScope === "local") return parsedEvents.filter((e) => !e.source || e.source === "web");
    return parsedEvents.filter((e) => e.source && e.source !== "web");
  }, [parsedEvents, timelineScope]);

  const localEventCount = useMemo(
    () => parsedEvents.filter((e) => !e.source || e.source === "web").length,
    [parsedEvents]
  );
  const remoteEventCount = useMemo(
    () => parsedEvents.filter((e) => e.source && e.source !== "web").length,
    [parsedEvents]
  );
  const serviceOnlineCount = useMemo(
    () => serviceBadges.filter((service) => service.status === "online").length,
    [serviceBadges]
  );

  const copyTaskId = useCallback(async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedTaskId(id);
      window.setTimeout(() => {
        setCopiedTaskId((prev) => (prev === id ? "" : prev));
      }, 1500);
    } catch {
      setCopiedTaskId("");
    }
  }, []);

  const copyServiceSnapshot = useCallback(async () => {
    const snapshot = {
      generatedAt: new Date().toISOString(),
      workspaceId,
      role,
      orchestratorUrl: ORCHESTRATOR_URL,
      services: serviceBadges.map((service) => ({
        key: service.key,
        label: service.label,
        url: service.url,
        status: service.status,
        latencyMs: service.latencyMs ?? null,
        lastCheckedAt: service.lastCheckedAt ?? null,
        lastErrorReason: service.lastErrorReason ?? null
      }))
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
      setOpsSnapshotCopyState("copied");
      window.setTimeout(() => {
        setOpsSnapshotCopyState("idle");
      }, 1800);
    } catch {
      setOpsSnapshotCopyState("failed");
      window.setTimeout(() => {
        setOpsSnapshotCopyState("idle");
      }, 1800);
    }
  }, [role, serviceBadges, workspaceId]);

  const copyOpsBundle = useCallback(async () => {
    const bundle = {
      generatedAt: new Date().toISOString(),
      client: "web",
      workspaceId,
      role,
      endpoints: {
        orchestrator: ORCHESTRATOR_URL,
        browserOperator: BROWSER_URL,
        skillsRegistry: SKILLS_URL,
        realtimeWs: REALTIME_URL,
        realtimeHttp: REALTIME_HTTP_URL
      },
      uiProbes: serviceBadges.map((service) => ({
        key: service.key,
        label: service.label,
        url: service.url,
        status: service.status,
        latencyMs: service.latencyMs ?? null,
        lastCheckedAt: service.lastCheckedAt ?? null,
        lastErrorReason: service.lastErrorReason ?? null
      })),
      health: parseOpsPanelJson(serviceHealth),
      versions: parseOpsPanelJson(serviceVersions),
      readiness: parseOpsPanelJson(serviceReadiness)
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
      setOpsBundleCopyState("copied");
      window.setTimeout(() => setOpsBundleCopyState("idle"), 1800);
    } catch {
      setOpsBundleCopyState("failed");
      window.setTimeout(() => setOpsBundleCopyState("idle"), 1800);
    }
  }, [role, serviceBadges, serviceHealth, serviceReadiness, serviceVersions, workspaceId]);

  const compareTelemetry = useCallback((a: TelemetrySnapshot, b: TelemetrySnapshot) => {
    const localDelta = (b.localEventCount || 0) - (a.localEventCount || 0);
    const remoteDelta = (b.remoteEventCount || 0) - (a.remoteEventCount || 0);
    const dedupeDelta = (b.dedupedRemoteCount || 0) - (a.dedupedRemoteCount || 0);
    const lines = [
      `A: ${(a.client || "unknown")} ${(a.generatedAt || "-")} status=${a.status || "-"} scope=${a.timelineScope || "-"}`,
      `B: ${(b.client || "unknown")} ${(b.generatedAt || "-")} status=${b.status || "-"} scope=${b.timelineScope || "-"}`,
      `Local delta: ${localDelta >= 0 ? "+" : ""}${localDelta}`,
      `Remote delta: ${remoteDelta >= 0 ? "+" : ""}${remoteDelta}`,
      `Deduped delta: ${dedupeDelta >= 0 ? "+" : ""}${dedupeDelta}`
    ];
    setTelemetryCompareResult(lines.join("\n"));
  }, []);

  const onTelemetryUpload = useCallback(async (file: File | null, target: "a" | "b") => {
    if (!file) return;
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw) as TelemetrySnapshot;
      if (target === "a") {
        setTelemetryA(parsed);
        if (telemetryB) compareTelemetry(parsed, telemetryB);
      } else {
        setTelemetryB(parsed);
        if (telemetryA) compareTelemetry(telemetryA, parsed);
      }
    } catch {
      setTelemetryCompareResult("Invalid telemetry JSON file.");
    }
  }, [compareTelemetry, telemetryA, telemetryB]);

  const captureCurrentTelemetry = useCallback((target: "a" | "b") => {
    const snapshot: TelemetrySnapshot = {
      client: "web",
      generatedAt: new Date().toISOString(),
      status: taskStatus,
      timelineScope,
      localEventCount,
      remoteEventCount,
      dedupedRemoteCount,
      taskId: taskId || null
    };
    if (target === "a") {
      setTelemetryA(snapshot);
      if (telemetryB) compareTelemetry(snapshot, telemetryB);
    } else {
      setTelemetryB(snapshot);
      if (telemetryA) compareTelemetry(telemetryA, snapshot);
    }
  }, [
    compareTelemetry,
    dedupedRemoteCount,
    localEventCount,
    remoteEventCount,
    taskId,
    taskStatus,
    telemetryA,
    telemetryB,
    timelineScope
  ]);

  const swapTelemetrySnapshots = useCallback(() => {
    if (!telemetryA && !telemetryB) return;
    const nextA = telemetryB;
    const nextB = telemetryA;
    setTelemetryA(nextA || null);
    setTelemetryB(nextB || null);
    if (nextA && nextB) {
      compareTelemetry(nextA, nextB);
    } else {
      setTelemetryCompareResult("Upload two telemetry snapshots to compare.");
    }
  }, [compareTelemetry, telemetryA, telemetryB]);

  const clearTelemetryCompare = useCallback(() => {
    setTelemetryA(null);
    setTelemetryB(null);
    setTelemetryCompareResult("Upload two telemetry snapshots to compare.");
  }, []);

  const refreshSkills = useCallback(async () => {
    const response = await fetch(`${SKILLS_URL}/skills?workspaceId=${encodeURIComponent(workspaceId)}`);
    const data = await response.json();
    setAvailableSkills(Array.isArray(data.skills) ? data.skills : []);
  }, [workspaceId]);

  const refreshTaskList = useCallback(async () => {
    const search = new URLSearchParams();
    search.set("limit", "12");
    if (taskFilterState) search.set("state", taskFilterState);
    if (taskFilterPhase) search.set("phase", taskFilterPhase);
    const response = await fetch(`${ORCHESTRATOR_URL}/tasks?${search.toString()}`, {
      headers: defaultHeaders
    });
    const data = await response.json();
    setTaskList(Array.isArray(data.tasks) ? data.tasks : []);
  }, [defaultHeaders, taskFilterPhase, taskFilterState]);

  const refreshMetricsSummary = useCallback(async () => {
    const response = await fetch(`${ORCHESTRATOR_URL}/ops/metrics-summary`, {
      headers: defaultHeaders
    });
    const data = await response.json();
    setMetricsSummary(JSON.stringify(data, null, 2));
  }, [defaultHeaders]);

  const refreshServiceHealth = useCallback(async () => {
    const checks = await Promise.allSettled([
      fetch(`${ORCHESTRATOR_URL}/health`, { headers: defaultHeaders }).then((r) => r.json()),
      fetch(`${BROWSER_URL}/health`, { headers: defaultHeaders }).then((r) => r.json()),
      fetch(`${SKILLS_URL}/health`, { headers: defaultHeaders }).then((r) => r.json()),
      fetch(`${REALTIME_HTTP_URL}/health`).then((r) => r.json())
    ]);
    const normalized = checks.map((check, idx) => {
      const name = idx === 0 ? "orchestrator" : idx === 1 ? "browser-operator" : idx === 2 ? "skills-registry" : "realtime";
      if (check.status === "fulfilled") return { service: name, ok: true, ...check.value };
      return { service: name, ok: false, error: "unreachable" };
    });
    setServiceHealth(JSON.stringify(normalized, null, 2));
  }, [defaultHeaders]);

  const refreshServiceVersions = useCallback(async () => {
    const checks = await Promise.allSettled([
      fetch(`${ORCHESTRATOR_URL}/version`, { headers: defaultHeaders }).then((r) => r.json()),
      fetch(`${BROWSER_URL}/version`, { headers: defaultHeaders }).then((r) => r.json()),
      fetch(`${SKILLS_URL}/version`, { headers: defaultHeaders }).then((r) => r.json()),
      fetch(`${REALTIME_HTTP_URL}/version`).then((r) => r.json())
    ]);
    const normalized = checks.map((check, idx) => {
      const name = idx === 0 ? "orchestrator" : idx === 1 ? "browser-operator" : idx === 2 ? "skills-registry" : "realtime";
      if (check.status === "fulfilled") return { service: name, ok: true, ...check.value };
      return { service: name, ok: false, error: "unreachable" };
    });
    setServiceVersions(JSON.stringify(normalized, null, 2));
  }, [defaultHeaders]);

  const refreshServiceReadiness = useCallback(async () => {
    const checks = await Promise.allSettled([
      fetch(`${ORCHESTRATOR_URL}/readiness`, { headers: defaultHeaders }).then((r) => r.json()),
      fetch(`${BROWSER_URL}/readiness`, { headers: defaultHeaders }).then((r) => r.json()),
      fetch(`${SKILLS_URL}/readiness`, { headers: defaultHeaders }).then((r) => r.json()),
      fetch(`${REALTIME_HTTP_URL}/readiness`).then((r) => r.json())
    ]);
    const normalized = checks.map((check, idx) => {
      const name = idx === 0 ? "orchestrator" : idx === 1 ? "browser-operator" : idx === 2 ? "skills-registry" : "realtime";
      if (check.status === "fulfilled") return { service: name, ok: true, ...check.value };
      return { service: name, ok: false, error: "unreachable" };
    });
    setServiceReadiness(JSON.stringify(normalized, null, 2));
  }, [defaultHeaders]);

  const refreshAllOpsPanels = useCallback(async () => {
    setOpsRefreshState("refreshing");
    try {
      await Promise.all([
        refreshServiceHealth(),
        refreshServiceVersions(),
        refreshServiceReadiness()
      ]);
      setOpsRefreshState("idle");
    } catch {
      setOpsRefreshState("failed");
      window.setTimeout(() => {
        setOpsRefreshState("idle");
      }, 1800);
    }
  }, [refreshServiceHealth, refreshServiceReadiness, refreshServiceVersions]);

  const startTask = useCallback(async () => {
    setTaskEvents([]);
    setParsedEvents([]);
    setDedupedRemoteCount(0);
    seenRemoteEventsRef.current.clear();
    setArtifacts([]);
    setIsTaskStreaming(true);
    try {
      const response = await fetch(`${ORCHESTRATOR_URL}/tasks`, {
        method: "POST",
        headers: { ...defaultHeaders, "idempotency-key": `${workspaceId}:${sessionId}:${idempotencySeed}` },
        body: JSON.stringify({ prompt: `[${quickMode}] ${prompt}`, sessionId, maxRetries })
      });
      if (!response.ok || !response.body) {
        const errText = await response.text().catch(() => "");
        setTaskEvents([`task_failed: HTTP ${response.status}${errText ? ` — ${errText}` : ""}`]);
        setParsedEvents((prev) => [...prev, { event: "task_failed", text: `HTTP ${response.status}`, source: "web" }]);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() || "";

        for (const chunk of chunks) {
          const lines = chunk.split("\n");
          const eventLine = lines.find((l) => l.startsWith("event: "));
          const dataLine = lines.find((l) => l.startsWith("data: "));
          const eventName = eventLine ? eventLine.slice(7) : "unknown";
          const dataRaw = dataLine ? dataLine.slice(6) : "{}";
          let parsed: StepEvent = {};
          try {
            parsed = JSON.parse(dataRaw) as StepEvent;
          } catch {
            parsed = { content: dataRaw };
          }
          if (eventName === "task_started" && parsed.taskId) {
            setTaskId(String(parsed.taskId));
          }
          if (eventName === "artifact_created") {
            setArtifacts((prev) => [
              ...prev,
              {
                title: typeof parsed.content === "string" ? parsed.content : "Generated Artifact",
                kind: "report",
                content: JSON.stringify(parsed)
              }
            ]);
          }
          const contentText = (() => {
            if (eventName === "quality_gate") {
              return `attempt ${parsed.attempt} score ${parsed.score}/100 passed=${parsed.passed} reason=${parsed.reason}`;
            }
            if (eventName === "task_retrying") {
              return `retry ${parsed.retryCount} reason=${parsed.reason || "unknown"}`;
            }
            if (eventName === "task_failed") {
              return parsed.reason || parsed.content || "Task failed";
            }
            if (eventName === "task_completed") {
              return `completed reliability=${parsed.reliability}`;
            }
            return parsed.content || JSON.stringify(parsed);
          })();
          const line = `${eventName}: ${contentText}`;
          setTaskEvents((prev) => [...prev, line]);
          setParsedEvents((prev) => [...prev, { event: eventName, text: contentText, source: "web" }]);
          const effectiveTaskId = parsed.taskId || taskId;
          if (collabSocket && collabSocket.readyState === WebSocket.OPEN && effectiveTaskId) {
            collabSocket.send(JSON.stringify({
              type: "task_event",
              taskId: effectiveTaskId,
              body: { event: eventName, content: parsed.content || parsed, origin: "web" }
            }));
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setTaskEvents((prev) => [...prev, `task_failed: ${msg}`]);
      setParsedEvents((prev) => [...prev, { event: "task_failed", text: msg, source: "web" }]);
    } finally {
      setIsTaskStreaming(false);
    }
  }, [collabSocket, defaultHeaders, idempotencySeed, maxRetries, prompt, quickMode, sessionId, taskId, workspaceId]);

  async function createBrowserSession() {
    try {
      const response = await fetch(`${BROWSER_URL}/sessions`, {
        method: "POST",
        headers: defaultHeaders,
        body: JSON.stringify({ taskId: taskId || "manual-task", startUrl: browserUrl || "https://example.com" })
      });
      const raw = await response.text();
      let data: unknown;
      try {
        data = JSON.parse(raw) as { id?: string };
      } catch {
        data = { raw };
      }
      if (!response.ok) {
        setBrowserSessionId("");
        setBrowserOutput(`Create session failed (${response.status}): ${raw}`);
        return;
      }
      const obj = data as { id?: string };
      setBrowserSessionId(obj.id || "");
      setBrowserOutput(JSON.stringify(data, null, 2));
    } catch (e) {
      setBrowserSessionId("");
      setBrowserOutput(e instanceof Error ? e.message : "Network error creating browser session");
    }
  }

  async function browserTakeoverRequest() {
    if (!browserSessionId) return;
    const response = await fetch(`${BROWSER_URL}/sessions/${browserSessionId}/takeover/request`, {
      method: "POST",
      headers: defaultHeaders,
      body: JSON.stringify({ reason: "mfa_required" })
    });
    setBrowserOutput(JSON.stringify(await response.json(), null, 2));
  }

  async function browserTakeoverRelease() {
    if (!browserSessionId) return;
    const response = await fetch(`${BROWSER_URL}/sessions/${browserSessionId}/takeover/release`, {
      method: "POST",
      headers: defaultHeaders
    });
    setBrowserOutput(JSON.stringify(await response.json(), null, 2));
  }

  async function browserGoto() {
    if (!browserSessionId) return;
    try {
      const payload = (() => {
        if (browserAction === "goto") return { action: "goto", url: browserUrl };
        if (browserAction === "click") return { action: "click", url: browserUrl, selector: browserSelector };
        return { action: "type", url: browserUrl, selector: browserSelector, text: browserText };
      })();
      const response = await fetch(`${BROWSER_URL}/sessions/${browserSessionId}/actions`, {
        method: "POST",
        headers: defaultHeaders,
        body: JSON.stringify(payload)
      });
      const raw = await response.text();
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        data = { raw };
      }
      if (!response.ok) {
        setBrowserOutput(`Action failed (${response.status}): ${raw}`);
        return;
      }
      setBrowserOutput(JSON.stringify(data, null, 2));
    } catch (e) {
      setBrowserOutput(e instanceof Error ? e.message : "Network error running browser action");
    }
  }

  async function createSkill() {
    const response = await fetch(`${SKILLS_URL}/skills`, {
      method: "POST",
      headers: defaultHeaders,
      body: JSON.stringify({
        workspaceId,
        actorId,
        slug: `market-research-${Date.now()}`,
        title: "Market Research Skill",
        instructions: "Gather top competitors, summarize positioning, and draft a launch brief."
      })
    });
    const data = await response.json();
    setSkillId(data.id || "");
    setSkillOutput(JSON.stringify(data, null, 2));
    await refreshSkills();
  }

  async function invokeSkill() {
    if (!skillId) return;
    const response = await fetch(`${SKILLS_URL}/skills/${skillId}/invoke`, {
      method: "POST",
      headers: defaultHeaders,
      body: JSON.stringify({ workspaceId, payload: { sector: "ai-productivity", region: "global" } })
    });
    setSkillOutput(JSON.stringify(await response.json(), null, 2));
  }

  async function loadTaskDetails(targetTaskId: string) {
    const response = await fetch(`${ORCHESTRATOR_URL}/tasks/${targetTaskId}`, {
      headers: defaultHeaders
    });
    const data = await response.json();
    if (data?.task) {
      setTaskId(data.task.id);
      setArtifacts(Array.isArray(data.task.artifacts) ? data.task.artifacts : []);
      setParsedEvents(
        Array.isArray(data.task.steps)
          ? data.task.steps.map((step: { type: string; content: string }) => ({ event: "step_created", text: `${step.type}: ${step.content}` }))
          : []
      );
      setTaskEvents(
        Array.isArray(data.task.steps)
          ? data.task.steps.map((step: { type: string; content: string }) => `step_created: ${step.type}: ${step.content}`)
          : []
      );
      setDiagnostics(JSON.stringify({
        state: data.task.state,
        phase: data.task.phase,
        retryCount: data.task.retryCount,
        checkpoints: data.task.checkpoints?.length || 0,
        artifacts: data.task.artifacts?.length || 0
      }, null, 2));
    }
  }

  async function exportTask(format: "json" | "markdown") {
    if (!taskId) return;
    const response = await fetch(`${ORCHESTRATOR_URL}/tasks/${taskId}/export?format=${format}`, {
      headers: defaultHeaders
    });
    if (format === "json") {
      const payload = await response.json();
      setTaskExportPreview(JSON.stringify(payload, null, 2));
      return;
    }
    const payload = await response.text();
    setTaskExportPreview(payload);
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void startTask();
      }
      if (event.key === "/") {
        const activeTag = (document.activeElement as HTMLElement | null)?.tagName.toLowerCase();
        if (activeTag !== "input" && activeTag !== "textarea") {
          event.preventDefault();
          const area = document.getElementById("prompt-composer");
          area?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [startTask]);

  useEffect(() => {
    void refreshSkills();
  }, [refreshSkills]);

  useEffect(() => {
    void probeOrchestrator();
    if (!healthAutoRefresh) return;
    const interval = window.setInterval(() => {
      void probeOrchestrator();
    }, 10_000);
    return () => window.clearInterval(interval);
  }, [probeOrchestrator, healthAutoRefresh]);

  useEffect(() => {
    void probeServiceBadges();
    if (!healthAutoRefresh) return;
    const interval = window.setInterval(() => {
      void probeServiceBadges();
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [probeServiceBadges, healthAutoRefresh]);

  useEffect(() => {
    void refreshTaskList();
    const timer = setInterval(() => {
      void refreshTaskList();
    }, 5000);
    return () => clearInterval(timer);
  }, [refreshTaskList]);

  useEffect(() => {
    if (role !== "admin") return;
    void refreshMetricsSummary();
    void refreshServiceHealth();
    void refreshServiceVersions();
    void refreshServiceReadiness();
  }, [role, refreshMetricsSummary, refreshServiceHealth, refreshServiceVersions, refreshServiceReadiness]);

  useEffect(() => {
    if (!taskId) return;
    const ws = new WebSocket(REALTIME_URL);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "join_task", taskId }));
      setPresence((prev) => [...prev, `joined room ${taskId}`]);
      setCollabSocket(ws);
    });
    ws.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as { type: string; taskId?: string; body?: unknown };
        if (payload.type === "joined") {
          setPresence((prev) => [...prev, `realtime connected (${payload.taskId})`]);
          return;
        }
        if (payload.type === "task_event") {
          const body = payload.body as { event?: string; content?: unknown; origin?: string } | undefined;
          const origin = body?.origin || "remote";
          setPresence((prev) => [...prev, `collab (${origin}): ${JSON.stringify(body)}`]);
          if (origin !== "web" && body?.event) {
            const contentText = typeof body.content === "string" ? body.content : JSON.stringify(body.content);
            const dedupeKey = `${origin}:${body.event}:${contentText}`;
            if (seenRemoteEventsRef.current.has(dedupeKey)) {
              setDedupedRemoteCount((prev) => prev + 1);
              return;
            }
            seenRemoteEventsRef.current.add(dedupeKey);
            setParsedEvents((prev) => [
              ...prev,
              {
                event: `collab_${body.event}`,
                text: contentText,
                source: origin
              }
            ]);
          }
        }
      } catch {
        setPresence((prev) => [...prev, "realtime message parse failed"]);
      }
    });
    ws.addEventListener("close", () => setPresence((prev) => [...prev, "realtime disconnected"]));
    return () => {
      setCollabSocket(null);
      ws.close();
    };
  }, [taskId]);

  return (
    <main className={styles.page}>
      <aside className={styles.sidebar}>
        <div className={styles.brandWrap}>
          <div className={styles.brandDot} />
          <div className={styles.brand}>Manus Plus</div>
        </div>
        <div className={styles.backendStatus} aria-live="polite">
          <div className={styles.backendLine}>
            <span
              className={`${styles.backendDot} ${
                orchestratorStatus === "online"
                  ? styles.backendDotOnline
                  : orchestratorStatus === "offline"
                    ? styles.backendDotOffline
                    : styles.backendDotChecking
              }`}
              title="Orchestrator reachability"
            />
            <span className={styles.backendText}>
              {orchestratorStatus === "online" && "Orchestrator reachable"}
              {orchestratorStatus === "offline" && "Orchestrator unreachable"}
              {orchestratorStatus === "checking" && "Checking orchestrator…"}
            </span>
            <button
              type="button"
              className={styles.backendRetry}
              onClick={() => {
                void probeOrchestrator();
                void probeServiceBadges();
              }}
            >
              Retry
            </button>
            <button
              type="button"
              className={styles.backendAutoToggle}
              onClick={() => setHealthAutoRefresh((prev) => !prev)}
            >
              Auto: {healthAutoRefresh ? "on" : "off"}
            </button>
          </div>
          <div className={styles.backendUrl}>{ORCHESTRATOR_URL}</div>
          <div
            className={`${styles.healthSummary} ${
              serviceOnlineCount === serviceBadges.length ? styles.healthSummaryOk : styles.healthSummaryWarn
            }`}
          >
            Services online: {serviceOnlineCount}/{serviceBadges.length}
          </div>
          <div className={styles.serviceBadges}>
            {serviceBadges.map((service) => (
              <div
                key={service.key}
                className={`${styles.serviceBadge} ${
                  service.status === "online"
                    ? styles.serviceBadgeOnline
                    : service.status === "offline"
                      ? styles.serviceBadgeOffline
                      : styles.serviceBadgeChecking
                }`}
                title={`${service.label} · ${service.url}`}
              >
                {service.label} {service.latencyMs != null ? `${service.latencyMs}ms` : ""}
                {service.status === "offline" && service.lastErrorReason ? ` · ${service.lastErrorReason}` : ""}
              </div>
            ))}
          </div>
          <div className={styles.backendCheckedAt}>
            Last check: {formatCheckedAt(serviceBadges.find((s) => s.key === "orchestrator")?.lastCheckedAt)}
          </div>
        </div>
        <button className={styles.newTaskBtn} onClick={() => void startTask()}>Start new run</button>
        <div className={styles.navSection}>Workspace</div>
        <div className={styles.navGroup}>
          <div className={styles.navItem}>Chat</div>
          <div className={styles.navItem}>Runs</div>
          <div className={styles.navItem}>Artifacts</div>
        </div>
        <div className={styles.navSection}>Recent Runs</div>
        <select className={`${styles.input} ${styles.sidebarInput}`} value={taskFilterState} onChange={(e) => setTaskFilterState(e.target.value as typeof taskFilterState)}>
          <option value="">all states</option>
          <option value="queued">queued</option>
          <option value="running">running</option>
          <option value="waiting_user">waiting_user</option>
          <option value="completed">completed</option>
          <option value="failed">failed</option>
          <option value="cancelled">cancelled</option>
        </select>
        <select className={`${styles.input} ${styles.sidebarInput}`} value={taskFilterPhase} onChange={(e) => setTaskFilterPhase(e.target.value as typeof taskFilterPhase)}>
          <option value="">all phases</option>
          <option value="plan">plan</option>
          <option value="execute">execute</option>
          <option value="verify">verify</option>
          <option value="finalize">finalize</option>
        </select>
        {taskList.length === 0 ? (
          <div className={styles.emptyNav}>No runs yet</div>
        ) : (
          taskList.map((task) => (
            <button
              key={task.id}
              className={styles.taskCardBtn}
              onClick={() => void loadTaskDetails(task.id)}
            >
              <div className={styles.taskMeta}>
                <span className={styles.taskStateDot} />
                <span className={task.state === "waiting_user" ? styles.waitingUserBadge : ""}>
                  {task.state}
                </span>{" "}
                · {task.phase || "-"}
              </div>
              <div className={styles.taskPrompt}>
                {task.prompt}
              </div>
              <div className={styles.taskCountsRow}>
                <div className={styles.taskCounts}>
                steps {task.steps || 0} · artifacts {task.artifacts || 0}
                </div>
                <button
                  type="button"
                  className={styles.copyTaskIdBtn}
                  onClick={(event) => {
                    event.stopPropagation();
                    void copyTaskId(task.id);
                  }}
                >
                  {copiedTaskId === task.id ? "Copied" : "Copy ID"}
                </button>
              </div>
            </button>
          ))
        )}
        <div className={styles.navSection}>Workspace Identity</div>
        <input className={`${styles.input} ${styles.sidebarInput}`} value={actorId} onChange={(e) => setActorId(e.target.value)} />
        <input className={`${styles.input} ${styles.sidebarInput}`} value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} />
        <select className={`${styles.input} ${styles.sidebarInput}`} value={role} onChange={(e) => setRole(e.target.value as "user" | "admin")}>
          <option value="admin">admin</option>
          <option value="user">user</option>
        </select>
        <button
          type="button"
          className={`${styles.newTaskBtn} ${styles.identityResetBtn}`}
          onClick={() => {
            clearIdentityStorage();
            setActorId("demo-user");
            setWorkspaceId("demo-workspace");
            setRole("admin");
            setSessionId("session-main");
            setIdempotencySeed("first-run");
            setIdentityHydrated(true);
          }}
        >
          Reset saved identity
        </button>
      </aside>

      <section className={styles.main}>
        <h1 className={styles.title}>What do you want to build today?</h1>
        <p className={styles.subtitle}>Autonomous execution with live planning, actions, and verification.</p>
        <div className={styles.mobileHealthStrip} aria-live="polite">
          <div className={styles.mobileHealthTopRow}>
            <span
              className={`${styles.backendDot} ${
                orchestratorStatus === "online"
                  ? styles.backendDotOnline
                  : orchestratorStatus === "offline"
                    ? styles.backendDotOffline
                    : styles.backendDotChecking
              }`}
              title="Orchestrator reachability"
            />
            <span className={styles.mobileHealthText}>
              {orchestratorStatus === "online" && "Orchestrator reachable"}
              {orchestratorStatus === "offline" && "Orchestrator unreachable"}
              {orchestratorStatus === "checking" && "Checking orchestrator…"}
            </span>
            <button
              type="button"
              className={styles.mobileHealthRetry}
              onClick={() => {
                void probeOrchestrator();
                void probeServiceBadges();
              }}
            >
              Retry
            </button>
            <button
              type="button"
              className={styles.mobileHealthRetry}
              onClick={() => setHealthAutoRefresh((prev) => !prev)}
            >
              Auto: {healthAutoRefresh ? "on" : "off"}
            </button>
          </div>
          <div className={styles.mobileServiceBadges}>
            {serviceBadges.map((service) => (
              <div
                key={`mobile-${service.key}`}
                className={`${styles.serviceBadge} ${
                  service.status === "online"
                    ? styles.serviceBadgeOnline
                    : service.status === "offline"
                      ? styles.serviceBadgeOffline
                      : styles.serviceBadgeChecking
                }`}
                title={`${service.label} · ${service.url}`}
              >
                {service.label} {service.latencyMs != null ? `${service.latencyMs}ms` : ""}
                {service.status === "offline" && service.lastErrorReason ? ` · ${service.lastErrorReason}` : ""}
              </div>
            ))}
          </div>
          <div
            className={`${styles.mobileHealthSummary} ${
              serviceOnlineCount === serviceBadges.length ? styles.healthSummaryOk : styles.healthSummaryWarn
            }`}
          >
            Services online: {serviceOnlineCount}/{serviceBadges.length}
          </div>
          <div className={styles.mobileCheckedAt}>
            Last check: {formatCheckedAt(serviceBadges.find((s) => s.key === "orchestrator")?.lastCheckedAt)}
          </div>
        </div>
        <div className={styles.quickActions}>
          {quickActions.map((action) => (
            <button
              key={action.mode}
              className={styles.quickAction}
              onClick={() => {
                setQuickMode(action.mode);
                setPrompt(action.prompt);
              }}
            >
              <span className={styles.quickTitle}>{action.title}</span>
              <span className={styles.quickDesc}>{action.desc}</span>
            </button>
          ))}
        </div>
        <div className={styles.composer}>
          <textarea
            id="prompt-composer"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            className={styles.textarea}
          />
          <div className={styles.composerActions}>
            <select value={quickMode} onChange={(e) => setQuickMode(e.target.value as QuickMode)} className={styles.input}>
              <option value="research">research</option>
              <option value="build">build</option>
              <option value="analyze">analyze</option>
              <option value="design">design</option>
            </select>
            <button className={`${styles.btn} ${styles.iconBtn} ${styles.btnPrimary}`} onClick={() => void startTask()} disabled={isTaskStreaming}>Run</button>
            {taskId && <button className={`${styles.btn} ${styles.iconBtn}`} onClick={() => fetch(`${ORCHESTRATOR_URL}/tasks/${taskId}/resume`, { method: "POST", headers: defaultHeaders })}>Resume</button>}
            {taskId && <button className={`${styles.btn} ${styles.iconBtn}`} onClick={() => fetch(`${ORCHESTRATOR_URL}/tasks/${taskId}/cancel`, { method: "POST", headers: defaultHeaders, body: JSON.stringify({ reason: "user_requested" }) })}>Cancel</button>}
            <button className={`${styles.btn} ${styles.iconBtn}`} onClick={() => setShowAdvancedComposer((prev) => !prev)}>
              {showAdvancedComposer ? "Hide advanced" : "Advanced"}
            </button>
            <span className={styles.kbdHint}>Ctrl/Cmd+Enter to run · / to focus</span>
          </div>
          {showAdvancedComposer && (
            <div className={styles.advancedComposer}>
              <input
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
                className={styles.input}
                placeholder="session id"
              />
              <input
                value={idempotencySeed}
                onChange={(e) => setIdempotencySeed(e.target.value)}
                className={styles.input}
                placeholder="idempotency seed"
              />
              <input
                type="number"
                min={1}
                max={10}
                value={maxRetries}
                onChange={(e) => setMaxRetries(Number(e.target.value) || 1)}
                className={styles.input}
              />
            </div>
          )}
          <div className={styles.statusRow}>
            <div className={`${styles.statusPill} ${statusToneClass}`}>Status {taskStatus}</div>
            {taskId && <div className={styles.taskIdText}>Task {taskId}</div>}
          </div>
        </div>

        <div className={styles.timeline}>
          <div className={styles.timelineFilterRow}>
            <button
              className={`${styles.filterChip} ${timelineScope === "all" ? styles.filterChipActive : ""}`}
              onClick={() => setTimelineScope("all")}
            >
              All
            </button>
            <button
              className={`${styles.filterChip} ${timelineScope === "local" ? styles.filterChipActive : ""}`}
              onClick={() => setTimelineScope("local")}
            >
              Local
            </button>
            <button
              className={`${styles.filterChip} ${timelineScope === "remote" ? styles.filterChipActive : ""}`}
              onClick={() => setTimelineScope("remote")}
            >
              Remote
            </button>
          </div>
          <div className={styles.eventCounterRow}>
            <span className={styles.counterPill}>Local {localEventCount}</span>
            <span className={styles.counterPill}>Remote {remoteEventCount}</span>
            <span className={styles.counterPill}>Deduped {dedupedRemoteCount}</span>
            <button
              className={styles.counterResetBtn}
              onClick={() => {
                setParsedEvents([]);
                setTaskEvents([]);
                setDedupedRemoteCount(0);
                seenRemoteEventsRef.current.clear();
              }}
            >
              Reset counters
            </button>
            <button
              className={styles.counterResetBtn}
              onClick={() => {
                const snapshot = {
                  client: "web",
                  generatedAt: new Date().toISOString(),
                  status: taskStatus,
                  timelineScope,
                  localEventCount,
                  remoteEventCount,
                  dedupedRemoteCount,
                  taskId: taskId || null
                };
                const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = `manus-plus-web-telemetry-${Date.now()}.json`;
                document.body.appendChild(link);
                link.click();
                link.remove();
                URL.revokeObjectURL(url);
              }}
            >
              Export telemetry
            </button>
          </div>
          {parsedEvents.length === 0 && !isTaskStreaming ? (
            <div className={styles.eventRow}>Task timeline will appear here in real time.</div>
          ) : isTaskStreaming && parsedEvents.length === 0 ? (
            <>
              <div className={styles.skeleton} />
              <div className={styles.skeleton} />
              <div className={styles.skeleton} />
            </>
          ) : (
            <>
              <div className={`${styles.eventRow} ${styles.userBubble}`}>
                <div className={styles.eventMeta}>You</div>
                <div>{prompt}</div>
              </div>
              {visibleParsedEvents.length === 0 ? (
                <div className={styles.eventRow}>No events for this filter yet.</div>
              ) : visibleParsedEvents.map((event, idx) => (
                <div
                  className={`${styles.eventRow} ${styles.agentBubble} ${event.event === "task_failed" ? styles.agentBubbleFail : ""}`}
                  key={`${event.text}-${idx}`}
                >
                  <div className={styles.eventMeta}>
                    {iconForEvent(event.event)} {event.event}
                    {event.source && <span className={styles.sourceBadge}>{event.source}</span>}
                  </div>
                  <div>{event.text}</div>
                </div>
              ))}
            </>
          )}
        </div>
      </section>

      <aside className={styles.forge}>
        <div className={styles.forgeTabs}>
          <button className={`${styles.forgeTab} ${forgeTab === "plan" ? styles.forgeTabActive : ""}`} onClick={() => setForgeTab("plan")}>Plan</button>
          <button className={`${styles.forgeTab} ${forgeTab === "browser" ? styles.forgeTabActive : ""}`} onClick={() => setForgeTab("browser")}>Browser</button>
          <button className={`${styles.forgeTab} ${forgeTab === "files" ? styles.forgeTabActive : ""}`} onClick={() => setForgeTab("files")}>Files</button>
          <button className={`${styles.forgeTab} ${forgeTab === "skills" ? styles.forgeTabActive : ""}`} onClick={() => setForgeTab("skills")}>Skills</button>
        </div>

        {forgeTab === "plan" && (
          <div className={styles.panel}>
            <h3 className={styles.panelTitle}>Execution Plan</h3>
            <div className={styles.output}>
              {parsedEvents
                .filter((e) => e.event === "step_created" || e.event === "task_started" || e.event === "task_completed")
                .map((e, i) => `${i + 1}. ${e.event} -> ${e.text}`)
                .join("\n") || "No plan data yet."}
            </div>
          </div>
        )}

        {forgeTab === "browser" && (
          <div className={styles.panel}>
            <h3 className={styles.panelTitle}>Browser Operator</h3>
            <div className={styles.controlGrid}>
              <select className={styles.input} value={browserAction} onChange={(e) => setBrowserAction(e.target.value as BrowserActionMode)}>
                <option value="goto">goto</option>
                <option value="click">click</option>
                <option value="type">type</option>
              </select>
              <input className={styles.input} value={browserUrl} onChange={(e) => setBrowserUrl(e.target.value)} />
              <input className={styles.input} value={browserSelector} onChange={(e) => setBrowserSelector(e.target.value)} />
              <input className={styles.input} value={browserText} onChange={(e) => setBrowserText(e.target.value)} />
            </div>
            <div className={styles.inlineActions}>
              <button className={`${styles.btn} ${styles.iconBtn}`} onClick={createBrowserSession}>Create session</button>
              <button className={`${styles.btn} ${styles.iconBtn}`} onClick={browserGoto} disabled={!browserSessionId}>Run action</button>
              <button className={`${styles.btn} ${styles.iconBtn}`} onClick={browserTakeoverRequest} disabled={!browserSessionId}>Request takeover</button>
              <button className={`${styles.btn} ${styles.iconBtn}`} onClick={browserTakeoverRelease} disabled={!browserSessionId}>Release control</button>
            </div>
            <div className={styles.output}>{browserOutput}</div>
          </div>
        )}

        {forgeTab === "files" && (
          <div className={styles.panel}>
            <h3 className={styles.panelTitle}>Artifacts</h3>
            {artifacts.length === 0 ? (
              <div className={`${styles.output} ${styles.emptyState}`}>No artifacts yet.</div>
            ) : (
              artifacts.map((artifact, idx) => (
                <div key={`${artifact.title}-${idx}`} className={styles.artifactCard}>
                  <strong>{artifact.title}</strong>
                  <div className={styles.artifactMeta}>{artifact.kind}</div>
                </div>
              ))
            )}
          </div>
        )}

        {forgeTab === "skills" && (
          <div className={styles.panel}>
            <h3 className={styles.panelTitle}>Skill Library</h3>
            <div className={styles.inlineActions}>
              <button className={`${styles.btn} ${styles.iconBtn}`} onClick={createSkill}>Create skill</button>
              <button className={`${styles.btn} ${styles.iconBtn}`} onClick={invokeSkill} disabled={!skillId}>Invoke skill</button>
              <button className={`${styles.btn} ${styles.iconBtn}`} onClick={refreshSkills}>Refresh list</button>
            </div>
            <div className={styles.output}>
              {availableSkills.length === 0
                ? "No skills in workspace."
                : availableSkills.map((s) => `${s.title} (${s.slug})`).join("\n")}
            </div>
            <div className={styles.output}>{skillOutput}</div>
          </div>
        )}

        <details className={styles.drawerSection} open>
          <summary className={styles.drawerSummary}>Realtime Presence</summary>
          <div className={styles.panel}>
            <div className={styles.output}>
              {presence.length === 0 ? "No realtime events yet." : presence.join("\n")}
            </div>
          </div>
        </details>
        {role === "admin" && (
          <details className={styles.drawerSection}>
            <summary className={styles.drawerSummary}>Ops Metrics</summary>
            <div className={styles.panel}>
              <button className={`${styles.btn} ${styles.iconBtn}`} onClick={refreshMetricsSummary}>Refresh metrics</button>
              <div className={styles.output}>{metricsSummary}</div>
            </div>
          </details>
        )}
        {role === "admin" && (
          <details className={styles.drawerSection}>
            <summary className={styles.drawerSummary}>Service Health</summary>
            <div className={styles.panel}>
              <div className={styles.inlineActions}>
                <button className={`${styles.btn} ${styles.iconBtn}`} onClick={() => void refreshAllOpsPanels()}>
                  {opsRefreshState === "refreshing"
                    ? "Refreshing all…"
                    : opsRefreshState === "failed"
                      ? "Refresh failed"
                      : "Refresh all ops"}
                </button>
                <button className={`${styles.btn} ${styles.iconBtn}`} onClick={refreshServiceHealth}>Refresh health</button>
                <button className={`${styles.btn} ${styles.iconBtn}`} onClick={() => void copyServiceSnapshot()}>
                  {opsSnapshotCopyState === "copied"
                    ? "Copied snapshot"
                    : opsSnapshotCopyState === "failed"
                      ? "Copy failed"
                      : "Copy snapshot"}
                </button>
                <button className={`${styles.btn} ${styles.iconBtn}`} onClick={() => void copyOpsBundle()}>
                  {opsBundleCopyState === "copied"
                    ? "Copied bundle"
                    : opsBundleCopyState === "failed"
                      ? "Bundle failed"
                      : "Copy ops bundle"}
                </button>
              </div>
              <div className={styles.output}>{serviceHealth}</div>
            </div>
          </details>
        )}
        {role === "admin" && (
          <details className={styles.drawerSection}>
            <summary className={styles.drawerSummary}>Service Versions</summary>
            <div className={styles.panel}>
              <button className={`${styles.btn} ${styles.iconBtn}`} onClick={refreshServiceVersions}>Refresh versions</button>
              <div className={styles.output}>{serviceVersions}</div>
            </div>
          </details>
        )}
        {role === "admin" && (
          <details className={styles.drawerSection}>
            <summary className={styles.drawerSummary}>Service Readiness</summary>
            <div className={styles.panel}>
              <button className={`${styles.btn} ${styles.iconBtn}`} onClick={refreshServiceReadiness}>Refresh readiness</button>
              <div className={styles.output}>{serviceReadiness}</div>
            </div>
          </details>
        )}
        {role === "admin" && (
          <details className={styles.drawerSection}>
            <summary className={styles.drawerSummary}>Runtime Config</summary>
            <div className={styles.panel}>
              <div className={styles.output}>{runtimeConfig}</div>
            </div>
          </details>
        )}
        <details className={styles.drawerSection}>
          <summary className={styles.drawerSummary}>Task Diagnostics</summary>
          <div className={styles.panel}>
            <div className={styles.output}>{diagnostics}</div>
          </div>
        </details>
        <details className={styles.drawerSection}>
          <summary className={styles.drawerSummary}>Task Export</summary>
          <div className={styles.panel}>
            <div className={styles.inlineActions}>
              <button className={`${styles.btn} ${styles.iconBtn}`} onClick={() => void exportTask("json")} disabled={!taskId}>JSON</button>
              <button className={`${styles.btn} ${styles.iconBtn}`} onClick={() => void exportTask("markdown")} disabled={!taskId}>Markdown</button>
            </div>
            <div className={styles.output}>{taskExportPreview}</div>
          </div>
        </details>
        <details className={styles.drawerSection}>
          <summary className={styles.drawerSummary}>Telemetry Compare</summary>
          <div className={styles.panel}>
            <div className={styles.telemetryCompareControls}>
              <label className={styles.telemetryUpload}>
                Snapshot A
                <input type="file" accept="application/json" onChange={(e) => void onTelemetryUpload(e.target.files?.[0] || null, "a")} />
                <button className={styles.telemetryActionBtn} onClick={() => captureCurrentTelemetry("a")}>Use current</button>
              </label>
              <label className={styles.telemetryUpload}>
                Snapshot B
                <input type="file" accept="application/json" onChange={(e) => void onTelemetryUpload(e.target.files?.[0] || null, "b")} />
                <button className={styles.telemetryActionBtn} onClick={() => captureCurrentTelemetry("b")}>Use current</button>
              </label>
            </div>
            <div className={styles.inlineActions}>
              <button className={styles.telemetryActionBtn} onClick={swapTelemetrySnapshots}>Swap A/B</button>
              <button className={styles.telemetryActionBtn} onClick={clearTelemetryCompare}>Clear compare</button>
              <button
                className={styles.telemetryActionBtn}
                onClick={() => {
                  void navigator.clipboard.writeText(telemetryCompareResult).catch(() => undefined);
                }}
              >
                Copy compare
              </button>
            </div>
            <div className={styles.output}>{telemetryCompareResult}</div>
          </div>
        </details>
      </aside>
    </main>
  );
}
