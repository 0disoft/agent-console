import { els } from "./dom.js";
import {
  append,
  appendBlock,
  applyOutputFilter,
  updateOutputBlock,
} from "./output.js";
import { state } from "./state.js";
import { rememberCwd, rememberPrompt } from "./storage.js";
import { agentName, stripAnsi } from "./text.js";
import { renderCwdHistory } from "./history.js";
import {
  firstRunningChatRequest,
  forgetChatRequest,
  renderRuns,
  renderStatus,
  requestLabel,
  selectedChatRequest,
  setButtonBusy,
  setChatRequestRunning,
  setRequestRunning,
} from "./ui.js";

let runsLoadTimer = 0;
let refreshTimer = 0;

export function abortActiveRequest() {
  const selectedChat = selectedChatRequest();
  if (selectedChat) {
    abortRequest(selectedChat, state.activeAgent);
    return true;
  }
  if (state.activeRequest) {
    abortRequest(state.activeRequest);
    return true;
  }
  const otherChat = firstRunningChatRequest();
  if (otherChat) {
    abortRequest(otherChat[1], otherChat[0]);
    return true;
  }
  return false;
}

function abortRequest(request, agent = "") {
  request.abortedByUser = true;
  state.abortedControllers.add(request.controller);
  request.controller.abort();
  appendBlock(`${agent ? `${agentName(agent)} ` : ""}요청 중단을 보냈습니다.`, "warning");
  if (agent) {
    setChatRequestRunning(agent, null, null);
  } else {
    setButtonBusy(request.button, false);
    setRequestRunning(null, null);
  }
}

export async function refresh() {
  setButtonBusy(els.refreshBtn, true);
  try {
    const res = await fetch("/api/status");
    renderStatus(await parseJsonResponse(res));
  } catch (error) {
    append(`상태 조회 실패\n${error}`);
  } finally {
    setButtonBusy(els.refreshBtn, false);
  }
}

export async function loadRuns() {
  setButtonBusy(els.refreshRunsBtn, true);
  try {
    const res = await fetch("/api/runs?limit=12");
    const data = await parseJsonResponse(res);
    renderRuns(Array.isArray(data.runs) ? data.runs : []);
  } catch (error) {
    appendBlock(`최근 실행 조회 실패\n${error}`, "error");
  } finally {
    setButtonBusy(els.refreshRunsBtn, false);
  }
}

export async function showSnapshot() {
  setButtonBusy(els.snapshotBtn, true);
  try {
    const res = await fetch("/api/snapshot");
    const data = await parseJsonResponse(res);
    els.snapshotBody.textContent = JSON.stringify(data, null, 2);
    if (typeof els.snapshotDialog.showModal === "function") {
      els.snapshotDialog.showModal();
    } else {
      els.snapshotDialog.setAttribute("open", "");
    }
    els.snapshotBody.focus();
  } catch (error) {
    appendBlock(`스냅샷 조회 실패\n${error}`, "error");
  } finally {
    setButtonBusy(els.snapshotBtn, false);
  }
}

export async function showRunDetails(id) {
  if (!id) return;
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(id)}`);
    const run = await parseJsonResponse(res);
    els.runDetailBody.textContent = formatRunDetail(run);
    if (typeof els.runDetailDialog.showModal === "function") {
      els.runDetailDialog.showModal();
    } else {
      els.runDetailDialog.setAttribute("open", "");
    }
    els.runDetailBody.focus();
  } catch (error) {
    appendBlock(`실행 상세 조회 실패\n${error}`, "error");
  }
}

export async function stopRun(id) {
  if (!id) return;
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(id)}/stop`, { method: "POST" });
    const data = await parseJsonResponse(res);
    if (!data.ok) appendBlock(`실행 중단 대상을 찾지 못했습니다: ${id}`, "warning");
    await loadRuns();
  } catch (error) {
    appendBlock(`실행 중단 실패\n${error}`, "error");
  }
}

export async function sendRunInput(id, text) {
  if (!id) return;
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(id)}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await parseJsonResponse(res);
    if (!data.ok) appendBlock(`stdin 전송 대상을 찾지 못했습니다: ${id}`, "warning");
    await loadRuns();
  } catch (error) {
    appendBlock(`stdin 전송 실패\n${error}`, "error");
  }
}

export async function openWorkingFolder() {
  const cwd = els.cwd.value.trim();
  if (!cwd) {
    els.cwd.classList.add("invalid");
    els.cwdStatus.textContent = "작업 폴더를 입력하세요.";
    els.cwd.focus();
    return;
  }
  els.openCwdBtn.disabled = true;
  els.openCwdBtn.classList.add("busy");
  els.openCwdBtn.setAttribute("aria-busy", "true");
  try {
    const res = await fetch("/api/open-cwd", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    const data = await parseJsonResponse(res);
    els.cwd.value = data.cwd || cwd;
    els.cwd.classList.remove("invalid");
    els.cwdStatus.textContent = "";
    rememberCwd(els.cwd.value, renderCwdHistory);
  } catch (error) {
    els.cwd.classList.add("invalid");
    els.cwdStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    els.openCwdBtn.disabled = false;
    els.openCwdBtn.classList.remove("busy");
    els.openCwdBtn.removeAttribute("aria-busy");
  }
}

export function scheduleCwdChildren(value) {
  const raw = String(value || "");
  if (state.cwdSuggestionTimer) {
    clearTimeout(state.cwdSuggestionTimer);
    state.cwdSuggestionTimer = 0;
  }
  state.cwdSuggestionController?.abort();
  if (!/[\\/]$/.test(raw) || raw.length < 2) {
    state.cwdSuggestions = [];
    renderCwdHistory();
    return;
  }
  const controller = new AbortController();
  state.cwdSuggestionController = controller;
  state.cwdSuggestionTimer = window.setTimeout(async () => {
    state.cwdSuggestionTimer = 0;
    try {
      const res = await fetch(`/api/cwd-children?cwd=${encodeURIComponent(raw)}`, {
        signal: controller.signal,
      });
      const data = await parseJsonResponse(res);
      if (controller.signal.aborted || els.cwd.value !== raw) return;
      state.cwdSuggestions = Array.isArray(data.directories) ? data.directories : [];
      renderCwdHistory();
    } catch {
      if (!controller.signal.aborted && els.cwd.value === raw) {
        state.cwdSuggestions = [];
        renderCwdHistory();
      }
    } finally {
      if (state.cwdSuggestionController === controller) {
        state.cwdSuggestionController = null;
      }
    }
  }, 120);
}

export function connectEvents() {
  if (state.eventsSocket || state.eventsController) return;
  if ("WebSocket" in window) {
    connectWebSocketEvents();
    return;
  }
  connectFetchEvents();
}

function connectWebSocketEvents() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/api/ws`);
  state.eventsSocket = socket;
  socket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      handleRunEvent(payload.event, payload.data);
    } catch {
    }
  });
  socket.addEventListener("close", () => {
    if (state.eventsSocket === socket) {
      state.eventsSocket = null;
      window.setTimeout(connectEvents, 3000);
    }
  });
  socket.addEventListener("error", () => {
    socket.close();
  });
}

function connectFetchEvents() {
  const controller = new AbortController();
  state.eventsController = controller;
  readEventStream(controller).catch(() => {}).finally(() => {
    if (state.eventsController === controller) {
      state.eventsController = null;
      window.setTimeout(connectEvents, 3000);
    }
  });
}

async function readEventStream(controller) {
  const res = await fetch("/api/events", { signal: controller.signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\n\n/);
    buffer = events.pop() || "";
    for (const eventText of events) handleSseEvent(eventText);
  }
}

function handleSseEvent(eventText) {
  const lines = eventText.split(/\n/);
  const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
  const dataText = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  let data = null;
  try {
    data = dataText ? JSON.parse(dataText) : null;
  } catch {
  }
  handleRunEvent(event, data);
  return data;
}

function handleRunEvent(event, data) {
  if (event === "hello" || event === "run:start" || event === "run:command" || event === "run:input-ready" || event === "run:waiting-input" || event === "run:input" || event === "run:stop-requested") {
    scheduleLoadRuns();
  }
  if (event === "run:done") {
    scheduleLoadRuns();
    scheduleRefresh();
  }
}

export async function postJson(path, payload, button) {
  if (path === "/api/chat") {
    if (state.activeChatRequests[payload.agent]) {
      appendBlock(`${agentName(payload.agent)} 요청이 이미 실행 중입니다. 해당 탭에서 중단하거나 완료를 기다려주세요.`, "warning");
      return;
    }
    const validCwd = await ensureValidCwdBeforeSend();
    if (!validCwd) return;
    payload.cwd = validCwd;
    return postStreamJson("/api/chat-stream", payload, button);
  }
  if (state.activeRequest) {
    appendBlock("다른 요청이 실행 중입니다. Esc 또는 중단 버튼으로 먼저 멈출 수 있습니다.", "warning");
    return;
  }
  const controller = new AbortController();
  const startedAt = Date.now();
  if (payload.cwd) rememberCwd(payload.cwd, renderCwdHistory);
  requestNotificationPermission();
  setRequestRunning(controller, button, requestLabel(path, payload));
  setButtonBusy(button, true);
  const block = appendBlock(`${payload.agent ? agentName(payload.agent) : "관리 작업"} 요청을 보냈습니다.`, "running", undefined, false);
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await parseJsonResponse(res);
    const body = [
      data.command ? `명령: ${data.command}` : "",
      data.cwd ? `폴더: ${data.cwd}` : "",
      data.stdout || "",
      data.stderr ? `${commandResultState(data).stderrLabel}:\n${data.stderr}` : "",
      data.code !== undefined && data.code !== null ? `종료 코드: ${data.code}` : "",
    ].filter(Boolean).join("\n\n");
    const resultState = commandResultState(data);
    updateOutputBlock(block, body || JSON.stringify(data, null, 2), resultState.type, resultState.label);
    notifyCompletion(resultState.notificationTitle, `${payload.agent ? agentName(payload.agent) : "관리 작업"} 실행이 끝났습니다.`, startedAt);
  } catch (error) {
    const abortedByUser = state.abortedControllers.has(controller);
    if (!(controller.signal.aborted && abortedByUser)) {
      updateOutputBlock(block, controller.signal.aborted ? "요청이 중단되었습니다." : `요청 실패\n${error}`, controller.signal.aborted ? "warning" : "error");
    } else {
      updateOutputBlock(block, "요청이 중단되었습니다.", "warning");
    }
    notifyCompletion("Agent Console 중단", controller.signal.aborted ? "요청이 중단되었습니다." : "요청이 실패했습니다.", startedAt);
  } finally {
    setButtonBusy(button, false);
    if (state.activeRequest?.controller === controller) {
      setRequestRunning(null, null);
    }
  }
}

async function postStreamJson(path, payload, button) {
  const agent = payload.agent || state.activeAgent;
  if (state.activeChatRequests[agent]) {
    appendBlock(`${agentName(agent)} 요청이 이미 실행 중입니다. 해당 탭에서 중단하거나 완료를 기다려주세요.`, "warning");
    return;
  }
  const controller = new AbortController();
  const startedAt = Date.now();
  let command = "";
  let cwdValue = payload.cwd || "";
  let stdout = "";
  let stderr = "";
  let finalData = null;
  let streamFlushId = 0;
  if (payload.cwd) rememberCwd(payload.cwd, renderCwdHistory);
  if (payload.prompt) rememberPrompt(payload.prompt, state);
  requestNotificationPermission();
  setChatRequestRunning(agent, controller, button, requestLabel("/api/chat", payload));
  const block = appendBlock("", "running", "실시간 출력", false);
  const bodyNode = block.querySelector(".output-body");
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(await responseErrorMessage(res));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        parseStreamLine(line, handleStreamEvent);
      }
    }
    buffer += decoder.decode();
    parseStreamLine(buffer, handleStreamEvent);
    cancelStreamFlush();
    const resultState = commandResultState({ ...finalData, stdout, stderr });
    const resultText = formatStreamResult(finalData, command, cwdValue, stdout, stderr, resultState);
    updateOutputBlock(block, resultText, resultState.type, resultState.label);
    notifyCompletion(resultState.notificationTitle, `${agentName(payload.agent)} 실행이 끝났습니다.`, startedAt);
  } catch (error) {
    const abortedByUser = state.abortedControllers.has(controller);
    if (!(controller.signal.aborted && abortedByUser)) {
      const errorText = controller.signal.aborted ? "요청이 중단되었습니다." : `요청 실패\n${error}`;
      cancelStreamFlush();
      updateOutputBlock(block, errorText, controller.signal.aborted ? "warning" : "error", controller.signal.aborted ? "알림" : "오류");
    } else {
      const partialText = formatStreamResult({ code: null, ok: false }, command, cwdValue, stdout, `${stderr}${stderr ? "\n" : ""}[사용자에 의해 중단됨]`);
      const stoppedText = partialText || "[사용자에 의해 중단됨]";
      cancelStreamFlush();
      updateOutputBlock(block, stoppedText, "warning", "중단됨");
    }
    notifyCompletion("Agent Console 중단", controller.signal.aborted ? "요청이 중단되었습니다." : "요청이 실패했습니다.", startedAt);
  } finally {
    forgetChatRequest(agent, controller);
  }

  function handleStreamEvent(event) {
    if (event.type === "start") {
      command = event.command || command;
      cwdValue = event.cwd || cwdValue;
    } else if (event.type === "heartbeat") {
      return;
    } else if (event.type === "stdout") {
      stdout += event.text || "";
    } else if (event.type === "stderr") {
      stderr += event.text || "";
    } else if (event.type === "done") {
      finalData = event;
      if (event.stderr) stderr += event.stderr;
    }
    scheduleStreamFlush();
  }

  function scheduleStreamFlush() {
    if (streamFlushId) return;
    streamFlushId = requestAnimationFrame(() => {
      const visibleText = stripAnsi([stdout, stderr ? `\n오류:\n${stderr}` : ""].filter(Boolean).join(""));
      bodyNode.textContent = visibleText;
      block.dataset.outputText = visibleText;
      block.dataset.searchText = `실시간 출력\n${visibleText}`.toLowerCase();
      applyOutputFilter();
      if (state.outputPinned) els.output.scrollTop = 0;
      streamFlushId = 0;
    });
  }

  function cancelStreamFlush() {
    if (!streamFlushId) return;
    cancelAnimationFrame(streamFlushId);
    streamFlushId = 0;
  }
}

function scheduleLoadRuns() {
  if (runsLoadTimer) return;
  runsLoadTimer = window.setTimeout(() => {
    runsLoadTimer = 0;
    loadRuns();
  }, 160);
}

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = 0;
    refresh();
  }, 250);
}

function parseStreamLine(line, onEvent) {
  if (!line.trim()) return;
  try {
    onEvent(JSON.parse(line));
  } catch (error) {
    console.warn("Skipping malformed stream line", error);
  }
}

export async function validateCwd() {
  const value = els.cwd.value.trim();
  if (!value) {
    els.cwd.classList.add("invalid");
    els.cwdStatus.textContent = "작업 폴더를 입력하세요.";
    return "";
  }
  state.cwdValidateController?.abort();
  const controller = new AbortController();
  state.cwdValidateController = controller;
  const validationPromise = (async () => {
    const res = await fetch("/api/validate-cwd", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: value }),
      signal: controller.signal,
    });
    const data = await parseJsonResponse(res);
    if (controller.signal.aborted || els.cwd.value.trim() !== value) return;
    els.cwd.classList.toggle("invalid", !data.ok);
    els.cwdStatus.textContent = data.ok ? "" : (data.stderr || "작업 폴더를 확인하세요.");
    if (data.ok) {
      rememberCwd(data.cwd || value, renderCwdHistory);
    }
    return data.ok ? (data.cwd || value) : "";
  })();
  state.cwdValidatePromise = validationPromise;
  try {
    return await validationPromise;
  } catch (error) {
    if (controller.signal.aborted) return;
    els.cwd.classList.add("invalid");
    els.cwdStatus.textContent = error instanceof Error ? error.message : String(error);
    return "";
  } finally {
    if (state.cwdValidateController === controller) {
      state.cwdValidateController = null;
    }
    if (state.cwdValidatePromise === validationPromise) {
      state.cwdValidatePromise = null;
    }
  }
}

function formatStreamResult(data, command, cwdValue, stdout, stderr, state = commandResultState({ ...data, stdout, stderr })) {
  return stripAnsi([
    command ? `명령: ${command}` : "",
    cwdValue ? `폴더: ${cwdValue}` : "",
    stdout || "",
    stderr ? `${state.stderrLabel}:\n${stderr}` : "",
    data?.code !== undefined && data?.code !== null ? `종료 코드: ${data.code}` : "",
  ].filter(Boolean).join("\n\n"));
}

function commandResultState(data = {}) {
  if (data.ok) {
    return {
      type: "ok",
      label: "완료",
      stderrLabel: "보조 출력",
      notificationTitle: "Agent Console 완료",
    };
  }
  if (hasUsableStdout(data.stdout) && isPartialCompletionStderr(data.stderr)) {
    return {
      type: "partial",
      label: "부분 완료",
      stderrLabel: "주의",
      notificationTitle: "Agent Console 부분 완료",
    };
  }
  return {
    type: "error",
    label: "오류",
    stderrLabel: "오류",
    notificationTitle: "Agent Console 오류",
  };
}

function hasUsableStdout(stdout) {
  return stripAnsi(String(stdout || "")).trim().length > 0;
}

function isPartialCompletionStderr(stderr) {
  const text = stripAnsi(String(stderr || ""));
  return /Agent loop aborted by loop detector/i.test(text)
    || /Circuit breaker: tool 'shell' called/i.test(text)
    || /loop detector blocked tool call/i.test(text);
}

function formatRunDetail(run) {
  const lines = [
    `ID: ${run.id || ""}`,
    `상태: ${run.status || ""}`,
    `종류: ${run.kind || ""}`,
    run.agent ? `에이전트: ${agentName(run.agent)}` : "",
    run.target ? `대상: ${run.target}` : "",
    run.key ? `작업: ${run.key}` : "",
    run.startedAt ? `시작: ${new Date(run.startedAt).toLocaleString()}` : "",
    run.endedAt ? `종료: ${new Date(run.endedAt).toLocaleString()}` : "",
    run.durationMs !== undefined ? `소요: ${Math.round(run.durationMs / 1000)}s` : "",
    run.cwd ? `폴더: ${run.cwd}` : "",
    run.command ? `명령: ${run.command}` : "",
    run.code !== undefined && run.code !== null ? `종료 코드: ${run.code}` : "",
    run.stdoutChars !== undefined ? `stdout 문자 수: ${run.stdoutChars}` : "",
    run.stderrChars !== undefined ? `stderr 문자 수: ${run.stderrChars}` : "",
    run.inputReady ? `stdin: 사용 가능` : "",
    run.inputCount ? `stdin 전송: ${run.inputCount}회` : "",
    run.error ? `\n오류:\n${run.error}` : "",
  ].filter(Boolean);
  lines.push("\n원문 JSON:");
  lines.push(JSON.stringify(run, null, 2));
  return lines.join("\n");
}

async function ensureValidCwdBeforeSend() {
  if (state.cwdValidatePromise) {
    const pending = await state.cwdValidatePromise;
    if (pending) return pending;
  }
  return await validateCwd();
}

export async function parseJsonResponse(res) {
  let data = null;
  try {
    data = await res.json();
  } catch {
  }
  if (!res.ok) {
    throw new Error(data?.stderr || data?.message || `HTTP ${res.status}`);
  }
  return data || {};
}

async function responseErrorMessage(res) {
  try {
    const data = await res.json();
    return data?.stderr || data?.message || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function requestNotificationPermission() {
  if (!("Notification" in window) || Notification.permission !== "default") return;
  Notification.requestPermission().catch(() => {});
}

function notifyCompletion(title, message, startedAt) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const elapsed = Date.now() - startedAt;
  if (!document.hidden && elapsed < 8000) return;
  new Notification(title, {
    body: message,
    tag: "agent-console",
    silent: false,
  });
}
