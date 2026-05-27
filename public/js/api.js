import { els } from "./dom.js";
import {
  append,
  appendBlock,
  persistOutputHistory,
  renderOutputText,
  truncateStoredText,
} from "./output.js";
import { maxOutputBlocks, state } from "./state.js";
import { rememberCwd, rememberPrompt } from "./storage.js";
import { agentName, stripAnsi } from "./text.js";
import { renderCwdHistory } from "./history.js";
import { renderRuns, renderStatus, requestLabel, setButtonBusy, setRequestRunning } from "./ui.js";

export function abortActiveRequest() {
  if (!state.activeRequest) return false;
  state.activeRequest.abortedByUser = true;
  state.abortedControllers.add(state.activeRequest.controller);
  state.activeRequest.controller.abort();
  appendBlock("요청 중단을 보냈습니다.", "warning");
  setButtonBusy(state.activeRequest.button, false);
  setRequestRunning(null, null);
  return true;
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
  } catch (error) {
    appendBlock(`스냅샷 조회 실패\n${error}`, "error");
  } finally {
    setButtonBusy(els.snapshotBtn, false);
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
    loadRuns();
  }
  if (event === "run:done") {
    loadRuns();
    refresh();
  }
}

export async function postJson(path, payload, button) {
  if (path === "/api/chat") {
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
  appendBlock(`${payload.agent ? agentName(payload.agent) : "관리 작업"} 요청을 보냈습니다.`, "running", undefined, false);
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
      data.stderr ? `${data.ok ? "보조 출력" : "오류"}:\n${data.stderr}` : "",
      data.code !== undefined && data.code !== null ? `종료 코드: ${data.code}` : "",
    ].filter(Boolean).join("\n\n");
    appendBlock(body || JSON.stringify(data, null, 2), data.ok ? "ok" : "error");
    notifyCompletion(data.ok ? "Agent Console 완료" : "Agent Console 오류", `${payload.agent ? agentName(payload.agent) : "관리 작업"} 실행이 끝났습니다.`, startedAt);
  } catch (error) {
    const abortedByUser = state.abortedControllers.has(controller);
    if (!(controller.signal.aborted && abortedByUser)) {
      appendBlock(controller.signal.aborted ? "요청이 중단되었습니다." : `요청 실패\n${error}`, controller.signal.aborted ? "warning" : "error");
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
  if (state.activeRequest) {
    appendBlock("다른 요청이 실행 중입니다. Esc 또는 중단 버튼으로 먼저 멈출 수 있습니다.", "warning");
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
  setRequestRunning(controller, button, requestLabel("/api/chat", payload));
  setButtonBusy(button, true);
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
        if (line.trim()) handleStreamEvent(JSON.parse(line));
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleStreamEvent(JSON.parse(buffer));
    cancelStreamFlush();
    const resultText = formatStreamResult(finalData, command, cwdValue, stdout, stderr);
    block.className = `output-block ${finalData?.ok ? "ok" : "error"}`;
    const labelNode = block.querySelector(".output-head > span");
    if (labelNode) labelNode.textContent = finalData?.ok ? "완료" : "오류";
    renderOutputText(bodyNode, resultText);
    state.outputHistory.push({
      type: finalData?.ok ? "ok" : "error",
      label: finalData?.ok ? "완료" : "오류",
      stamp: new Date().toLocaleTimeString(),
      text: truncateStoredText(resultText),
    });
    state.outputHistory = state.outputHistory.slice(-maxOutputBlocks);
    persistOutputHistory();
    notifyCompletion(finalData?.ok ? "Agent Console 완료" : "Agent Console 오류", `${agentName(payload.agent)} 실행이 끝났습니다.`, startedAt);
  } catch (error) {
    const abortedByUser = state.abortedControllers.has(controller);
    if (!(controller.signal.aborted && abortedByUser)) {
      block.className = "output-block error";
      const errorText = controller.signal.aborted ? "요청이 중단되었습니다." : `요청 실패\n${error}`;
      cancelStreamFlush();
      renderOutputText(bodyNode, errorText);
      state.outputHistory.push({
        type: controller.signal.aborted ? "warning" : "error",
        label: controller.signal.aborted ? "알림" : "오류",
        stamp: new Date().toLocaleTimeString(),
        text: truncateStoredText(errorText),
      });
      state.outputHistory = state.outputHistory.slice(-maxOutputBlocks);
      persistOutputHistory();
    } else {
      const partialText = formatStreamResult({ code: null, ok: false }, command, cwdValue, stdout, `${stderr}${stderr ? "\n" : ""}[사용자에 의해 중단됨]`);
      block.className = "output-block warning";
      const stoppedText = partialText || "[사용자에 의해 중단됨]";
      cancelStreamFlush();
      renderOutputText(bodyNode, stoppedText);
      state.outputHistory.push({
        type: "warning",
        label: "중단됨",
        stamp: new Date().toLocaleTimeString(),
        text: truncateStoredText(stoppedText),
      });
      state.outputHistory = state.outputHistory.slice(-maxOutputBlocks);
      persistOutputHistory();
    }
    notifyCompletion("Agent Console 중단", controller.signal.aborted ? "요청이 중단되었습니다." : "요청이 실패했습니다.", startedAt);
  } finally {
    setButtonBusy(button, false);
    if (state.activeRequest?.controller === controller) {
      setRequestRunning(null, null);
    }
  }

  function handleStreamEvent(event) {
    if (event.type === "start") {
      command = event.command || command;
      cwdValue = event.cwd || cwdValue;
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
      bodyNode.textContent = stripAnsi([stdout, stderr ? `\n오류:\n${stderr}` : ""].filter(Boolean).join(""));
      if (state.outputPinned) els.output.scrollTop = els.output.scrollHeight;
      streamFlushId = 0;
    });
  }

  function cancelStreamFlush() {
    if (!streamFlushId) return;
    cancelAnimationFrame(streamFlushId);
    streamFlushId = 0;
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

function formatStreamResult(data, command, cwdValue, stdout, stderr) {
  return stripAnsi([
    command ? `명령: ${command}` : "",
    cwdValue ? `폴더: ${cwdValue}` : "",
    stdout || "",
    stderr ? `${data?.ok ? "보조 출력" : "오류"}:\n${stderr}` : "",
    data?.code !== undefined && data?.code !== null ? `종료 코드: ${data.code}` : "",
  ].filter(Boolean).join("\n\n"));
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
