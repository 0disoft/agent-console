import { abortActiveRequest, loadRuns, postJson, refresh, sendRunInput, showRunDetails, showSnapshot, stopRun, validateCwd } from "./api.js";
import { els } from "./dom.js";
import { applyTemplate, recallPrompt } from "./history.js";
import { appendBlock, clearOutput, filterOutput, scrollOutputToBottom, updateOutputJump } from "./output.js";
import { promptTemplates, state } from "./state.js";
import { agentName } from "./text.js";
import { autoGrowPrompt, moveFocusWithin, selectAgent, updateAgentUi } from "./ui.js";

export function bindEvents() {
  els.agentTabs.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest(".agentChoice");
    if (button) selectAgent(button.dataset.agent);
  });
  els.agentTabs.addEventListener("keydown", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest(".agentChoice");
    if (!button) return;
    const choices = Array.from(document.querySelectorAll(".agentChoice"));
    const index = choices.indexOf(button);
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % choices.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + choices.length) % choices.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = choices.length - 1;
    if (next !== index) {
      event.preventDefault();
      selectAgent(choices[next].dataset.agent, true);
    }
  });

  els.cwd.addEventListener("input", () => {
    state.cwdTouched = true;
    els.cwd.classList.remove("invalid");
    els.cwdStatus.textContent = "";
  });
  els.cwd.addEventListener("blur", validateCwd);
  els.template.addEventListener("change", applyTemplate);
  els.speed.addEventListener("change", updateAgentUi);

  els.managePanel.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("[data-preset], [data-update]");
    if (!button) return;
    if (button.dataset.preset) {
      postJson("/api/preset", { key: button.dataset.preset, cwd: els.cwd.value }, button);
    } else if (button.dataset.update) {
      postJson("/api/update", { target: button.dataset.update, cwd: els.cwd.value }, button);
    }
  });

  els.sendBtn.addEventListener("click", () => {
    const prompt = els.promptBox.value.trim();
    if (!prompt) {
      els.promptBox.classList.add("invalid");
      els.promptBox.setAttribute("aria-invalid", "true");
      els.promptError.textContent = "메시지를 입력하세요.";
      els.promptBox.focus();
      return;
    }
    if (state.installedTools[state.activeAgent] === false) {
      appendBlock(`${agentName(state.activeAgent)} 실행 파일을 찾지 못했습니다. 설치하거나 환경 변수를 지정하세요.`, "warning");
      return;
    }
    els.promptBox.classList.remove("invalid");
    els.promptBox.setAttribute("aria-invalid", "false");
    els.promptError.textContent = "";
    postJson("/api/chat", {
      agent: state.activeAgent,
      prompt,
      cwd: els.cwd.value,
      speed: els.speed.value,
      thinking: els.thinking.value,
      timeout: Number(els.timeout.value || 600),
      interactiveInput: els.interactiveInput.checked,
    }, els.sendBtn);
  });

  els.promptBox.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.key === "Enter") {
      els.sendBtn.click();
    }
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      recallPrompt(event.key === "ArrowUp" ? 1 : -1);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      els.promptBox.blur();
    }
  });
  els.promptBox.addEventListener("input", () => {
    autoGrowPrompt();
    if (els.promptBox.value.trim()) {
      els.promptBox.classList.remove("invalid");
      els.promptBox.setAttribute("aria-invalid", "false");
      els.promptError.textContent = "";
    }
    if (els.template.value && els.promptBox.value !== promptTemplates[els.template.value]) {
      els.template.value = "";
    }
  });

  els.refreshBtn.addEventListener("click", refresh);
  els.refreshRunsBtn.addEventListener("click", loadRuns);
  els.snapshotBtn.addEventListener("click", showSnapshot);
  els.closeSnapshotBtn.addEventListener("click", () => els.snapshotDialog.close());
  els.closeRunDetailBtn.addEventListener("click", () => els.runDetailDialog.close());
  els.clearBtn.addEventListener("click", clearOutput);
  els.outputSearch.addEventListener("input", () => filterOutput(els.outputSearch.value));
  els.runList.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("[data-run-stop]");
    if (button) {
      stopRun(button.dataset.runStop);
      return;
    }
    const inputButton = event.target.closest("[data-run-input]");
    if (inputButton) {
      sendRunInputFromPanel(inputButton.dataset.runInput);
      return;
    }
    if (event.target.closest("button, input, select, textarea, a")) return;
    const row = event.target.closest("[data-run-id]");
    if (row) {
      showRunDetails(row.dataset.runId);
    }
  });
  els.runList.addEventListener("keydown", (event) => {
    if (!(event.target instanceof Element)) return;
    const input = event.target.closest("[data-run-input-text]");
    if (event.key === "Enter" && input) {
      event.preventDefault();
      sendRunInputFromPanel(input.dataset.runInputText);
      return;
    }
    const row = event.target.closest("[data-run-id]");
    if (row && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      showRunDetails(row.dataset.runId);
    }
  });
  els.output.addEventListener("scroll", () => {
    state.outputPinned = els.output.scrollTop + els.output.clientHeight >= els.output.scrollHeight - 24;
    updateOutputJump();
  });
  els.outputJumpBtn.addEventListener("click", scrollOutputToBottom);
  els.stopBtn.addEventListener("click", abortActiveRequest);
  els.inlineStopBtn.addEventListener("click", abortActiveRequest);
  els.managePanel.addEventListener("keydown", (event) => {
    if (event.target?.tagName === "SUMMARY") return;
    const columns = window.matchMedia("(max-width: 900px)").matches ? 1 : 2;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      moveFocusWithin(els.managePanel, columns, 1);
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveFocusWithin(els.managePanel, columns, -1);
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveFocusWithin(els.managePanel, columns, columns);
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveFocusWithin(els.managePanel, columns, -columns);
    }
    if (event.key === "Home") {
      event.preventDefault();
      els.managePanel.querySelector("button")?.focus();
    }
    if (event.key === "End") {
      event.preventDefault();
      Array.from(els.managePanel.querySelectorAll("button")).at(-1)?.focus();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && abortActiveRequest()) {
      event.preventDefault();
    }
  });
}

function sendRunInputFromPanel(runId) {
  const input = els.runList.querySelector(`[data-run-input-text="${CSS.escape(runId || "")}"]`);
  const text = input?.value || "";
  if (!text.trim()) {
    input?.focus();
    return;
  }
  input.value = "";
  sendRunInput(runId, text);
}
