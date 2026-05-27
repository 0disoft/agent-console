import { storageKeys } from "./state.js";

export function readJsonStorage(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJsonStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
  }
}

export function rememberCwd(value, renderCwdHistory) {
  const normalized = String(value || "").trim();
  if (!normalized) return;
  const next = readJsonStorage(storageKeys.cwdHistory, [])
    .filter((entry) => entry && entry !== normalized);
  next.unshift(normalized);
  writeJsonStorage(storageKeys.cwdHistory, next.slice(0, 10));
  renderCwdHistory();
}

export function rememberPrompt(value, state) {
  const normalized = String(value || "").trim();
  if (!normalized) return;
  const next = readJsonStorage(storageKeys.promptHistory, [])
    .filter((entry) => entry && entry !== normalized);
  next.unshift(normalized);
  writeJsonStorage(storageKeys.promptHistory, next.slice(0, 50));
  state.promptHistoryIndex = -1;
  state.promptHistoryDraft = "";
}
