export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function agentName(agent) {
  if (agent === "hermes") return "Hermes";
  if (agent === "zeroclaw") return "ZeroClaw";
  if (agent === "pi") return "Pi";
  const value = String(agent || "Agent");
  return value ? `${value.slice(0, 1).toUpperCase()}${value.slice(1)}` : "Agent";
}

export function speedName(value) {
  if (value === "balanced") return "균형";
  if (value === "deep") return "깊게";
  return "빠름";
}

export function typeLabel(type) {
  if (type === "ok") return "완료";
  if (type === "error") return "오류";
  if (type === "warning") return "알림";
  if (type === "running") return "실행 중";
  return "출력";
}
