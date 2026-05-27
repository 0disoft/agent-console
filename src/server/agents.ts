import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  agentDefinition,
  agentDefinitions,
  agentMetadata,
  defaultCwd,
  defaultModel,
  defaultProvider,
  envNameForTool,
  home,
  presetMetadata,
  resolveCwd,
  tools,
  updateTargets,
} from "./config";
import {
  emptyRunResult,
  firstLine,
  firstNonEmpty,
  runCommand,
  shellQuote,
  stripAnsi,
} from "./process";
import type { RunResult, StatusPayload, ToolName } from "./types";

let cachedStatus: { at: number; payload: StatusPayload } | null = null;
let inflightStatus: Promise<StatusPayload> | null = null;
const installedCache = new Map<ToolName, { at: number; command: string; installed: boolean }>();
const statusCacheMs = 15_000;

export function clearStatusCache() {
  cachedStatus = null;
  inflightStatus = null;
}

async function stopHermesGateway() {
  if (process.platform !== "win32") {
    return runCommand([tools.hermes.command, "gateway", "stop"], { cwd: defaultCwd, timeout: 30 });
  }

  return runCommand([
    "powershell",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "$matches=Get-CimInstance Win32_Process | Where-Object { ($_.Name -in @('python.exe','pythonw.exe','wscript.exe','cmd.exe')) -and ($_.CommandLine -match 'hermes_cli\\.main gateway run|Hermes_Gateway\\.(cmd|vbs)') }; foreach($p in $matches){ Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }",
  ], { cwd: defaultCwd, timeout: 30 });
}

async function startHermesGateway() {
  if (process.platform !== "win32") {
    return runCommand([tools.hermes.command, "gateway", "start"], { cwd: defaultCwd, timeout: 30 });
  }

  const script = join(home, "AppData", "Local", "hermes", "gateway-service", "Hermes_Gateway.vbs");
  if (!existsSync(script)) return null;
  return runCommand(["wscript.exe", script], { cwd: defaultCwd, timeout: 30 });
}

export async function updateAgent(target: string, cwd?: string, signal?: AbortSignal) {
  await assertToolInstalled(target);
  if (target === "hermes") return updateHermes(cwd, signal);
  if (target === "zeroclaw") return updateZeroclaw(cwd, signal);
  return runCommand(updateTargets[target], { cwd, timeout: 1800, signal });
}

async function updateHermes(cwd?: string, signal?: AbortSignal) {
  const stopResult = await stopHermesGateway();
  try {
    const first = await runCommand(updateTargets.hermes, { cwd, timeout: 1800, signal });
    if (!stopResult.ok) {
      first.stderr = [
        "Hermes gateway stop attempt failed before update:",
        stopResult.stderr || stopResult.stdout || `(exit ${stopResult.code})`,
        first.stderr,
      ].filter(Boolean).join("\n");
    }
    const combined = `${first.stdout}\n${first.stderr}`;
    if (first.ok || !combined.includes("Another hermes.exe is running")) {
      return first;
    }

    const forced = await runCommand([tools.hermes.command, "update", "--yes", "--force"], { cwd, timeout: 1800, signal });
    return mergeRetryResult(first, forced, "Retrying Hermes update with --force.");
  } finally {
    const startResult = await startHermesGateway();
    if (startResult && !startResult.ok) {
      console.warn(`Hermes gateway restart failed: ${startResult.stderr || startResult.stdout}`);
    }
  }
}

async function updateZeroclaw(cwd?: string, signal?: AbortSignal) {
  const first = await runCommand(updateTargets.zeroclaw, { cwd, timeout: 1800, signal });
  const combined = `${first.stdout}\n${first.stderr}`;
  if (first.ok || !combined.includes("architecture mismatch")) {
    return first;
  }
  return {
    ...first,
    stderr: [
      first.stderr,
      "Automatic ZeroClaw release fallback download is disabled because unsigned remote executables must not be installed or run. Install a trusted Windows build manually, then retry.",
    ].filter(Boolean).join("\n"),
  };
}

function mergeRetryResult(first: RunResult, second: RunResult, note: string): RunResult {
  return {
    ok: second.ok,
    code: second.code,
    stdout: [
      note,
      "",
      "First attempt:",
      first.stdout || first.stderr || `(exit ${first.code})`,
      "",
      "Retry result:",
      second.stdout || second.stderr || `(exit ${second.code})`,
    ].join("\n"),
    stderr: second.ok ? "" : second.stderr,
    command: `${first.command} -> ${second.command}`,
    cwd: second.cwd || first.cwd,
  };
}

export async function updateAll(cwd?: string, signal?: AbortSignal) {
  const resolvedCwd = resolveCwd(cwd);
  const targets = await installedTargets();
  if (!targets.length) {
    return {
      ok: false,
      code: 1,
      stdout: "",
      stderr: "설치된 에이전트를 찾지 못했습니다. Hermes, Pi, ZeroClaw를 설치하거나 HERMES_BIN/PI_BIN/ZEROCLAW_BIN 환경 변수를 지정하세요.",
      command: "update all agents",
      cwd: resolvedCwd,
    };
  }

  const results: Array<RunResult & { target: string }> = [];
  if (targets.includes("hermes")) {
    results.push({ target: "hermes", ...(await updateAgent("hermes", resolvedCwd, signal)) });
  }

  const parallelTargets = targets.filter((target) => target !== "hermes");
  const parallelResults = await Promise.all(parallelTargets.map(async (target) => ({
    target,
    ...(await updateAgent(target, resolvedCwd, signal)),
  })));
  results.push(...parallelResults);

  return {
    ok: results.every((item) => item.ok),
    code: results.every((item) => item.ok) ? 0 : 1,
    stdout: [
      targets.length < 3 ? `설치된 에이전트만 업데이트합니다: ${targets.join(", ")}` : "",
      results.map(formatUpdateResult).join("\n\n"),
    ].filter(Boolean).join("\n\n"),
    stderr: results.filter((item) => !item.ok).map((item) => `[${item.target}]\n${item.stderr}`).join("\n\n"),
    command: "update all agents",
    cwd: resolvedCwd,
  };
}

async function installedTargets() {
  const checks = await Promise.all(Object.keys(updateTargets).map(async (target) => ({
    target,
    installed: await isToolInstalled(target),
  })));
  return checks.filter((item) => item.installed).map((item) => item.target);
}

async function assertToolInstalled(target: ToolName) {
  if (await isToolInstalled(target)) return;
  throw new Error(`${target} 실행 파일을 찾지 못했습니다. 설치하거나 ${envNameForTool(target)} 환경 변수를 지정하세요.`);
}

async function isToolInstalled(target: ToolName) {
  const tool = tools[target];
  const cached = installedCache.get(target);
  if (cached && cached.command === tool.command && Date.now() - cached.at < statusCacheMs) {
    return cached.installed;
  }

  let installed = false;
  if (tool.source !== "path" && isAbsolute(tool.command)) {
    installed = existsSync(tool.command);
  } else if (tool.source !== "path" && commandLooksLikePath(tool.command)) {
    installed = existsSync(resolve(tool.command));
  } else {
    const check = process.platform === "win32"
      ? ["where.exe", tool.command]
      : ["sh", "-c", `command -v ${shellQuote(tool.command)}`];
    const result = await runCommand(check, { cwd: defaultCwd, timeout: 5 });
    installed = result.ok;
  }

  installedCache.set(target, { at: Date.now(), command: tool.command, installed });
  return installed;
}

function commandLooksLikePath(command: string) {
  return command.includes("/") || command.includes("\\");
}

function formatUpdateResult(result: RunResult & { target: string }) {
  const body = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return `## ${result.target}\n${body || `(exit ${result.code})`}`;
}

function extractZeroclawSummary(text: string) {
  let provider = "";
  let model = "";
  let autonomy = "";
  for (const line of stripAnsi(`${text || ""}`).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("Provider:")) provider = trimmed.replace("Provider:", "").trim();
    if (trimmed.startsWith("Model:")) model = trimmed.replace("Model:", "").trim();
    if (trimmed.startsWith("Autonomy:")) autonomy = trimmed.replace("Autonomy:", "").trim();
  }
  return [provider, model, autonomy].filter(Boolean).join(" / ") || firstNonEmpty(text);
}

export async function statusPayload() {
  const now = Date.now();
  if (cachedStatus && now - cachedStatus.at < statusCacheMs) {
    return { ...cachedStatus.payload, cached: true };
  }
  if (inflightStatus) {
    return { ...(await inflightStatus), cached: true };
  }
  const pending = buildStatusPayload()
    .then((payload) => {
      cachedStatus = { at: Date.now(), payload };
      return payload;
    })
    .finally(() => {
      if (inflightStatus === pending) inflightStatus = null;
    });
  inflightStatus = pending;
  return pending;
}

async function buildStatusPayload() {
  const entries = await Promise.all(agentDefinitions.map(async (agent) => {
    const tool = tools[agent.id];
    const installed = await isToolInstalled(agent.id);
    const versionArgs = [tool.command, ...agent.versionArgs];
    const statusArgs = agent.statusArgs ? [tool.command, ...agent.statusArgs] : null;
    const modelArgs = agent.modelArgs ? [tool.command, ...agent.modelArgs] : null;
    const [version, status, models] = await Promise.all([
      installed ? runCommand(versionArgs, { timeout: 30 }) : Promise.resolve(emptyRunResult(versionArgs)),
      installed && statusArgs ? runCommand(statusArgs, { timeout: 30 }) : Promise.resolve(statusArgs ? emptyRunResult(statusArgs) : null),
      installed && modelArgs ? runCommand(modelArgs, { timeout: 12 }) : Promise.resolve(modelArgs ? emptyRunResult(modelArgs) : null),
    ]);
    return [agent.id, {
      path: tool.command,
      source: tool.source,
      summary: firstLine(version),
      models: statusOrModelSummary(agent.id, status, models),
      installed,
      message: installed ? "" : `설치 필요 또는 ${envNameForTool(agent.id)} 지정 필요`,
      ok: installed && version.ok,
    }] as const;
  }));

  const payload: StatusPayload = {
    cwd: defaultCwd,
    agents: agentMetadata(),
    presets: presetMetadata,
    tools: Object.fromEntries(entries),
  };
  return payload;
}

export function chatCommand(payload: Record<string, unknown>) {
  const agent = String(payload.agent || "pi").toLowerCase();
  const definition = agentDefinition(agent);
  const prompt = String(payload.prompt || "").trim();
  const thinking = String(payload.thinking || "high").trim();
  const speed = normalizeSpeed(payload.speed);
  const timeout = Number(payload.timeout || 600);
  const promptForSpeed = speedPrompt(prompt, speed);

  if (!prompt) throw new Error("메시지가 비어 있습니다.");
  if (!definition?.supportsChat) throw new Error(`알 수 없는 에이전트입니다: ${agent}`);

  if (definition.chatKind === "hermes") {
    const args = [
      tools[agent].command,
      "--provider",
      defaultProvider,
      "--model",
      defaultModel,
    ];

    if (speed === "fast") {
      args.push("--ignore-rules", "--toolsets", "clarify");
    } else if (speed === "balanced") {
      args.push("--toolsets", "terminal,file,memory,skills,clarify");
    } else {
      args.push("--toolsets", "web,browser,terminal,file,memory,session_search,skills,todo,cronjob,code_execution,delegation,clarify");
    }

    args.push("-z", promptForSpeed);
    return { args, timeout };
  }

  if (definition.chatKind === "pi") {
    const piThinking = speed === "fast" ? "minimal" : speed === "balanced" ? "low" : thinking;
    const args = [
      tools[agent].command,
      "--model",
      `${defaultProvider}/${defaultModel}:${piThinking}`,
      "--print",
    ];

    if (speed === "fast") {
      args.push("--no-tools", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-session");
    } else if (speed === "balanced") {
      args.push("--tools", "read,grep,find,ls", "--no-session");
    } else {
      args.push("--tools", "read,bash,edit,write,grep,find,ls");
    }

    args.push(promptForSpeed);
    return { args, timeout };
  }

  if (definition.chatKind === "zeroclaw") {
    return {
      args: [
        tools[agent].command,
        "agent",
        "--provider",
        defaultProvider,
        "--model",
        defaultModel,
        "--temperature",
        speed === "fast" ? "0.2" : speed === "balanced" ? "0.5" : "0.7",
        "--message",
        promptForSpeed,
      ],
      timeout,
    };
  }

  throw new Error(`알 수 없는 에이전트입니다: ${agent}`);
}

function normalizeSpeed(value: unknown) {
  const speed = String(value || "fast").toLowerCase();
  return speed === "balanced" || speed === "deep" ? speed : "fast";
}

function statusOrModelSummary(agent: string, status: RunResult | null, models: RunResult | null) {
  if (agent === "zeroclaw" && status) return extractZeroclawSummary(status.stdout || status.stderr);
  if (models) return (models.stdout || models.stderr).trim();
  if (status) return firstNonEmpty(status.stdout || status.stderr);
  return "";
}

function speedPrompt(prompt: string, speed: string) {
  if (speed === "fast") {
    return `${prompt}\n\n[응답 모드: 빠름] 짧게 바로 답하고, 필요 없는 도구 사용과 긴 설명은 피하세요.`;
  }
  if (speed === "balanced") {
    return `${prompt}\n\n[응답 모드: 균형] 필요한 확인만 하고 간결하게 답하세요.`;
  }
  return `${prompt}\n\n[응답 모드: 깊게] 정확성을 우선하고 필요한 도구와 검증을 사용하세요.`;
}
