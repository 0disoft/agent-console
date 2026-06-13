import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, sep } from "node:path";
import { chatCommand, maxChatTimeout, minChatTimeout, normalizeChatTimeout } from "../src/server/agents";
import { agentMetadata, listCwdChildDirectories, maxCwdChildDirectories, openCwdFolder, openFolderCommand, piPackageName, updateTargets } from "../src/server/config";
import { resolveStaticPublicPath } from "../src/server/http";
import { printableCommand, stripAnsi as stripProcessAnsi } from "../src/server/process";
import { classifyRunResult, MAX_RUN_HISTORY_LIMIT, MAX_RUN_INPUT_CHARS, normalizeRunHistoryLimit, normalizeRunInput } from "../src/server/runs";
import { renderMarkdown } from "../public/js/markdown.js";
import { stripAnsi as stripBrowserAnsi } from "../public/js/text.js";

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
    expect(source).toContain("LEDGER_COMPACT_TRIGGER_BYTES");
    expect(source).toContain("ledgerWriteQueue");
    expect(source).toContain("compactLedgerIfNeeded");
    expect(source).toContain("rename(compactPath, ledgerPath)");
    expect(source).toContain("const LEDGER_COMPACT_TARGET_LINES = RUN_LOOKUP_LIMIT");
    expect(source).not.toContain("const LEDGER_COMPACT_TARGET_LINES = 2_000");
  });

  test("run event broadcasts do not copy client sets on every event", () => {
    const source = readProjectFile("src/server/runs.ts");
    const broadcastSource = source.slice(source.indexOf("function broadcastEvent"), source.indexOf("function sendWs"));

    expect(broadcastSource).toContain("for (const client of eventClients)");
    expect(broadcastSource).toContain("for (const ws of wsClients)");
    expect(broadcastSource).not.toContain("Array.from(eventClients)");
    expect(broadcastSource).not.toContain("Array.from(wsClients)");
  });

  test("process stream failures preserve partial output and Windows kill stays asynchronous", () => {
    const source = readProjectFile("src/server/process.ts");
    const pipeSource = source.slice(source.indexOf("async function pipeProcessStream"), source.indexOf("function registerInputWriter"));
    const killSource = source.slice(source.indexOf("function killProcess"), source.indexOf("async function readStreamText"));
    const streamSource = source.slice(source.indexOf("export function streamCommandResponse"), source.indexOf("async function pipeProcessStream"));
    const runSource = source.slice(source.indexOf("export async function runCommand"), source.indexOf("export function streamCommandResponse"));

    expect(pipeSource).toContain("catch");
    expect(pipeSource).toContain("return stripAnsi(`${output}${tail}`)");
    expect(runSource.indexOf("const timer = setTimeout")).toBeLessThan(runSource.indexOf("options.onStart?.({ command, cwd })"));
    expect(runSource.indexOf("options.onStart?.({ command, cwd })")).toBeLessThan(runSource.indexOf("await Promise.all"));
    expect(streamSource).toContain("cancel()");
    expect(streamSource).toContain("if (child) killProcess(child)");
    expect(source).toContain("MAX_CAPTURED_OUTPUT_CHARS");
    expect(source).toContain("appendCapturedOutput");
    expect(killSource).toContain("spawnTaskkill(child.pid, false)");
    expect(killSource).toContain("spawnTaskkill(child.pid!, true)");
    expect(killSource).not.toContain('"/T", "/F"]');
    expect(killSource).not.toContain("Bun.spawnSync");
  });

  test("displayed commands are JSON-quoted instead of shell-like snippets", () => {
    expect(printableCommand(["cmd", "hello world", "a;b", "$HOME"])).toBe('"cmd" "hello world" "a;b" "$HOME"');
  });

  test("run stdin input newline handling is centralized and consistent", () => {
    const serverSource = readProjectFile("src/server/http.ts");
    const runsSource = readProjectFile("src/server/runs.ts");

    expect(normalizeRunInput("y")).toBe("y\n");
    expect(normalizeRunInput("y\n")).toBe("y\n");
    expect(normalizeRunInput("y", { newline: false })).toBe("y");
    expect(serverSource).toContain("sendRunInput(id, text, { newline: payload.newline })");
    expect(runsSource).toContain("sendRunInput(payload.runId, text, { newline: payload.newline })");
    expect(runsSource).toContain("activeRuns.get(id) !== run");
    expect(MAX_RUN_INPUT_CHARS).toBe(100_000);
    expect(runsSource).toContain("input.length > MAX_RUN_INPUT_CHARS");
  });

  test("run prompt detection only marks waiting when stdin is attached", () => {
    const runsSource = readProjectFile("src/server/runs.ts");
    const outputHandler = runsSource.slice(runsSource.indexOf("export function attachRunOutput"), runsSource.indexOf("export function attachRunDone"));

    expect(outputHandler).toContain("!run.input");
    expect(outputHandler).toContain("run:waiting-input");
  });

  test("cwd validation tracks the input value so stale promise results are ignored before send", () => {
    const stateSource = readProjectFile("public/js/state.js");
    const apiSource = readProjectFile("public/js/api.js");

    expect(stateSource).toContain("cwdValidateValue");
    expect(apiSource).toContain("state.cwdValidateValue = value");
    expect(apiSource).toContain("els.cwd.value.trim() === validatingValue");
  });

  test("static public file resolution stays inside the public directory", () => {
    const appCss = resolveStaticPublicPath("/app.css") || "";
    const appJs = resolveStaticPublicPath("/app.js") || "";
    const nestedJs = resolveStaticPublicPath("/js/app-init.js") || "";

    expect(appCss.endsWith(join("public", "app.css"))).toBe(true);
    expect(appJs.endsWith(join("public", "app.js"))).toBe(true);
    expect(nestedJs.endsWith(join("public", "js", "app-init.js"))).toBe(true);
    expect(resolveStaticPublicPath("/js/../../src/server/config.ts")).toBeNull();
    expect(resolveStaticPublicPath("/js/%2e%2e/%2e%2e/src/server/config.ts")).toBeNull();
    expect(resolveStaticPublicPath("/%2e%2e/package.json")).toBeNull();
  });

  test("POST JSON bodies are size-limited and abort listeners are removed", () => {
    const source = readProjectFile("src/server/http.ts");

    expect(source).toContain("MAX_JSON_BODY_BYTES");
    expect(source).toContain("readRequestText(request, MAX_JSON_BODY_BYTES)");
    expect(source).toContain("totalBytes > maxBytes");
    expect(source).toContain("source.removeEventListener");
    expect(source).toContain("unlinkAbort()");
  });

  test("snapshots report only configured model and provider values", () => {
    const source = readProjectFile("src/server/runs.ts");
    const snapshotSource = source.slice(source.indexOf("export async function snapshotPayload"), source.indexOf("export function eventsResponse"));

    expect(snapshotSource).toContain("model: configuredModel || null");
    expect(snapshotSource).toContain("provider: configuredProvider || null");
    expect(snapshotSource).not.toContain("defaultModel");
    expect(snapshotSource).not.toContain("defaultProvider");
  });

  test("markdown inline code renders escaped HTML instead of live tags", () => {
    const html = renderMarkdown("`<img src=x onerror=alert(1)>`");
    const source = readProjectFile("public/js/markdown.js");

    expect(html).toContain("<code>&lt;img src=x onerror=alert(1)&gt;</code>");
    expect(html).not.toContain("<img");
    expect(source).toContain('data-lang="${escapeHtml(lang)}"');
  });

  test("browser streaming output is capped before full-text rendering", () => {
    const source = readProjectFile("public/js/api.js");
    const streamSource = source.slice(source.indexOf("async function postStreamJson"), source.indexOf("function scheduleLoadRuns"));

    expect(source).toContain("maxStreamTextChars");
    expect(source).toContain("appendStreamText");
    expect(streamSource).toContain("stdout = appendStreamText(stdout, event.text)");
    expect(streamSource).toContain("stderr = appendStreamText(stderr, event.text)");
    expect(streamSource).toContain("if (state.outputFilter)");
  });

  test("chat timeout is clamped by the server command builder", () => {
    expect(normalizeChatTimeout(1)).toBe(minChatTimeout);
    expect(normalizeChatTimeout(999999)).toBe(maxChatTimeout);
    expect(normalizeChatTimeout("not-a-number")).toBe(600);
    expect(chatCommand({ agent: "pi", prompt: "안녕", timeout: 999999 }).timeout).toBe(maxChatTimeout);
  });

  test("status cache prunes expired entries and marks stale fallback payloads", () => {
    const source = readProjectFile("src/server/agents.ts");
    const typeSource = readProjectFile("src/server/types.ts");

    expect(source).toContain("pruneStatusCaches(now)");
    expect(source).toContain("staleStatusPayload");
    expect(source).toContain("stale: true");
    expect(typeSource).toContain("stale?: boolean");
    expect(typeSource).toContain("error?: string");
  });

  test("tool PATH lookup normalizes quoted entries and caches by PATH state", () => {
    const source = readProjectFile("src/server/agents.ts");

    expect(source).toContain("pathLookupCache");
    expect(source).toContain("normalizePathEntry");
    expect(source).toContain("process.env.PATHEXT");
    expect(source).toContain("pathLookupCache.clear()");
  });

  test("ANSI stripping removes OSC control sequences as well as CSI sequences", () => {
    expect(stripProcessAnsi("a\x1b[31mred\x1b[0m")).toBe("ared");
    expect(stripProcessAnsi("a\x1b]0;title\x07b")).toBe("ab");
    expect(stripProcessAnsi("a\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\b")).toBe("alinkb");
    expect(stripBrowserAnsi("a\x1b]0;title\x07b")).toBe("ab");
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
    expect(updater).toContain("[Net.SecurityProtocolType]::Tls12");
    expect(updater).toContain("$maxUserPathLength = 8191");
    expect(updater).toContain("Refusing to add ZeroClaw to user PATH");
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

  test("Hermes gateway is restarted only when it was running before update", () => {
    const source = readProjectFile("src/server/agents.ts");
    const updateSource = source.slice(source.indexOf("async function updateHermes"), source.indexOf("async function updatePi"));

    expect(source).toContain("async function isHermesGatewayRunning");
    expect(updateSource).toContain("gatewayWasRunning");
    expect(updateSource).toContain("gatewayWasRunning ? await stopHermesGateway() : null");
    expect(updateSource).toContain("if (gatewayWasRunning)");
  });

  test("Windows stop helper delegates to a script instead of interpolating the batch path into PowerShell source", () => {
    const stopCmd = readProjectFile("stop.cmd");
    const stopPs1 = readProjectFile("stop.ps1");

    expect(stopCmd).toContain('-File "%~dp0stop.ps1"');
    expect(stopCmd).not.toContain("-Command");
    expect(stopCmd).not.toContain("Resolve-Path '%~dp0'");
    expect(stopPs1).toContain("$PSScriptRoot");
  });

  test("launcher waits for an HTTP response before opening the browser", () => {
    const source = readProjectFile("launch.ps1");

    expect(source).toContain("Invoke-WebRequest");
    expect(source).toContain("AddSeconds(20)");
    expect(source).toContain("Start-Sleep -Milliseconds 250");
    expect(source).not.toContain("Start-Sleep -Seconds 2; Start-Process");
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
    const runEvents = readProjectFile("src/server/runs.ts");
    const browserState = readProjectFile("public/js/state.js");

    expect(serverStream).toContain('type: "heartbeat"');
    expect(serverStream).toContain("setInterval");
    expect(browserStream).toContain('event.type === "heartbeat"');
    expect(browserStream).toContain("return;");
    expect(runEvents).toContain("SSE_HEARTBEAT_MS");
    expect(runEvents).not.toContain("}, 1000)");
    expect(browserStream).toContain("scheduleEventsReconnect");
    expect(browserStream).toContain("eventsReconnectMaxDelay");
    expect(browserState).toContain("eventsReconnectDelay");
  });

  test("stream parsing tolerates whitespace and pre-abort responses render as stopped", () => {
    const source = readProjectFile("public/js/api.js");
    const parseSource = source.slice(source.indexOf("function parseStreamLine"), source.indexOf("function mergeFinalStreamText"));
    const streamSource = source.slice(source.indexOf("async function postStreamJson"), source.indexOf("function scheduleLoadRuns"));

    expect(parseSource).toContain("const value = String(line || \"\").trim()");
    expect(parseSource).toContain("JSON.parse(value)");
    expect(streamSource).toContain("res.status === 409");
    expect(streamSource).toContain("streamAbortError");
    expect(streamSource).toContain("isStreamAbortError(error)");
    expect(streamSource).toContain('"중단됨"');
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
