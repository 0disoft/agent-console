import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { appendFile, mkdir, rename, rm, stat as statAsync, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { configuredModel, configuredProvider, defaultCwd, host, port, root } from "./config";
import { statusPayload } from "./agents";
import type { CompletedRunStatus, RunResult, StatusPayload } from "./types";

export type RunKind = "chat" | "preset" | "update";
export type RunStatus = "running" | "waiting_input" | CompletedRunStatus | "stopped";

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
export const DEFAULT_RUN_HISTORY_LIMIT = 30;
export const MAX_RUN_HISTORY_LIMIT = 100;
const RUN_LOOKUP_LIMIT = 200;
const COMPLETED_RUN_CACHE_LIMIT = 100;
const LEDGER_TAIL_CHUNK_BYTES = 64 * 1024;
const LEDGER_TAIL_MAX_BYTES = 1024 * 1024;
const LEDGER_COMPACT_TRIGGER_BYTES = 2 * LEDGER_TAIL_MAX_BYTES;
const LEDGER_COMPACT_TARGET_LINES = RUN_LOOKUP_LIMIT;
const LEDGER_COMPACT_CHECK_INTERVAL_MS = 60_000;
const SSE_HEARTBEAT_MS = 15_000;
export const MAX_RUN_INPUT_CHARS = 100_000;
const ANSI_PATTERN = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const activeRuns = new Map<string, ActiveRun>();
const completedRuns: RunRecord[] = [];
const eventEncoder = new TextEncoder();
const eventClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const wsClients = new Set<ServerWebSocket<unknown>>();
let ledgerWriteQueue: Promise<void> = Promise.resolve();
let lastLedgerCompactCheck = 0;

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
    if (!run || run.record.status !== "running" || !run.input) return;
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
  const completedStatus = classifyRunResult(result);
  const record: RunRecord = {
    ...run.record,
    status: stopped ? "stopped" : completedStatus,
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
  rememberCompletedRun(record);
  void appendLedgerAsync(record).finally(() => {
    broadcastRunEvent("run:done", record);
  });
}

export function classifyRunResult(result: Pick<RunResult, "ok" | "stdout" | "stderr">): CompletedRunStatus {
  if (result.ok) return "ok";
  if (hasUsableStdout(result.stdout) && isPartialCompletionStderr(result.stderr)) {
    return "partial";
  }
  return "error";
}

function hasUsableStdout(stdout: string) {
  return stripControl(stdout || "").trim().length > 0;
}

function isPartialCompletionStderr(stderr: string) {
  const text = stripControl(stderr || "");
  return /Agent loop aborted by loop detector/i.test(text)
    || /Circuit breaker: tool 'shell' called/i.test(text)
    || /loop detector blocked tool call/i.test(text);
}

export function stopRun(id: string) {
  const run = activeRuns.get(id);
  if (!run) return false;
  run.controller.abort();
  broadcastRunEvent("run:stop-requested", run.record);
  return true;
}

export async function sendRunInput(id: string, text: string, options: { newline?: boolean } = {}) {
  const run = activeRuns.get(id);
  if (!run?.input) return false;
  const input = normalizeRunInput(text, options);
  if (input.length > MAX_RUN_INPUT_CHARS) return false;
  const ok = await run.input(input);
  if (activeRuns.get(id) !== run) return false;
  if (!ok) return false;
  run.record.status = "running";
  run.record.inputReady = true;
  run.record.inputCount = (run.record.inputCount || 0) + 1;
  run.record.lastInputAt = new Date().toISOString();
  broadcastRunEvent("run:input", {
    ...run.record,
    inputChars: input.length,
  });
  return true;
}

export function normalizeRunInput(text: string, options: { newline?: boolean } = {}) {
  const input = String(text || "");
  if (options.newline === false || input.endsWith("\n")) return input;
  return `${input}\n`;
}

export function listActiveRuns() {
  return Array.from(activeRuns.values()).map(({ record }) => ({ ...record }));
}

export function normalizeRunHistoryLimit(value: unknown, fallback = DEFAULT_RUN_HISTORY_LIMIT, max = MAX_RUN_HISTORY_LIMIT) {
  const parsed = typeof value === "number" ? value : Number(value ?? fallback);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export function listRecentRuns(limit: unknown = DEFAULT_RUN_HISTORY_LIMIT) {
  const normalizedLimit = normalizeRunHistoryLimit(limit);
  return sortedUniqueRuns([...readLedger(normalizedLimit), ...completedRuns, ...listActiveRuns()])
    .slice(-normalizedLimit)
    .reverse();
}

export function getRun(id: string) {
  const active = activeRuns.get(id);
  if (active) return { ...active.record };
  const completed = findCompletedRun(id);
  if (completed) return { ...completed };
  return readLedger(RUN_LOOKUP_LIMIT).reverse().find((record) => record.id === id) || null;
}

export async function snapshotPayload() {
  const status = await statusPayload();
  return {
    generatedAt: new Date().toISOString(),
    server: {
      host,
      port,
      model: configuredModel || null,
      provider: configuredProvider || null,
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
      }, SSE_HEARTBEAT_MS);
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
  let payload: { type?: string; runId?: string; text?: string; newline?: boolean } = {};
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
    sendWs(ws, "run:input-response", { runId: payload.runId, ok: await sendRunInput(payload.runId, text, { newline: payload.newline }) });
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

async function appendLedgerAsync(record: RunRecord) {
  const task = ledgerWriteQueue.then(
    () => appendLedgerRecordAsync(record),
    () => appendLedgerRecordAsync(record),
  );
  ledgerWriteQueue = task.catch(() => {});
  return task.catch((error) => {
    console.warn(`Run ledger append failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function appendLedgerRecordAsync(record: RunRecord) {
  await mkdir(stateDir, { recursive: true });
  await appendFile(ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
  await compactLedgerIfNeeded();
}

async function compactLedgerIfNeeded(now = Date.now()) {
  if (now - lastLedgerCompactCheck < LEDGER_COMPACT_CHECK_INTERVAL_MS) return;
  lastLedgerCompactCheck = now;
  const ledgerStat = await statAsync(ledgerPath).catch(() => null);
  if (!ledgerStat || ledgerStat.size <= LEDGER_COMPACT_TRIGGER_BYTES) return;

  const lines = readRecentLedgerLines(LEDGER_COMPACT_TARGET_LINES);
  if (!lines.length) return;

  const compactPath = `${ledgerPath}.compact-${process.pid}-${Date.now()}`;
  try {
    await writeFile(compactPath, `${lines.join("\n")}\n`, "utf8");
    await rename(compactPath, ledgerPath);
  } catch (error) {
    await rm(compactPath, { force: true }).catch(() => {});
    console.warn(`Run ledger compaction failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function broadcastRunEvent(event: string, data: unknown) {
  broadcastEvent(event, data);
  broadcastWs(event, data);
}

function broadcastEvent(event: string, data: unknown) {
  for (const client of eventClients) {
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
  for (const ws of wsClients) {
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
  const lines = stripControl(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-4);
  return lines.some((line) => (
    /(?:\[[YyNn]\/[YyNn]\]|\([YyNn]\/[YyNn]\)|\byes\/no\b)\s*[:?]?\s*$/.test(line)
    || /\b(?:continue|approve|permission)\b[^.\n]{0,80}[?:]\s*$/i.test(line)
    || /(?:승인|계속|입력)[^.\n]{0,80}(?:\?|:|하세요\.?)\s*$/.test(line)
  ));
}

function readLedger(limit: number) {
  try {
    if (!existsSync(ledgerPath)) return [];
    return readRecentLedgerLines(limit)
      .map(parseLedgerLine)
      .filter((record): record is RunRecord => Boolean(record));
  } catch {
    return [];
  }
}

function readRecentLedgerLines(limit: number, maxLimit = RUN_LOOKUP_LIMIT) {
  const normalizedLimit = normalizeRunHistoryLimit(limit, DEFAULT_RUN_HISTORY_LIMIT, maxLimit);
  let fd = -1;
  try {
    const stat = statSync(ledgerPath);
    fd = openSync(ledgerPath, "r");
    const chunks: Buffer[] = [];
    let position = stat.size;
    let bytesReadTotal = 0;
    let newlineCount = 0;
    let startsAtLineBoundary = true;

    if (position > 0) {
      const probe = Buffer.allocUnsafe(1);
      const probeBytes = readSync(fd, probe, 0, 1, position - 1);
      if (probeBytes > 0) {
        startsAtLineBoundary = probe[0] === 10 || probe[0] === 13;
      }
    }

    while (position > 0 && bytesReadTotal < LEDGER_TAIL_MAX_BYTES && newlineCount < normalizedLimit + 1) {
      const bytesToRead = Math.min(LEDGER_TAIL_CHUNK_BYTES, position, LEDGER_TAIL_MAX_BYTES - bytesReadTotal);
      const buffer = Buffer.allocUnsafe(bytesToRead);
      position -= bytesToRead;
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
      if (bytesRead <= 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      chunks.push(chunk);
      bytesReadTotal += bytesRead;
      newlineCount += countNewlines(chunk);
    }

    const text = Buffer.concat(chunks.reverse()).toString("utf8");
    const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
    if (!startsAtLineBoundary && lines.length > 0) lines.shift();
    return lines.slice(-normalizedLimit);
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

function parseLedgerLine(line: string) {
  try {
    const record = JSON.parse(line) as RunRecord;
    return record && typeof record.id === "string" ? record : null;
  } catch {
    console.warn("Skipping corrupted run ledger line.");
    return null;
  }
}

function rememberCompletedRun(record: RunRecord) {
  completedRuns.push({ ...record });
  if (completedRuns.length > COMPLETED_RUN_CACHE_LIMIT) {
    completedRuns.splice(0, completedRuns.length - COMPLETED_RUN_CACHE_LIMIT);
  }
}

function findCompletedRun(id: string) {
  for (let index = completedRuns.length - 1; index >= 0; index -= 1) {
    if (completedRuns[index].id === id) return completedRuns[index];
  }
  return null;
}

function sortedUniqueRuns(records: RunRecord[]) {
  const byId = new Map<string, RunRecord>();
  for (const record of records) {
    if (record?.id) byId.set(record.id, record);
  }
  return Array.from(byId.values()).sort((left, right) => runTimestamp(left) - runTimestamp(right));
}

function runTimestamp(record: RunRecord) {
  const value = Date.parse(record.endedAt || record.startedAt || "");
  return Number.isFinite(value) ? value : 0;
}

function stripControl(text: string) {
  return text.replace(ANSI_PATTERN, "");
}

function countNewlines(buffer: Buffer) {
  let count = 0;
  for (const byte of buffer) {
    if (byte === 10) count += 1;
  }
  return count;
}

function runId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
