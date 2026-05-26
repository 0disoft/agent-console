import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  defaultCwd,
  defaultModel,
  defaultProvider,
  envNameForTool,
  home,
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
  return runCommand([
    "powershell",
    "-NoProfile",
    "-Command",
    `Start-Process -FilePath 'wscript.exe' -ArgumentList '"${script}"' -WindowStyle Hidden`,
  ], { cwd: defaultCwd, timeout: 30 });
}

export async function updateAgent(target: keyof typeof updateTargets, cwd?: string, signal?: AbortSignal) {
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
  if (process.platform !== "win32") {
    return {
      ...first,
      stderr: [
        first.stderr,
        "Automatic GitHub release fallback is currently Windows-only. Please update ZeroClaw manually on this OS.",
      ].filter(Boolean).join("\n"),
    };
  }

  const fallback = await installZeroclawWindowsRelease(cwd, signal);
  return mergeRetryResult(
    first,
    fallback,
    "ZeroClaw updater selected the wrong architecture. Retrying with the Windows x86_64 GitHub release asset.",
  );
}

async function installZeroclawWindowsRelease(cwd?: string, signal?: AbortSignal) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "$tempRoot = Join-Path $env:TEMP ('zeroclaw-update-' + [guid]::NewGuid().ToString('N'))",
    "try {",
    "$url = 'https://github.com/zeroclaw-labs/zeroclaw/releases/latest/download/zeroclaw-x86_64-pc-windows-msvc.zip'",
    "New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null",
    "$zip = Join-Path $tempRoot 'zeroclaw.zip'",
    "Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing",
    "Expand-Archive -LiteralPath $zip -DestinationPath $tempRoot -Force",
    "$exe = Get-ChildItem -LiteralPath $tempRoot -Recurse -Filter zeroclaw.exe | Select-Object -First 1",
    "if (-not $exe) { throw 'Downloaded archive did not contain zeroclaw.exe' }",
    "$destDir = Join-Path $env:USERPROFILE '.cargo\\bin'",
    "New-Item -ItemType Directory -Force -Path $destDir | Out-Null",
    "$dest = Join-Path $destDir 'zeroclaw.exe'",
    "Get-Process -Name zeroclaw -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue",
    "Start-Sleep -Milliseconds 300",
    "if (Test-Path $dest) { Copy-Item -LiteralPath $dest -Destination ($dest + '.bak.' + (Get-Date -Format 'yyyyMMdd_HHmmss')) -Force }",
    "Copy-Item -LiteralPath $exe.FullName -Destination $dest -Force",
    "& $dest --version",
    "} finally {",
    "if (Test-Path $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }",
    "}",
  ].join("\n");

  return runCommand(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    cwd,
    timeout: 1800,
    signal,
  });
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
  const checks = await Promise.all((Object.keys(updateTargets) as Array<keyof typeof updateTargets>).map(async (target) => ({
    target,
    installed: await isToolInstalled(target),
  })));
  return checks.filter((item) => item.installed).map((item) => item.target);
}

async function assertToolInstalled(target: ToolName) {
  if (await isToolInstalled(target)) return;
  throw new Error(`${target} 실행 파일을 찾지 못했습니다. 설치하거나 ${envNameForTool(target)} 환경 변수를 지정하세요.`);
}

async function isToolInstalled(target: ToolName, versionOk = false) {
  if (versionOk) return true;
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
  inflightStatus = buildStatusPayload().finally(() => {
    inflightStatus = null;
  });
  return inflightStatus;
}

async function buildStatusPayload() {
  const [hermesInstalled, piInstalled, zcInstalled] = await Promise.all([
    isToolInstalled("hermes"),
    isToolInstalled("pi"),
    isToolInstalled("zeroclaw"),
  ]);

  const hermesVersionArgs = [tools.hermes.command, "version"];
  const piVersionArgs = [tools.pi.command, "--version"];
  const zcVersionArgs = [tools.zeroclaw.command, "--version"];
  const zcStatusArgs = [tools.zeroclaw.command, "status"];
  const piModelsArgs = [tools.pi.command, "--list-models", defaultModel];

  const [hermesVersion, piVersion, zcVersion, zcStatus, piModels] = await Promise.all([
    hermesInstalled ? runCommand(hermesVersionArgs, { timeout: 30 }) : Promise.resolve(emptyRunResult(hermesVersionArgs)),
    piInstalled ? runCommand(piVersionArgs, { timeout: 30 }) : Promise.resolve(emptyRunResult(piVersionArgs)),
    zcInstalled ? runCommand(zcVersionArgs, { timeout: 30 }) : Promise.resolve(emptyRunResult(zcVersionArgs)),
    zcInstalled ? runCommand(zcStatusArgs, { timeout: 30 }) : Promise.resolve(emptyRunResult(zcStatusArgs)),
    piInstalled ? runCommand(piModelsArgs, { timeout: 12 }) : Promise.resolve(emptyRunResult(piModelsArgs)),
  ]);

  const payload: StatusPayload = {
    cwd: defaultCwd,
    tools: {
      hermes: {
        path: tools.hermes.command,
        source: tools.hermes.source,
        summary: firstLine(hermesVersion),
        installed: hermesInstalled,
        message: hermesInstalled ? "" : `설치 필요 또는 HERMES_BIN 지정 필요`,
        ok: hermesInstalled && hermesVersion.ok,
      },
      pi: {
        path: tools.pi.command,
        source: tools.pi.source,
        summary: firstLine(piVersion),
        models: (piModels.stdout || piModels.stderr).trim(),
        installed: piInstalled,
        message: piInstalled ? "" : `설치 필요 또는 PI_BIN 지정 필요`,
        ok: piInstalled && piVersion.ok,
      },
      zeroclaw: {
        path: tools.zeroclaw.command,
        source: tools.zeroclaw.source,
        summary: firstLine(zcVersion),
        models: extractZeroclawSummary(zcStatus.stdout),
        installed: zcInstalled,
        message: zcInstalled ? "" : `설치 필요 또는 ZEROCLAW_BIN 지정 필요`,
        ok: zcInstalled && zcVersion.ok,
      },
    },
  };
  cachedStatus = { at: Date.now(), payload };
  return payload;
}

export function chatCommand(payload: Record<string, unknown>) {
  const agent = String(payload.agent || "pi").toLowerCase();
  const prompt = String(payload.prompt || "").trim();
  const thinking = String(payload.thinking || "high").trim();
  const speed = normalizeSpeed(payload.speed);
  const timeout = Number(payload.timeout || 600);
  const promptForSpeed = speedPrompt(prompt, speed);

  if (!prompt) throw new Error("메시지가 비어 있습니다.");

  if (agent === "hermes") {
    const args = [
      tools.hermes.command,
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

  if (agent === "pi") {
    const piThinking = speed === "fast" ? "minimal" : speed === "balanced" ? "low" : thinking;
    const args = [
      tools.pi.command,
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

  if (agent === "zeroclaw") {
    return {
      args: [
        tools.zeroclaw.command,
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

function speedPrompt(prompt: string, speed: string) {
  if (speed === "fast") {
    return `${prompt}\n\n[응답 모드: 빠름] 짧게 바로 답하고, 필요 없는 도구 사용과 긴 설명은 피하세요.`;
  }
  if (speed === "balanced") {
    return `${prompt}\n\n[응답 모드: 균형] 필요한 확인만 하고 간결하게 답하세요.`;
  }
  return `${prompt}\n\n[응답 모드: 깊게] 정확성을 우선하고 필요한 도구와 검증을 사용하세요.`;
}
