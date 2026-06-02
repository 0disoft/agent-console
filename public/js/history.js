import { els } from "./dom.js";
import { promptTemplates, state, storageKeys } from "./state.js";
import { readJsonStorage } from "./storage.js";
import { autoGrowPrompt } from "./ui.js";

export function renderCwdHistory() {
  const suggestions = Array.isArray(state.cwdSuggestions) ? state.cwdSuggestions : [];
  const seen = new Set();
  const entries = readJsonStorage(storageKeys.cwdHistory, [])
    .filter(Boolean)
    .filter((entry) => {
      if (seen.has(entry)) return false;
      seen.add(entry);
      return !suggestions.some((suggestion) => suggestion.path === entry);
    })
    .slice(0, 10);
  els.cwdHistory.replaceChildren();
  for (const suggestion of suggestions) {
    const option = document.createElement("option");
    option.value = suggestion.path;
    option.label = suggestion.name;
    els.cwdHistory.appendChild(option);
  }
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
  if (els.promptBox.value.trim() && els.promptBox.value !== value) {
    els.promptBox.value = `${els.promptBox.value.trim()}\n\n${value}`;
  } else {
    els.promptBox.value = value;
  }
  els.promptBox.classList.remove("invalid");
  els.promptBox.setAttribute("aria-invalid", "false");
  els.promptError.textContent = "";
  autoGrowPrompt();
  els.promptBox.focus();
}
