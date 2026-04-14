import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView, ScrollView, Share, StatusBar, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { ORCHESTRATOR_URL, REALTIME_URL } from "./runtime";

const MOBILE_STORAGE = {
  actor: "manus-plus.mobile.actorId",
  workspace: "manus-plus.mobile.workspaceId"
} as const;

type QuickMode = "research" | "build" | "analyze" | "design";
type TimelineScope = "all" | "local" | "remote";

const quickModes: QuickMode[] = ["research", "build", "analyze", "design"];

interface StepPayload {
  taskId?: string;
  content?: string;
  attempt?: number;
  score?: number;
  passed?: boolean;
  reason?: string;
  retryCount?: number;
  reliability?: number;
}

export default function App() {
  const [mode, setMode] = useState<QuickMode>("research");
  const [prompt, setPrompt] = useState("Plan a launch strategy for Manus Plus.");
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState("idle");
  const [activeTaskId, setActiveTaskId] = useState("");
  const [timelineScope, setTimelineScope] = useState<TimelineScope>("all");
  const [dedupedCount, setDedupedCount] = useState(0);
  const [timeline, setTimeline] = useState<string[]>([
    "Agent: step_created -> drafted launch milestones",
    "Agent: quality_gate -> score 88 passed=true"
  ]);
  const [collabSocket, setCollabSocket] = useState<WebSocket | null>(null);
  const collabRef = useRef<WebSocket | null>(null);
  const seenRemoteRef = useRef<Set<string>>(new Set());
  const [mobileActor, setMobileActor] = useState("mobile-user");
  const [mobileWorkspace, setMobileWorkspace] = useState("mobile-workspace");
  const [identityReady, setIdentityReady] = useState(false);

  useEffect(() => {
    collabRef.current = collabSocket;
  }, [collabSocket]);

  useEffect(() => {
    void (async () => {
      const [[, a], [, w]] = await AsyncStorage.multiGet([MOBILE_STORAGE.actor, MOBILE_STORAGE.workspace]);
      if (a) setMobileActor(a);
      if (w) setMobileWorkspace(w);
      setIdentityReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!identityReady) return;
    void AsyncStorage.multiSet([
      [MOBILE_STORAGE.actor, mobileActor],
      [MOBILE_STORAGE.workspace, mobileWorkspace]
    ]);
  }, [identityReady, mobileActor, mobileWorkspace]);

  const localCount = useMemo(
    () => timeline.filter((item) => !(item.startsWith("Collab:") || item.startsWith("Realtime:"))).length,
    [timeline]
  );
  const remoteCount = useMemo(
    () => timeline.filter((item) => item.startsWith("Collab:") || item.startsWith("Realtime:")).length,
    [timeline]
  );

  useEffect(() => {
    const ws = new WebSocket(REALTIME_URL);
    ws.onopen = () => setTimeline((prev) => [...prev, "Realtime: connected"]);
    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as { type?: string; body?: unknown };
        if (payload.type === "task_event") {
          const key = JSON.stringify(payload.body);
          if (seenRemoteRef.current.has(key)) {
            setDedupedCount((prev) => prev + 1);
            return;
          }
          seenRemoteRef.current.add(key);
          setTimeline((prev) => [...prev, `Collab: ${key}`]);
        }
      } catch {
        setTimeline((prev) => [...prev, "Realtime: message parse failed"]);
      }
    };
    ws.onclose = () => setTimeline((prev) => [...prev, "Realtime: disconnected"]);
    setCollabSocket(ws);
    return () => {
      setCollabSocket(null);
      ws.close();
    };
  }, []);

  useEffect(() => {
    if (!activeTaskId || !collabSocket || collabSocket.readyState !== WebSocket.OPEN) return;
    collabSocket.send(JSON.stringify({ type: "join_task", taskId: activeTaskId }));
  }, [activeTaskId, collabSocket]);

  const runTask = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || isRunning) return;

    setIsRunning(true);
    setStatus("running");
    setActiveTaskId("");
    setTimeline((prev) => [...prev, `You: ${trimmed}`]);

    const appendLine = (line: string) => {
      setTimeline((prev) => [...prev, line]);
    };

    const processSseChunk = (chunk: string, taskIdRef: { current: string }) => {
      const lines = chunk.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event: "));
      const dataLine = lines.find((l) => l.startsWith("data: "));
      const eventName = eventLine ? eventLine.slice(7).trim() : "unknown";
      const dataRaw = dataLine ? dataLine.slice(6) : "{}";
      let parsed: StepPayload = {};
      try {
        parsed = JSON.parse(dataRaw) as StepPayload;
      } catch {
        parsed = { content: dataRaw };
      }
      if (eventName === "task_started" && parsed.taskId) {
        taskIdRef.current = String(parsed.taskId);
        setActiveTaskId(taskIdRef.current);
      }
      const effectiveId = parsed.taskId || taskIdRef.current;
      const sock = collabRef.current;
      if (effectiveId && sock && sock.readyState === WebSocket.OPEN) {
        sock.send(
          JSON.stringify({
            type: "task_event",
            taskId: effectiveId,
            body: { event: eventName, content: parsed.content ?? parsed, origin: "mobile" }
          })
        );
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
        return parsed.content || dataRaw;
      })();
      appendLine(`Agent: ${eventName} -> ${contentText}`);
      return eventName === "task_completed";
    };

    try {
      const response = await fetch(`${ORCHESTRATOR_URL}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-actor-id": mobileActor,
          "x-workspace-id": mobileWorkspace,
          "x-role": "admin",
          "idempotency-key": `mobile:${Date.now()}`
        },
        body: JSON.stringify({
          prompt: `[${mode}] ${trimmed}`,
          sessionId: "mobile-session",
          maxRetries: 2
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const taskIdRef = { current: "" };
      let sawCompletion = false;

      if (!response.body) {
        const raw = await response.text();
        const eventChunks = raw.split("\n\n").filter(Boolean);
        for (const chunk of eventChunks) {
          if (processSseChunk(chunk, taskIdRef)) sawCompletion = true;
        }
      } else {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() || "";
          for (const part of chunks) {
            if (!part.trim()) continue;
            if (processSseChunk(part, taskIdRef)) sawCompletion = true;
          }
        }
      }

      setStatus(sawCompletion ? "completed" : "running");
    } catch (error) {
      setTimeline((prev) => [
        ...prev,
        `Agent (${mode}): queued execution pipeline`,
        `Offline fallback: ${String(error)}`
      ]);
      setStatus("offline fallback");
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <ScrollView style={styles.page} contentContainerStyle={styles.container}>
        <Text style={styles.eyebrow}>Manus Plus Mobile</Text>
        <Text style={styles.title}>Build on the go</Text>
        <Text style={styles.subtitle}>Prompt-first autonomous execution with live status.</Text>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Workspace identity</Text>
          <Text style={styles.fieldLabel}>Actor ID</Text>
          <TextInput
            value={mobileActor}
            onChangeText={setMobileActor}
            style={styles.lineInput}
            autoCapitalize="none"
            placeholderTextColor="#7f93b8"
          />
          <Text style={styles.fieldLabel}>Workspace ID</Text>
          <TextInput
            value={mobileWorkspace}
            onChangeText={setMobileWorkspace}
            style={styles.lineInput}
            autoCapitalize="none"
            placeholderTextColor="#7f93b8"
          />
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Prompt</Text>
          <TextInput
            value={prompt}
            onChangeText={setPrompt}
            multiline
            style={styles.input}
            placeholder="Describe what to build..."
            placeholderTextColor="#7f93b8"
          />
          <View style={styles.modesRow}>
            {quickModes.map((quickMode) => (
              <TouchableOpacity
                key={quickMode}
                style={[styles.modeChip, mode === quickMode && styles.modeChipActive]}
                onPress={() => setMode(quickMode)}
              >
                <Text style={styles.modeChipText}>{quickMode}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TouchableOpacity
            style={styles.runBtn}
            onPress={() => void runTask()}
            disabled={isRunning}
          >
            <Text style={styles.runBtnText}>{isRunning ? "Running..." : "Run"}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Status</Text>
          <Text style={styles.statusText}>{status}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Timeline</Text>
          <View style={styles.counterRow}>
            <Text style={styles.counterText}>Local {localCount}</Text>
            <Text style={styles.counterText}>Remote {remoteCount}</Text>
            <Text style={styles.counterText}>Deduped {dedupedCount}</Text>
            <TouchableOpacity
              style={styles.counterResetBtn}
              onPress={() => {
                setTimeline([]);
                setDedupedCount(0);
                seenRemoteRef.current.clear();
              }}
            >
              <Text style={styles.counterResetText}>Reset counters</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.counterResetBtn}
              onPress={() => {
                const snapshot = {
                  client: "mobile",
                  generatedAt: new Date().toISOString(),
                  status,
                  timelineScope,
                  localEventCount: localCount,
                  remoteEventCount: remoteCount,
                  dedupedRemoteCount: dedupedCount,
                  activeTaskId: activeTaskId || null
                };
                void Share.share({
                  title: "Manus Plus mobile telemetry",
                  message: JSON.stringify(snapshot, null, 2)
                });
              }}
            >
              <Text style={styles.counterResetText}>Export telemetry</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.filtersRow}>
            <TouchableOpacity style={[styles.filterChip, timelineScope === "all" && styles.filterChipActive]} onPress={() => setTimelineScope("all")}>
              <Text style={styles.filterText}>All</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.filterChip, timelineScope === "local" && styles.filterChipActive]} onPress={() => setTimelineScope("local")}>
              <Text style={styles.filterText}>Local</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.filterChip, timelineScope === "remote" && styles.filterChipActive]} onPress={() => setTimelineScope("remote")}>
              <Text style={styles.filterText}>Remote</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.bubbleYou}>
            <Text style={styles.bubbleText}>You: {prompt}</Text>
          </View>
          {timeline
            .filter((item) => {
              if (timelineScope === "all") return true;
              const isRemote = item.startsWith("Collab:") || item.startsWith("Realtime:");
              return timelineScope === "remote" ? isRemote : !isRemote;
            })
            .map((item, index) => (
            <View key={`${item}-${index}`} style={styles.bubbleAgent}>
              <Text style={styles.bubbleText}>{item}</Text>
            </View>
            ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#070a12" },
  page: { flex: 1 },
  container: { padding: 16, gap: 12 },
  eyebrow: { color: "#98abd3", fontSize: 12, textTransform: "uppercase", letterSpacing: 1.4 },
  title: { color: "#ecf2ff", fontSize: 34, lineHeight: 36, fontWeight: "700" },
  subtitle: { color: "#a7b8db", fontSize: 13, marginTop: -2 },
  card: {
    borderWidth: 1,
    borderColor: "#263451",
    borderRadius: 14,
    backgroundColor: "#101a2dd8",
    padding: 12,
    gap: 10
  },
  sectionTitle: { color: "#dce6fa", fontSize: 14, fontWeight: "600" },
  fieldLabel: { color: "#9db0d7", fontSize: 12, marginTop: 4 },
  lineInput: {
    borderWidth: 1,
    borderColor: "#344a72",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: "#ecf2ff",
    fontSize: 13,
    marginTop: 4
  },
  input: {
    borderWidth: 1,
    borderColor: "#344a72",
    borderRadius: 12,
    minHeight: 88,
    padding: 10,
    color: "#ecf2ff",
    textAlignVertical: "top"
  },
  modesRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  modeChip: {
    borderWidth: 1,
    borderColor: "#3e5988",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "#1a2b4a"
  },
  modeChipActive: { borderColor: "#7ea3df", backgroundColor: "#2a4f8f" },
  modeChipText: { color: "#d8e6ff", fontSize: 12, textTransform: "capitalize" },
  runBtn: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#6f95d8",
    backgroundColor: "#2a4f8f",
    paddingVertical: 10,
    alignItems: "center"
  },
  runBtnText: { color: "#f4f8ff", fontWeight: "600" },
  counterRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  counterText: {
    borderWidth: 1,
    borderColor: "#3b5688",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: "#142440",
    color: "#d8e6ff",
    fontSize: 11
  },
  counterResetBtn: {
    borderWidth: 1,
    borderColor: "#5f84c2",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: "#24437a"
  },
  counterResetText: { color: "#ecf3ff", fontSize: 11 },
  filtersRow: { flexDirection: "row", gap: 8 },
  filterChip: {
    borderWidth: 1,
    borderColor: "#3b5688",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: "#142440"
  },
  filterChipActive: { borderColor: "#7ea3df", backgroundColor: "#2a4f8f" },
  filterText: { color: "#d8e6ff", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.7 },
  statusText: {
    textTransform: "uppercase",
    color: "#b7cbf3",
    fontSize: 12,
    letterSpacing: 1
  },
  bubbleYou: {
    alignSelf: "flex-end",
    borderWidth: 1,
    borderColor: "#4a69a0",
    backgroundColor: "#172a4a",
    borderRadius: 12,
    padding: 10,
    maxWidth: "86%"
  },
  bubbleAgent: {
    borderWidth: 1,
    borderColor: "#2f4062",
    backgroundColor: "#111a2e",
    borderRadius: 12,
    padding: 10
  },
  bubbleText: { color: "#dce7ff", fontSize: 12, lineHeight: 17 }
});
