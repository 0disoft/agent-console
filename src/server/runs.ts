import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { defaultCwd, defaultModel, defaultProvider, host, port, root } from "./config";
import { statusPayload } from "./agents";
import type { RunResult, StatusPayload } from "./types";

export type RunKind = "chat" | "preset" | "update";
export type RunStatus = "running" | "waiting_input" | "ok" | "error" | "stopped";

export type RunRecord = {
  id: string;
  kind: RunKind;
  status: RunStatus;
  label: string;
  agent?: string;
  target?: string;
  key?: string;
  cwd: string;
  command?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  ok?: boolean;
  code?: number | null;
  stdoutChars?: number;
  stderrChars?: number;
  inputReady?: boolean;
  inputCount?: number;
  lastInputAt?: string;
  error?: string;
};

type ActiveRun = {
  controller: AbortController;
  record: RunRecord;
  input?: (text: string) => Promise<boolean> | boolean;
};

const stateDir = join(root, ".agent-console");
const ledgerPath = join(stateDir, "runs.jsonl");
const activeRuns = new Map<string, ActiveRun>();
const eventEncoder = new TextEncoder();
const eventClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const wsClients = new Set<ServerWebSocket<unknown>>();

export function beginRun(input: {
  kind: RunKind;
  label: string;
  agent?: string;
  target?: string;
  key?: string;
  cwd?: string;
}) {
  const id = runId();
  const controller = new AbortController();
  const record: RunRecord = {
    id,
    kind: input.kind,
    status: "running",
    label: input.label,
    agent: input.agent,
    target: input.target,
    key: input.key,
    cwd: input.cwd || defaultCwd,
    startedAt: new Date().toISOString(),
  };
  activeRuns.set(id, { controller, record });
  broadcastRunEvent("run:start", record);
  return { id, controller, record };
}

export function attachRunStart(id: string) {
  return (event: { command: string; cwd: string }) => {
    const run = activeRuns.get(id);
    if (!run) return;
    run.record.command = event.command;
    run.record.cwd = event.cwd;
    broadcastRunEvent("run:command", run.record);
  };
}

export function attachRunInput(id: string) {
  return (sendInput: (text: string) => Promise<boolean> | boolean) => {
    const run = activeRuns.get(id);
    if (!run) return;
    run.input = sendInput;
    run.record.inputReady = true;
    broadcastRunEvent("run:input-ready", run.record);
  };
}

export function attachRunOutput(id: string) {
  return (event: { stream: "stdout" | "stderr"; text: string }) => {
    const run = activeRuns.get(id);
    if (!run || run.record.status !== "running") return;
    if (!looksLikeInputPrompt(event.text)) return;
    run.record.status = "waiting_input";
    run.record.inputReady = Boolean(run.input);
    broadcastRunEvent("run:waiting-input", run.record);
  };
}

export function attachRunDone(id: string) {
  return (result: RunResult) => {
    finishRun(id, result);
  };
}

export function finishRun(id: string, result: RunResult) {
  const run = activeRuns.get(id);
  if (!run) return;
  const endedAt = new Date();
  const startedAt = new Date(run.record.startedAt);
  const stopped = run.controller.signal.aborted;
  const record: RunRecord = {
    ...run.record,
    status: stopped ? "stopped" : result.ok ? "ok" : "error",
    endedAt: endedAt.toISOString(),
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    ok: result.ok,
    code: result.code,
    command: result.command || run.record.command,
    cwd: result.cwd || run.record.cwd,
    stdoutChars: result.stdout?.length || 0,
    stderrChars: result.stderr?.length || 0,
    error: result.ok ? "" : result.stderr || "",
  };
  activeRuns.delete(id);
  appendLedger(record);
  broadcastRunEvent("run:done", record);
}

export function stopRun(id: string) {
  const run = activeRuns.get(id);
  if (!run) return false;
  run.controller.abort();
  broadcastRunEvent("run:stop-requested", run.record);
  return true;
}

export async function sendRunInput(id: string, text: string) {
  const run = activeRuns.get(id);
  if (!run?.input) return false;
  const ok = await run.input(text);
  if (!ok) return false;
  run.record.status = "running";
  run.record.inputReady = true;
  run.record.inputCount = (run.record.inputCount || 0) + 1;
  run.record.lastInputAt = new Date().toISOString();
  broadcastRunEvent("run:input", {
    ...run.record,
    inputChars: text.length,
  });
  return true;
}

export function listActiveRuns() {
  return Array.from(activeRuns.values()).map(({ record }) => ({ ...record }));
}

export function listRecentRuns(limit = 30) {
  return [...readLedger(limit), ...listActiveRuns()].slice(-limit).reverse();
}

export function getRun(id: string) {
  const active = activeRuns.get(id);
  if (active) return { ...active.record };
  return readLedger(200).reverse().find((record) => record.id === id) || null;
}

export async function snapshotPayload() {
  const status = await statusPayload();
  return {
    generatedAt: new Date().toISOString(),
    server: {
      host,
      port,
      model: defaultModel,
      provider: defaultProvider,
      defaultCwd,
    },
    status,
    activeRuns: listActiveRuns(),
    recentRuns: listRecentRuns(10),
    issues: snapshotIssues(status),
  };
}

export function eventsResponse() {
  let client: ReadableStreamDefaultController<Uint8Array> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      client = controller;
      eventClients.add(controller);
      sendSse(controller, "hello", {
        generatedAt: new Date().toISOString(),
        activeRuns: listActiveRuns(),
      });
      heartbeat = setInterval(() => {
        if (!eventClients.has(controller)) {
          if (heartbeat) clearInterval(heartbeat);
          return;
        }
        sendSse(controller, "ping", { at: new Date().toISOString() });
      }, 1000);
    },
    cancel() {
      if (client) eventClients.delete(client);
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
    },
  });
}

export function upgradeWebSocket(server: Server, request: Request) {
  return server.upgrade(request);
}

export function registerWebSocket(ws: ServerWebSocket<unknown>) {
  wsClients.add(ws);
  sendWs(ws, "hello", {
    generatedAt: new Date().toISOString(),
    activeRuns: listActiveRuns(),
  });
}

export function unregisterWebSocket(ws: ServerWebSocket<unknown>) {
  wsClients.delete(ws);
}

export async function handleWebSocketMessage(ws: ServerWebSocket<unknown>, message: string | Buffer) {
  let payload: { type?: string; runId?: string; text?: string } = {};
  try {
    payload = JSON.parse(String(message));
  } catch {
    sendWs(ws, "error", { message: "Invalid JSON message" });
    return;
  }
  if (payload.type === "stop" && payload.runId) {
    sendWs(ws, "run:stop-response", { runId: payload.runId, ok: stopRun(payload.runId) });
    return;
  }
  if (payload.type === "input" && payload.runId) {
    const text = payload.text || "";
    sendWs(ws, "run:input-response", { runId: payload.runId, ok: await sendRunInput(payload.runId, text) });
    return;
  }
  if (payload.type === "snapshot") {
    sendWs(ws, "snapshot", await snapshotPayload());
    return;
  }
  sendWs(ws, "error", { message: `Unsupported message type: ${payload.type || ""}` });
}

function snapshotIssues(status: StatusPayload) {
  return Object.entries(status.tools)
    .filter(([, tool]) => !tool.installed || !tool.ok)
    .map(([name, tool]) => ({
      level: tool.installed ? "warning" : "error",
      code: tool.installed ? "TOOL_STATUS_NOT_OK" : "TOOL_NOT_INSTALLED",
      tool: name,
      message: tool.message || tool.summary || `${name} 상태 확인 필요`,
    }));
}

function appendLedger(record: RunRecord) {
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
  }
}

function broadcastRunEvent(event: string, data: unknown) {
  broadcastEvent(event, data);
  broadcastWs(event, data);
}

function broadcastEvent(event: string, data: unknown) {
  for (const client of Array.from(eventClients)) {
    sendSse(client, event, data);
  }
}

function sendSse(client: ReadableStreamDefaultController<Uint8Array>, event: string, data: unknown) {
  try {
    client.enqueue(eventEncoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  } catch {
    eventClients.delete(client);
  }
}

function broadcastWs(event: string, data: unknown) {
  for (const ws of Array.from(wsClients)) {
    sendWs(ws, event, data);
  }
}

function sendWs(ws: ServerWebSocket<unknown>, event: string, data: unknown) {
  try {
    ws.send(JSON.stringify({ event, data }));
  } catch {
    wsClients.delete(ws);
  }
}

function looksLikeInputPrompt(text: string) {
  return /(\[[YyNn]\/[YyNn]\]|\([YyNn]\/[YyNn]\)|\byes\/no\b|\bcontinue\?\b|\bapprove\b|\bpermission\b|승인|계속할까요|입력하세요)/i.test(text);
}

function readLedger(limit: number) {
  try {
    if (!existsSync(ledgerPath)) return [];
    const lines = readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).map((line) => JSON.parse(line) as RunRecord);
  } catch {
    return [];
  }
}

function runId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
