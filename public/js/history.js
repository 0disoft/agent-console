import { els } from "./dom.js";
import { promptTemplates, state, storageKeys } from "./state.js";
import { readJsonStorage } from "./storage.js";
import { autoGrowPrompt } from "./ui.js";

export function renderCwdHistory() {
  const entries = readJsonStorage(storageKeys.cwdHistory, []).filter(Boolean).slice(0, 10);
  els.cwdHistory.replaceChildren();
  for (const entry of entries) {
    const option = document.createElement("option");
    option.value = entry;
    els.cwdHistory.appendChild(option);
  }
}

export function recallPrompt(direction) {
  const history = readJsonStorage(storageKeys.promptHistory, []).filter(Boolean);
  if (!history.length) return false;
  if (state.promptHistoryIndex === -1) {
    state.promptHistoryDraft = els.promptBox.value;
  }
  state.promptHistoryIndex = Math.max(-1, Math.min(history.length - 1, state.promptHistoryIndex + direction));
  els.promptBox.value = state.promptHistoryIndex === -1
    ? state.promptHistoryDraft
    : history[state.promptHistoryIndex] || "";
  els.template.value = "";
  autoGrowPrompt();
  return true;
}

export function applyTemplate() {
  const value = promptTemplates[els.template.value];
  if (!value) return;
  if (els.promptBox.value.trim() && els.promptBox.value !== value && !confirm("현재 메시지를 템플릿으로 바꿀까요?")) {
    els.template.value = "";
    return;
  }
  els.promptBox.value = value;
  els.promptBox.classList.remove("invalid");
  els.promptBox.setAttribute("aria-invalid", "false");
  els.promptError.textContent = "";
  autoGrowPrompt();
  els.promptBox.focus();
}
