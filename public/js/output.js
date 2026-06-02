import { els } from "./dom.js";
import { looksLikeMarkdown, renderMarkdown } from "./markdown.js";
import { maxOutputBlocks, maxStoredBlockChars, state, storageKeys } from "./state.js";
import { readJsonStorage } from "./storage.js";
import { stripAnsi, typeLabel } from "./text.js";

const markdownRenderLimit = 200_000;
const maxStoredHistoryChars = maxOutputBlocks * maxStoredBlockChars;

export function append(text, type = "info") {
  appendBlock(text, type);
}

export function appendBlock(text, type = "info", label = typeLabel(type), persist = type !== "running") {
  const cleanText = stripAnsi(String(text || ""));
  const entry = {
    type,
    label,
    stamp: new Date().toLocaleTimeString(),
    text: cleanText,
  };
  const block = renderOutputBlock(entry);
  if (persist) {
    state.outputHistory.push({ ...entry, text: truncateStoredText(cleanText) });
    state.outputHistory = state.outputHistory.slice(-maxOutputBlocks);
    persistOutputHistory();
  }
  return block;
}

export function renderOutputBlock(entry) {
  const block = document.createElement("article");
  block.className = `output-block ${entry.type || "info"}`;
  block.dataset.outputText = String(entry.text || "");
  block.dataset.searchText = [
    entry.label || typeLabel(entry.type || "info"),
    entry.stamp || "",
    entry.text || "",
  ].join("\n").toLowerCase();

  const head = document.createElement("div");
  head.className = "output-head";
  const left = document.createElement("span");
  left.textContent = entry.label || typeLabel(entry.type || "info");
  const right = document.createElement("span");
  right.className = "output-actions";
  const stamp = document.createElement("span");
  stamp.textContent = entry.stamp || new Date().toLocaleTimeString();
  const copy = document.createElement("button");
  copy.className = "copy-output";
  copy.type = "button";
  copy.textContent = "복사";
  copy.addEventListener("click", () => copyOutputText(block.dataset.outputText || "", copy));
  right.append(stamp, copy);
  head.append(left, right);

  const body = document.createElement("div");
  body.className = "output-body";
  renderOutputText(body, String(entry.text || ""));

  block.append(head, body);
  els.output.prepend(block);
  while (els.output.children.length > maxOutputBlocks) {
    els.output.removeChild(els.output.lastElementChild);
  }
  requestAnimationFrame(() => {
    if (state.outputPinned) {
      els.output.scrollTop = 0;
      updateOutputJump();
    } else {
      els.outputJumpBtn.hidden = false;
    }
  });
  applyOutputFilter();
  return block;
}

export function updateOutputBlock(block, text, type = "info", label = typeLabel(type), persist = true) {
  const cleanText = stripAnsi(String(text || ""));
  const labelNode = block.querySelector(".output-head > span");
  const bodyNode = block.querySelector(".output-body");
  const stamp = block.querySelector(".output-actions > span");
  const entry = {
    type,
    label,
    stamp: stamp?.textContent || new Date().toLocaleTimeString(),
    text: cleanText,
  };

  block.className = `output-block ${type || "info"}`;
  if (labelNode) labelNode.textContent = label || typeLabel(type);
  if (bodyNode) renderOutputText(bodyNode, cleanText);
  block.dataset.outputText = cleanText;
  block.dataset.searchText = [entry.label, entry.stamp, cleanText].join("\n").toLowerCase();
  applyOutputFilter();

  if (persist) {
    state.outputHistory.push({ ...entry, text: truncateStoredText(cleanText) });
    state.outputHistory = state.outputHistory.slice(-maxOutputBlocks);
    persistOutputHistory();
  }
}

export function renderOutputText(node, text) {
  node.textContent = "";
  if (text.length <= markdownRenderLimit && looksLikeMarkdown(text)) {
    node.classList.add("rendered");
    node.innerHTML = renderMarkdown(text);
  } else {
    node.classList.remove("rendered");
    node.textContent = text;
  }
}

export function restoreOutputHistory() {
  state.outputHistory = readJsonStorage(storageKeys.output, [])
    .filter((entry) => entry && typeof entry.text === "string")
    .slice(-maxOutputBlocks);
  els.output.replaceChildren();
  state.outputHistory.forEach(renderOutputBlock);
  applyOutputFilter();
}

export function clearOutput() {
  state.outputHistory = [];
  try {
    localStorage.removeItem(storageKeys.output);
  } catch {
  }
  els.output.replaceChildren();
  applyOutputFilter();
  updateOutputJump();
}

export function persistOutputHistory() {
  let next = trimHistoryForStorage(state.outputHistory.slice(-maxOutputBlocks));
  while (next.length) {
    try {
      localStorage.setItem(storageKeys.output, JSON.stringify(next));
      state.outputHistory = next;
      return;
    } catch {
      next = next.slice(Math.ceil(next.length / 2));
    }
  }
}

function trimHistoryForStorage(entries) {
  let total = 0;
  let start = entries.length;
  while (start > 0 && total < maxStoredHistoryChars) {
    const next = entries[start - 1];
    total += estimatedStoredLength(next);
    start -= 1;
  }
  return entries.slice(total > maxStoredHistoryChars ? start + 1 : start);
}

function estimatedStoredLength(entry) {
  return String(entry?.text || "").length
    + String(entry?.label || "").length
    + String(entry?.stamp || "").length
    + String(entry?.type || "").length
    + 80;
}

export function truncateStoredText(text) {
  if (text.length <= maxStoredBlockChars) return text;
  return `${text.slice(0, maxStoredBlockChars)}\n\n[브라우저 저장 기록은 ${maxStoredBlockChars}자까지만 보존됩니다.]`;
}

async function copyOutputText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const previous = button.textContent;
    button.textContent = "복사됨";
    setTimeout(() => {
      button.textContent = previous;
    }, 1200);
  } catch {
    appendBlock("클립보드 복사에 실패했습니다.", "warning");
  }
}

export function scrollOutputToTop() {
  els.output.scrollTop = 0;
  state.outputPinned = true;
  updateOutputJump();
}

export function updateOutputJump() {
  els.outputJumpBtn.hidden = state.outputPinned;
}

export function filterOutput(query) {
  state.outputFilter = String(query || "").trim().toLowerCase();
  applyOutputFilter();
}

export function applyOutputFilter() {
  if (!els.outputSearchCount) return;
  const blocks = Array.from(els.output.querySelectorAll(".output-block"));
  const query = state.outputFilter;
  let visible = 0;
  for (const block of blocks) {
    const text = block.dataset.searchText || "";
    const matches = !query || text.includes(query);
    block.hidden = !matches;
    if (matches) visible += 1;
  }
  els.outputSearchCount.textContent = query ? `${visible}/${blocks.length}` : `${blocks.length}`;
}
