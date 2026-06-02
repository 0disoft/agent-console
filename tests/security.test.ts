import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, sep } from "node:path";
import { chatCommand } from "../src/server/agents";
import { agentMetadata, listCwdChildDirectories, maxCwdChildDirectories, openCwdFolder, openFolderCommand, piPackageName, updateTargets } from "../src/server/config";
import { classifyRunResult, MAX_RUN_HISTORY_LIMIT, normalizeRunHistoryLimit } from "../src/server/runs";

const root = fileURLToPath(new URL("..", import.meta.url));

function readProjectFile(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("security regressions", () => {
  test("run history limits reject malformed and excessive values", () => {
    expect(normalizeRunHistoryLimit(null)).toBe(30);
    expect(normalizeRunHistoryLimit("1")).toBe(1);
    expect(normalizeRunHistoryLimit("0")).toBe(30);
    expect(normalizeRunHistoryLimit("NaN")).toBe(30);
    expect(normalizeRunHistoryLimit("Infinity")).toBe(30);
    expect(normalizeRunHistoryLimit("999999")).toBe(MAX_RUN_HISTORY_LIMIT);
  });

  test("run history reads stay bounded to a tail window", () => {
    const source = readProjectFile("src/server/runs.ts");

    expect(source).not.toContain("readFileSync");
    expect(source).toContain("LEDGER_TAIL_MAX_BYTES");
    expect(source).toContain("readRecentLedgerLines");
  });

  test("ZeroClaw update path uses a verified GitHub release updater", () => {
    const source = readProjectFile("src/server/agents.ts");
    const updater = readProjectFile("scripts/update-zeroclaw-windows.ps1");
    const zeroclaw = agentMetadata().find((agent) => agent.id === "zeroclaw");

    expect(zeroclaw?.supportsUpdate).toBe(process.platform === "win32");
    if (process.platform === "win32") {
      expect(updateTargets.zeroclaw.some((arg) => arg.includes("update-zeroclaw-windows.ps1"))).toBe(true);
    }
    expect(updater).toContain("zeroclaw-labs/zeroclaw");
    expect(updater).toContain("SHA256SUMS");
    expect(updater).toContain("Get-FileHash -Algorithm SHA256");
    expect(updater).toContain("System.Security.Cryptography.SHA256");
    expect(updater).toContain("System.IO.Compression.ZipFile");
    expect([...updater].every((char) => char.charCodeAt(0) < 128)).toBe(true);
    expect(source).not.toContain("releases/latest/download");
    expect(source).not.toContain("Invoke-WebRequest");
    expect(source).not.toContain("Copy-Item -LiteralPath $exe.FullName");
  });

  test("Pi update falls back to the bun global package updater for bun installs", () => {
    const source = readProjectFile("src/server/agents.ts");

    expect(updateTargets.pi).toContain("update");
    expect(piPackageName).toBe("@earendil-works/pi-coding-agent");
    expect(source).toContain("Detected install method: bun");
    expect(source).toContain("bun update --global --latest");
    expect(source).toContain("piPackageName");
  });

  test("Windows stop helper delegates to a script instead of interpolating the batch path into PowerShell source", () => {
    const stopCmd = readProjectFile("stop.cmd");
    const stopPs1 = readProjectFile("stop.ps1");

    expect(stopCmd).toContain('-File "%~dp0stop.ps1"');
    expect(stopCmd).not.toContain("-Command");
    expect(stopCmd).not.toContain("Resolve-Path '%~dp0'");
    expect(stopPs1).toContain("$PSScriptRoot");
  });

  test("Hermes admin helper refuses elevated or broadly writable user-profile script actions", () => {
    const source = readProjectFile("fix-hermes-gateway-task-admin.ps1");

    expect(source).toContain('RunLevel -eq "Highest"');
    expect(source).toContain("unsafeWriterSids");
    expect(source).toContain("Refusing to use Hermes gateway VBS");
    expect(source).not.toContain("$task.Settings.Hidden = $true");
  });

  test("chat commands do not force OpenAI Codex unless configured", () => {
    const pi = chatCommand({ agent: "pi", prompt: "안녕", speed: "fast" }).args;
    const hermes = chatCommand({ agent: "hermes", prompt: "안녕", speed: "fast" }).args;

    expect(pi).toContain("--thinking");
    expect(pi).toContain("low");
    expect(pi).not.toContain("--model");
    expect(pi.join(" ")).not.toContain("openai-codex/");
    expect(hermes).not.toContain("--provider");
    expect(hermes).not.toContain("--model");
  });

  test("ZeroClaw chat prompts pin relative file work to the selected Agent Console cwd", () => {
    const args = chatCommand({
      agent: "zeroclaw",
      prompt: "{OUTPUT_DIR} = zeroclaw\n작업 폴더 안의 {OUTPUT_DIR} 폴더에 파일을 만들어줘.",
      cwd: root,
      speed: "deep",
    }).args;
    const message = String(args.at(args.indexOf("--message") + 1) || "");
    const normalizedRoot = root.replace(/[\\/]$/, "");

    expect(message).toContain("[Agent Console 작업 폴더 지시]");
    expect(message).toContain(normalizedRoot);
    expect(message).toContain("상대 경로");
    expect(message).toContain("ZeroClaw 내부 기본 workspace");
    expect(message).toContain("{OUTPUT_DIR} = zeroclaw");
  });

  test("chat streaming keeps idle requests alive without rendering heartbeat events", () => {
    const serverStream = readProjectFile("src/server/process.ts");
    const browserStream = readProjectFile("public/js/api.js");

    expect(serverStream).toContain('type: "heartbeat"');
    expect(serverStream).toContain("setInterval");
    expect(browserStream).toContain('event.type === "heartbeat"');
    expect(browserStream).toContain("return;");
  });

  test("ZeroClaw loop-detector aborts with useful stdout are shown as partial completion", () => {
    const stderr = [
      "WARN zeroclaw_runtime::agent::loop_: loop detector blocked tool call tool=shell",
      "Error: Agent loop aborted by loop detector: Circuit breaker: tool 'shell' called 5 times consecutively with identical arguments",
    ].join("\n");
    const browserStream = readProjectFile("public/js/api.js");
    const browserLabels = readProjectFile("public/js/text.js");
    const outputStyles = readProjectFile("public/css/output.css");
    const runStyles = readProjectFile("public/css/components.css");
    const runUi = readProjectFile("public/js/ui.js");

    expect(classifyRunResult({ ok: false, stdout: "- 만든 파일 목록", stderr })).toBe("partial");
    expect(classifyRunResult({ ok: false, stdout: "", stderr })).toBe("error");
    expect(browserStream).toContain("isPartialCompletionStderr");
    expect(browserStream).toContain('type: "partial"');
    expect(browserStream).toContain('stderrLabel: "주의"');
    expect(browserLabels).toContain('if (type === "partial") return "부분 완료";');
    expect(outputStyles).toContain(".output-block.partial");
    expect(runStyles).toContain(".run-badge.partial");
    expect(runUi).toContain('if (status === "partial") return "부분";');
  });

  test("chat requests are tracked per agent instead of blocking every tab globally", () => {
    const stateSource = readProjectFile("public/js/state.js");
    const apiSource = readProjectFile("public/js/api.js");
    const uiSource = readProjectFile("public/js/ui.js");

    expect(stateSource).toContain("activeChatRequests");
    expect(apiSource).toContain("state.activeChatRequests[payload.agent]");
    expect(apiSource).toContain("state.activeChatRequests[agent]");
    const streamSource = apiSource.slice(apiSource.indexOf("async function postStreamJson"));
    expect(streamSource).not.toContain("state.activeRequest");
    expect(streamSource).toContain("setChatRequestRunning(agent");
    expect(streamSource).toContain("forgetChatRequest(agent");
    expect(uiSource).toContain("setChatRequestRunning");
    expect(uiSource).toContain("selectedChatRequest");
  });

  test("working folder open button is wired to a validated server endpoint", () => {
    const markup = readProjectFile("index.html");
    const domSource = readProjectFile("public/js/dom.js");
    const eventSource = readProjectFile("public/js/events.js");
    const apiSource = readProjectFile("public/js/api.js");
    const serverSource = readProjectFile("src/server/http.ts");

    expect(markup).toContain('id="openCwdBtn"');
    expect(markup).toContain('aria-label="작업 폴더 열기"');
    expect(domSource).toContain("openCwdBtn");
    expect(eventSource).toContain("openWorkingFolder");
    expect(apiSource).toContain('fetch("/api/open-cwd"');
    expect(serverSource).toContain('route === "/api/open-cwd"');
    expect(serverSource).toContain("openCwdFolder");
  });

  test("folder opening validates directories and launches without shell interpolation", () => {
    const workspace = mkdtempSync(join(root, ".tmp-open-cwd-"));
    const launched: string[][] = [];
    try {
      const result = openCwdFolder(workspace, (command) => {
        launched.push(command);
        return { exitCode: 0 };
      });

      expect(result.ok).toBe(true);
      expect(result.cwd).toBe(workspace);
      expect(launched).toEqual([openFolderCommand(workspace)]);
      expect(launched[0].length).toBe(2);
      expect(launched[0][1]).toBe(workspace);
      expect(launched[0].join(" ")).not.toContain("cmd /c");
      expect(launched[0].join(" ")).not.toContain("powershell");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("cwd child directory suggestions only expose immediate directories within a bounded list", () => {
    const workspace = mkdtempSync(join(root, ".tmp-cwd-suggestions-"));
    try {
      mkdirSync(join(workspace, "alpha"));
      mkdirSync(join(workspace, "Beta"));
      writeFileSync(join(workspace, "not-a-folder.txt"), "x");

      const result = listCwdChildDirectories(`${workspace}${sep}`);
      const names = result.directories.map((entry) => entry.name);

      expect(names).toContain("alpha");
      expect(names).toContain("Beta");
      expect(result.directories.every((entry) => entry.path.endsWith(sep))).toBe(true);
      expect(result.directories.length).toBeLessThanOrEqual(maxCwdChildDirectories);
      expect(names).not.toContain("not-a-folder.txt");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
