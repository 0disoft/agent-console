import { connectEvents, loadRuns, refresh } from "./api.js";
import { bindEvents } from "./events.js";
import { renderCwdHistory } from "./history.js";
import { restoreOutputHistory } from "./output.js";
import { autoGrowPrompt, updateAgentUi } from "./ui.js";

export function initApp() {
  bindEvents();
  renderCwdHistory();
  restoreOutputHistory();
  updateAgentUi();
  autoGrowPrompt();
  refresh();
  loadRuns();
  connectEvents();
}
