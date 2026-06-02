import { els } from "./dom.js";
import { state } from "./state.js";
import { agentName, speedName } from "./text.js";

export function setButtonBusy(button, busy) {
  if (!button) return;
  if (busy) {
    button.dataset.originalHtml = button.dataset.originalHtml || button.innerHTML;
    button.classList.add("busy");
    button.innerHTML = '<span class="spinner"></span><span>처리 중...</span>';
  } else if (button.dataset.originalHtml) {
    button.innerHTML = button.dataset.originalHtml;
    button.classList.remove("busy");
  }
  button.disabled = busy;
}

export function setRequestRunning(controller, button, label = "작업") {
  state.activeRequest = controller ? { controller, button, label, startedAt: Date.now() } : null;
  syncRequestTimer();
  renderRequestControls();
}

export function setChatRequestRunning(agent, controller, button, label = "작업") {
  if (!agent) return;
  if (controller) {
    state.activeChatRequests[agent] = { controller, button, label, startedAt: Date.now() };
  } else {
    delete state.activeChatRequests[agent];
  }
  syncRequestTimer();
  renderRequestControls();
}

export function selectedChatRequest() {
  return state.activeChatRequests[state.activeAgent] || null;
}

export function firstRunningChatRequest() {
  return runningChatEntries()[0] || null;
}

export function renderRequestControls() {
  const selectedChat = selectedChatRequest();
  const chatEntries = runningChatEntries();
  const installed = state.installedTools[state.activeAgent] !== false;
  const requestForStop = selectedChat || state.activeRequest || chatEntries[0]?.[1] || null;

  setStopControls(Boolean(requestForStop));

  if (selectedChat) {
    setButtonBusy(els.sendBtn, true);
    renderActiveRequest(selectedChat);
    return;
  }

  setButtonBusy(els.sendBtn, false);
  els.sendBtn.disabled = !installed;

  if (state.activeRequest) {
    renderActiveRequest(state.activeRequest);
    return;
  }

  if (chatEntries.length) {
    const [agent, request] = chatEntries[0];
    renderRunBanner(otherChatLabel(agent, chatEntries), elapsedSeconds(request));
    els.runStatus.textContent = `${chatEntries.length}개`;
    return;
  }

  els.runStatus.textContent = "대기";
  els.activeRunBanner.hidden = true;
  delete els.activeRunBanner.dataset.label;
  els.activeRunBanner.replaceChildren();
}

function syncRequestTimer() {
  const hasRunningRequest = Boolean(state.activeRequest) || runningChatEntries().length > 0;
  if (state.runTimer) {
    clearInterval(state.runTimer);
    state.runTimer = null;
  }
  if (hasRunningRequest) {
    state.runTimer = setInterval(renderRequestControls, 1000);
  }
}

function setStopControls(enabled) {
  els.stopBtn.disabled = !enabled;
  els.inlineStopBtn.disabled = !enabled;
  els.inlineStopBtn.classList.toggle("active", enabled);
}

function renderActiveRequest(request) {
  const seconds = elapsedSeconds(request);
  els.runStatus.textContent = `${seconds}s`;
  renderRunBanner(request.label, seconds);
}

function elapsedSeconds(request) {
  return Math.max(0, Math.floor((Date.now() - request.startedAt) / 1000));
}

function runningChatEntries() {
  return Object.entries(state.activeChatRequests).filter(([, request]) => Boolean(request?.controller));
}

function otherChatLabel(agent, entries) {
  const names = entries.map(([id]) => agentDisplayName(id));
  if (entries.length === 1) return `다른 실행 중: ${agentDisplayName(agent)}`;
  return `다른 실행 ${entries.length}개: ${names.join(", ")}`;
}

export function forgetChatRequest(agent, controller) {
  if (state.activeChatRequests[agent]?.controller !== controller) {
    return;
  }
  setChatRequestRunning(agent, null, null);
}

export function renderRunBanner(label, seconds) {
  if (els.activeRunBanner.dataset.label === label) {
    const timeNode = els.activeRunBanner.querySelector(".run-banner-time");
    if (timeNode) {
      timeNode.textContent = `${seconds}s 경과`;
      els.activeRunBanner.hidden = false;
      return;
    }
  }
  const spin = document.createElement("span");
  spin.className = "spinner";
  const title = document.createElement("strong");
  title.textContent = label;
  const time = document.createElement("span");
  time.className = "run-banner-time";
  time.textContent = `${seconds}s 경과`;
  els.activeRunBanner.replaceChildren(spin, title, time);
  els.activeRunBanner.dataset.label = label;
  els.activeRunBanner.hidden = false;
}

export function renderStatus(data) {
  if (!state.cwdTouched && data.cwd) {
    els.cwd.value = data.cwd;
  }
  const tools = data.tools || {};
  state.agents = Array.isArray(data.agents)
    ? data.agents
    : Object.keys(tools).map((id) => ({ id, label: agentName(id), supportsChat: true, supportsUpdate: id in tools, supportsThinking: id === "pi" }));
  state.presets = Array.isArray(data.presets) ? data.presets : [];
  state.installedTools = Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, Boolean(tool.installed)]));
  if (!state.agents.some((agent) => agent.id === state.activeAgent && agent.supportsChat)) {
    state.activeAgent = state.agents.find((agent) => agent.supportsChat)?.id || state.activeAgent;
  }
  const entries = Object.entries(tools);
  els.statusList.replaceChildren(...(entries.length
    ? entries.map(([name, tool]) => statusSummaryRow(name, tool))
    : [emptyState("에이전트 상태가 없습니다.")]));
  renderAgentChoices();
  renderManagementButtons();
  updateInstallState();
  updateAgentUi();
}

export function renderRuns(runs) {
  if (!els.runList) return;
  if (!runs.length) {
    const empty = document.createElement("div");
    empty.className = "muted run-empty";
    empty.textContent = "아직 실행 기록이 없습니다.";
    els.runList.replaceChildren(empty);
    return;
  }
  els.runList.replaceChildren(...runs.map(runRow));
}

export function updateAgentUi() {
  const agent = agentMeta(state.activeAgent);
  const usesCustomThinking = Boolean(agent?.supportsThinking) && els.speed.value === "deep";
  els.thinkingField.hidden = !usesCustomThinking;
  els.thinkingLabel.textContent = usesCustomThinking ? `${agent?.label || agentName(state.activeAgent)} 생각 수준` : "";
  els.promptBox.placeholder = `${agent?.label || agentName(state.activeAgent)}에게 보낼 요청을 입력`;
  document.querySelectorAll(".agentChoice").forEach((button) => {
    const selected = button.dataset.agent === state.activeAgent;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
    button.tabIndex = selected ? 0 : -1;
  });
  renderRequestControls();
}

export function updateInstallState() {
  const updateableInstalledCount = state.agents
    .filter((agent) => agent.supportsUpdate)
    .filter((agent) => state.installedTools[agent.id] !== false)
    .length;
  document.querySelectorAll("[data-update]").forEach((button) => {
    const target = button.dataset.update;
    const agent = state.agents.find((item) => item.id === target);
    const enabled = target === "all"
      ? updateableInstalledCount > 0
      : Boolean(agent?.supportsUpdate) && state.installedTools[target] !== false;
    button.disabled = !enabled;
    button.title = enabled ? "" : "업데이트 가능한 설치 항목을 찾지 못했습니다.";
  });
  document.querySelectorAll("[data-preset]").forEach((button) => {
    const enabled = presetEnabled(button.dataset.preset);
    button.disabled = !enabled;
    button.title = enabled ? "" : "설치된 실행 파일을 찾지 못했습니다.";
  });
  document.querySelectorAll(".agentChoice").forEach((button) => {
    const enabled = state.installedTools[button.dataset.agent] !== false;
    button.disabled = !enabled;
    button.title = enabled ? "" : "설치된 실행 파일을 찾지 못했습니다.";
  });
  if (state.installedTools[state.activeAgent] === false) {
    const next = state.agents.find((agent) => agent.supportsChat && state.installedTools[agent.id] !== false)?.id;
    if (next) selectAgent(next);
  }
  renderRequestControls();
}

export function selectAgent(agent, focus = false) {
  state.activeAgent = agent;
  updateAgentUi();
  if (focus) {
    document.querySelector(`.agentChoice[data-agent="${agent}"]`)?.focus();
  }
}

export function moveFocusWithin(container, columns, delta) {
  const controls = Array.from(container.querySelectorAll('summary, button:not([hidden]):not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), .output-list[tabindex="0"]'))
    .filter((item) => item.offsetParent !== null || item === els.output);
  const current = document.activeElement;
  const index = controls.indexOf(current);
  if (index === -1) {
    controls[0]?.focus();
    return;
  }
  const next = Math.max(0, Math.min(controls.length - 1, index + delta));
  controls[next]?.focus();
}

export function autoGrowPrompt() {
  els.promptBox.style.height = "auto";
  els.promptBox.style.height = `${Math.min(Math.max(els.promptBox.scrollHeight, 72), 240)}px`;
}

export function requestLabel(path, payload) {
  if (path === "/api/chat") return `${agentDisplayName(payload.agent)} · ${speedName(payload.speed)}`;
  if (path === "/api/update") return payload.target === "all" ? "전체 업데이트" : `${agentDisplayName(payload.target)} 업데이트`;
  if (path === "/api/preset") return "관리 작업";
  return "작업";
}

function presetEnabled(key) {
  const preset = state.presets.find((item) => item.key === key);
  if (!preset) return false;
  const agents = Array.isArray(preset.agents)
    ? preset.agents
    : preset.agent
      ? [preset.agent]
      : [];
  if (!agents.length) return true;
  const installed = agents.map((agent) => state.installedTools[agent] !== false);
  return preset.require === "any" ? installed.some(Boolean) : installed.every(Boolean);
}

function renderAgentChoices() {
  const chatAgents = state.agents.filter((agent) => agent.supportsChat);
  els.agentTabs.style.gridTemplateColumns = `repeat(${Math.max(1, chatAgents.length)}, 1fr)`;
  els.agentTabs.replaceChildren(...chatAgents.map((agent) => {
    const button = document.createElement("button");
    button.className = "agentChoice";
    button.dataset.agent = agent.id;
    button.type = "button";
    button.role = "tab";
    button.textContent = agent.label;
    return button;
  }));
}

function renderManagementButtons() {
  const updateButtons = state.agents
    .filter((agent) => agent.supportsUpdate)
    .map((agent) => actionButton(`${agent.label} 업데이트`, "update", agent.id));
  const presetButtons = state.presets.map((preset) => actionButton(preset.label, "preset", preset.key));
  els.presetGrid.replaceChildren(...updateButtons, ...presetButtons);
}

function actionButton(label, kind, value) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.dataset[kind] = value;
  return button;
}

function runRow(run) {
  const row = document.createElement("div");
  row.className = `run-row ${run.status || "running"}`;
  row.dataset.runId = run.id;
  row.tabIndex = 0;
  row.role = "button";
  row.setAttribute("aria-label", `${runTitle(run)} 상세 보기`);

  const main = document.createElement("div");
  main.className = "run-main";

  const title = document.createElement("strong");
  title.textContent = runTitle(run);

  const meta = document.createElement("span");
  meta.className = "muted";
  meta.textContent = runMeta(run);

  main.append(title, meta);
  row.append(runStatusBadge(run.status), main);

  if (run.status === "running") {
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "compact secondary-danger";
    stop.dataset.runStop = run.id;
    stop.textContent = "중단";
    row.append(stop);
  }
  if ((run.status === "running" || run.status === "waiting_input") && run.inputReady) {
    row.append(runInputRow(run));
  }
  return row;
}

function runInputRow(run) {
  const wrap = document.createElement("div");
  wrap.className = "run-input";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = run.status === "waiting_input" ? "승인/응답 입력 후 Enter" : "stdin으로 보낼 텍스트";
  input.dataset.runInputText = run.id;

  const send = document.createElement("button");
  send.type = "button";
  send.className = "compact";
  send.dataset.runInput = run.id;
  send.textContent = "전송";

  wrap.append(input, send);
  return wrap;
}

function runStatusBadge(status) {
  const badge = document.createElement("span");
  badge.className = `run-badge ${status || "running"}`;
  badge.textContent = runStatusLabel(status);
  return badge;
}

function runStatusLabel(status) {
  if (status === "ok") return "완료";
  if (status === "partial") return "부분";
  if (status === "error") return "오류";
  if (status === "stopped") return "중단";
  if (status === "waiting_input") return "대기";
  return "실행";
}

function runTitle(run) {
  if (run.kind === "chat") return `${agentDisplayName(run.agent)} 채팅`;
  if (run.kind === "update") return run.target === "all" ? "전체 업데이트" : `${agentDisplayName(run.target)} 업데이트`;
  return run.label || "관리 작업";
}

function runMeta(run) {
  const parts = [];
  parts.push(relativeTime(run.endedAt || run.startedAt));
  if (run.durationMs !== undefined) parts.push(`${Math.max(0, Math.round(run.durationMs / 1000))}s`);
  if (run.cwd) parts.push(shortPath(run.cwd));
  return parts.filter(Boolean).join(" · ");
}

function relativeTime(value) {
  if (!value) return "";
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff)) return "";
  const seconds = Math.max(0, Math.round(diff / 1000));
  if (seconds < 60) return `${seconds}초 전`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.round(hours / 24)}일 전`;
}

function shortPath(path) {
  const text = String(path || "");
  const normalized = text.replaceAll("\\", "/");
  const pieces = normalized.split("/").filter(Boolean);
  return pieces.at(-1) || text;
}

function statusSummaryRow(name, tool) {
  const row = document.createElement("details");
  row.className = "status-summary-row";
  row.setAttribute("aria-label", `${name} 상태 상세`);

  const summary = document.createElement("summary");
  summary.className = "status-summary";

  const nameNode = document.createElement("strong");
  nameNode.textContent = name;

  summary.append(statusDot(tool.ok), nameNode, statePill(tool));
  row.append(summary, statusDetail(name, tool));
  return row;
}

function statusDot(ok) {
  const dot = document.createElement("span");
  dot.className = `status ${ok ? "ok" : ""}`;
  dot.title = ok ? "정상" : "확인 필요";
  const sr = document.createElement("span");
  sr.className = "sr-only";
  sr.textContent = ok ? "정상" : "확인 필요";
  dot.append(sr);
  return dot;
}

function statePill(tool) {
  const pill = document.createElement("span");
  pill.className = `state-pill ${tool.installed ? (tool.ok ? "ok" : "warn") : "error"}`;
  pill.textContent = tool.installed ? (tool.ok ? "정상" : "확인") : "미설치";
  return pill;
}

function statusDetail(name, tool) {
  const detail = document.createElement("div");
  detail.className = "status-detail";
  detail.setAttribute("role", "tooltip");

  const rows = [
    ["이름", name],
    ["버전", tool.installed ? (tool.summary || "") : "설치 안 됨"],
    ["경로", `${tool.path || ""}${tool.source ? ` (${tool.source})` : ""}`],
    ["모델", tool.models || ""],
    ["메시지", tool.message || ""],
  ].filter(([, value]) => String(value || "").trim());

  detail.replaceChildren(...rows.map(([label, value]) => statusDetailLine(label, value)));
  return detail;
}

function statusDetailLine(label, value) {
  const line = document.createElement("div");
  line.className = "status-detail-line";
  const key = document.createElement("span");
  key.textContent = label;
  const text = document.createElement("span");
  text.textContent = value;
  line.append(key, text);
  return line;
}

function emptyState(text, className = "empty-state") {
  const node = document.createElement("div");
  node.className = className;
  node.textContent = text;
  return node;
}

function agentMeta(id) {
  return state.agents.find((agent) => agent.id === id);
}

function agentDisplayName(id) {
  return agentMeta(id)?.label || agentName(id);
}
