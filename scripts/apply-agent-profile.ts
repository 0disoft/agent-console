import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const home = process.env.USERPROFILE || process.env.HOME || homedir();
const stamp = timestamp();
const changes: string[] = [];
const warnings: string[] = [];
const skipHermes = process.argv.includes("--skip-hermes") || process.env.AGENT_CONSOLE_PROFILE_SKIP_HERMES === "1";

main();

function main() {
  console.log("Agent Console 자유 설정 프로파일 적용");
  console.log("백업을 만든 뒤 Hermes, Pi, ZeroClaw 설정을 현재 PC의 개방형 프로파일에 맞춥니다.");
  console.log("");

  configureZeroclaw();
  configurePi();
  configureEnvHelpers();
  configureHermes();

  console.log("");
  console.log("변경 사항");
  for (const change of changes) console.log(`- ${change}`);
  if (!changes.length) console.log("- 변경 없음");

  if (warnings.length) {
    console.log("");
    console.log("주의");
    for (const warning of warnings) console.log(`- ${warning}`);
  }

  console.log("");
  console.log("완료. Agent Console에서 상태/진단을 다시 실행해 확인하세요.");
}

function configureZeroclaw() {
  const configPath = join(home, ".zeroclaw", "config.toml");
  let text = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  if (!text.trim()) {
    text = [
      'default_provider = "openai-codex"',
      'default_model = "gpt-5.5"',
      "default_temperature = 0.7",
      "provider_timeout_secs = 120",
      "",
    ].join("\n");
  }
  backupIfExists(configPath);

  text = setTomlValue(text, null, "default_provider", tomlString("openai-codex"));
  text = setTomlValue(text, null, "default_model", tomlString("gpt-5.5"));
  text = setTomlValue(text, null, "default_temperature", "0.7");
  text = setTomlValue(text, null, "provider_timeout_secs", "120");

  text = setTomlValue(text, "autonomy", "level", tomlString("full"));
  text = setTomlValue(text, "autonomy", "workspace_only", "false");
  text = setTomlValue(text, "autonomy", "allowed_commands", '["*"]');
  text = setTomlValue(text, "autonomy", "forbidden_paths", "[]");
  text = setTomlValue(text, "autonomy", "max_actions_per_hour", "200");
  text = setTomlValue(text, "autonomy", "max_cost_per_day_cents", "3000");
  text = setTomlValue(text, "autonomy", "require_approval_for_medium_risk", "false");
  text = setTomlValue(text, "autonomy", "block_high_risk_commands", "false");
  text = setTomlValue(text, "autonomy", "auto_approve", '["*"]');
  text = setTomlValue(text, "autonomy", "always_ask", "[]");
  text = setTomlValue(text, "autonomy", "allowed_roots", "[]");
  text = setTomlValue(text, "autonomy", "shell_timeout_secs", "60");

  text = setTomlValue(text, "agent", "compact_context", "false");
  text = setTomlValue(text, "agent", "max_tool_iterations", "10");
  text = setTomlValue(text, "agent", "max_history_messages", "50");
  text = setTomlValue(text, "agent", "max_context_tokens", "32000");
  text = setTomlValue(text, "agent", "parallel_tools", "true");
  text = setTomlValue(text, "agent", "max_tool_result_chars", "50000");
  text = setTomlValue(text, "agent", "keep_tool_context_turns", "2");
  text = setTomlValue(text, "agent.thinking", "default_level", tomlString("medium"));

  text = setTomlValue(text, "scheduler", "enabled", "true");
  text = setTomlValue(text, "scheduler", "max_tasks", "64");
  text = setTomlValue(text, "scheduler", "max_concurrent", "4");
  text = setTomlValue(text, "backup", "enabled", "true");
  text = setTomlValue(text, "backup", "max_keep", "10");
  text = setTomlValue(text, "observability", "backend", tomlString("none"));
  text = setTomlValue(text, "observability", "log_persistence", tomlString("rolling"));
  text = setTomlValue(text, "observability", "log_persistence_path", tomlString("state/runtime-trace.jsonl"));
  text = setTomlValue(text, "observability", "log_tool_io", tomlString("redacted"));
  text = setTomlValue(text, "observability", "log_tool_io_truncate_bytes", "8192");
  text = setTomlValue(text, "reliability", "provider_retries", "2");
  text = setTomlValue(text, "reliability", "provider_backoff_ms", "500");
  text = setTomlValue(text, "reliability", "scheduler_poll_secs", "15");
  text = setTomlValue(text, "reliability", "scheduler_retries", "2");
  text = setTomlValue(text, "pacing", "loop_detection_enabled", "true");
  text = setTomlValue(text, "pacing", "loop_detection_window_size", "20");
  text = setTomlValue(text, "pacing", "loop_detection_max_repeats", "3");
  text = setTomlValue(text, "memory", "hygiene_enabled", "true");
  text = setTomlValue(text, "memory", "response_cache_enabled", "true");
  text = setTomlValue(text, "memory", "response_cache_hot_entries", "256");
  text = setTomlValue(text, "memory", "response_cache_max_entries", "5000");
  text = setTomlValue(text, "memory", "response_cache_ttl_minutes", "60");

  text = setTomlValue(text, "security.otp", "enabled", "false");
  text = setTomlValue(text, "security.estop", "enabled", "false");
  text = setTomlValue(text, "skills", "open_skills_enabled", "false");
  text = setTomlValue(text, "skills", "allow_scripts", "false");
  text = setTomlValue(text, "skills", "prompt_injection_mode", tomlString("full"));

  writeText(configPath, text);
  changes.push(`ZeroClaw: ${configPath}`);
  warnings.push("ZeroClaw autonomy를 full로 열고 workspace_only=false, allowed_commands/auto_approve=* 로 설정했습니다.");
}

function configurePi() {
  const dir = process.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
  const settingsPath = join(dir, "settings.json");
  mkdirSync(dir, { recursive: true });

  const settings = readJson(settingsPath);
  backupIfExists(settingsPath);
  writeJson(settingsPath, {
    ...settings,
    defaultProvider: "openai-codex",
    defaultModel: "gpt-5.5",
    defaultThinkingLevel: "high",
    hideThinkingBlock: false,
    theme: "dark",
    quietStartup: true,
    collapseChangelog: true,
    enableInstallTelemetry: false,
    doubleEscapeAction: "tree",
    treeFilterMode: "all",
    autocompleteMaxVisible: 8,
    showHardwareCursor: true,
    retry: {
      ...(typeof settings.retry === "object" && settings.retry ? settings.retry : {}),
      enabled: true,
      maxRetries: 3,
    },
    compaction: {
      ...(typeof settings.compaction === "object" && settings.compaction ? settings.compaction : {}),
      enabled: true,
      reserveTokens: 12000,
      keepRecentTokens: 20000,
    },
  });
  changes.push(`Pi settings: ${settingsPath}`);

  writeProfileFile(join(dir, "AGENTS.md"), piAgentsMd(), "Pi profile");
  writeProfileFile(join(dir, "APPEND_SYSTEM.md"), piAppendSystemMd(), "Pi profile");
}

function configureHermes() {
  if (skipHermes) {
    warnings.push("Hermes 설정은 --skip-hermes/AGENT_CONSOLE_PROFILE_SKIP_HERMES=1 때문에 건너뛰었습니다.");
    return;
  }

  const hermes = findHermesCommand();
  if (!hermes) {
    warnings.push("Hermes 실행 파일을 찾지 못해 Hermes 설정은 건너뛰었습니다.");
    return;
  }

  const configPath = run([hermes, "config", "path"]).stdout.trim();
  if (configPath) backupIfExists(configPath);

  const commands = [
    ["model.default", "gpt-5.5"],
    ["model.provider", "openai-codex"],
    ["model.base_url", "https://chatgpt.com/backend-api/codex"],
    ["agent.max_turns", "90"],
    ["agent.reasoning_effort", "high"],
    ["terminal.backend", "local"],
    ["terminal.cwd", "."],
    ["terminal.timeout", "180"],
    ["terminal.persistent_shell", "true"],
    ["browser.allow_private_urls", "true"],
    ["file_read_max_chars", "100000"],
    ["tool_output.max_bytes", "50000"],
    ["tool_output.max_lines", "2000"],
    ["tool_loop_guardrails.hard_stop_enabled", "false"],
  ];

  for (const [key, value] of commands) {
    const result = run([hermes, "config", "set", key, value]);
    if (!result.ok) warnings.push(`Hermes config set 실패: ${key}=${value} (${result.stderr || result.stdout})`);
  }
  if (configPath) configureHermesProfileFiles(dirname(configPath));
  changes.push(`Hermes: ${configPath || "config set"}`);
}

function configureHermesProfileFiles(baseDir: string) {
  writeProfileFile(join(baseDir, "memories", "MEMORY.md"), hermesMemoryMd(), "Hermes memory");
  writeProfileFile(join(baseDir, "memories", "USER.md"), hermesUserMd(), "Hermes memory");
  writeProfileFile(join(baseDir, "skills", "repo-maintainer", "SKILL.md"), hermesRepoMaintainerSkill(), "Hermes skill");
}

function configureEnvHelpers() {
  const dir = join(home, ".agent-console");
  writeProfileFile(join(dir, "agent-env.ps1"), windowsEnvHelper(), "env helper");
  writeProfileFile(join(dir, "agent-env.sh"), unixEnvHelper(), "env helper");
}

function writeProfileFile(path: string, content: string, label: string) {
  backupIfExists(path);
  writeText(path, content);
  changes.push(`${label}: ${path}`);
}

function piAgentsMd() {
  return `# Global Pi Rules

## Role
- Treat Pi as a repository-focused coding worker.
- Prefer reading the current project before proposing architecture or edits.
- Use the current working directory as the task boundary unless the user names another path.

## Before Editing
- Inspect project instructions first: AGENTS.md, CLAUDE.md, .pi/APPEND_SYSTEM.md, or nearby docs.
- Run git status when the directory is a Git repository.
- Identify the package manager and the narrowest useful test command from lockfiles and scripts.
- Read nearby code before changing code.

## During Work
- Keep changes small and directly tied to the user's request.
- Prefer existing project patterns over new abstractions.
- Do not invent files, features, metrics, or architecture without repository evidence.

## Protected Files
- Do not print or edit secrets unless the user explicitly asks for that exact file.
- Treat .env, private keys, browser profiles, SSH config, production credentials, and token stores as sensitive.

## Verification
- After edits, run the narrowest useful test, lint, build, or smoke check.
- If verification cannot run, explain the exact blocker.
- Report changed files, commands run, and remaining risk.
`;
}

function piAppendSystemMd() {
  return `For coding tasks, act as a careful implementation worker: inspect first, edit narrowly, verify concretely, and keep the user informed in Korean unless they switch languages.

When a folder is not a Git repository, do not treat that as missing project access. Use ls, find, grep, read, or bash to inspect the folder directly.

Default to the available OpenAI Codex subscription model gpt-5.5. Use higher thinking effort for non-trivial debugging, architecture, and multi-file edits.
`;
}

function hermesMemoryMd() {
  return `User prefers Korean, direct engineering answers, and concrete verification.
Default development workspace is ~/Documents/workspace when it exists.
For repository work: inspect project instructions first, run git status when available, read relevant files before editing, make narrow changes, and run the smallest useful verification.
Never print API keys, tokens, private keys, browser profiles, SSH config, .env values, or production credentials.
Use OpenAI Codex subscription/provider with gpt-5.5 when available. Prefer high reasoning for debugging, architecture, and multi-file edits.
`;
}

function hermesUserMd() {
  return `The user wants practical local-agent automation, Korean responses, and concise but honest progress reports.
They prefer implementation over proposals, but expect warnings when a setting expands filesystem or shell authority.
`;
}

function hermesRepoMaintainerSkill() {
  return `---
name: repo-maintainer
description: Use when editing, debugging, testing, reviewing, or explaining a software repository.
version: 1.0.0
metadata:
  hermes:
    category: coding
    requires_toolsets: [terminal, file]
---

# Repo Maintainer

## Procedure
1. Read AGENTS.md, HERMES.md, CLAUDE.md, SOUL.md, .cursorrules, or nearby project docs first.
2. Run git status when the folder is a Git repository.
3. Identify the package manager and likely test/build commands from lockfiles and scripts.
4. Inspect relevant files before editing.
5. Make the smallest change that satisfies the request.
6. Run the narrowest useful verification.
7. Report changed files, commands run, and remaining risk.

## Guardrails
- Do not print secrets.
- Do not edit .env, private keys, browser profiles, SSH config, or production credentials unless explicitly asked.
- Do not delete generated-looking files unless the user asks.
- If a destructive command is needed, explain the reason first.
`;
}

function windowsEnvHelper() {
  return `$env:AGENT_CONSOLE_PROVIDER = "openai-codex"
$env:AGENT_CONSOLE_MODEL = "gpt-5.5"
$env:AGENT_CONSOLE_OUTPUT_ENCODING = "utf-8"
$env:PI_SKIP_VERSION_CHECK = "1"
$env:PI_CACHE_RETENTION = "long"
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUTF8 = "1"

Write-Host "Agent Console environment loaded for this PowerShell session."
`;
}

function unixEnvHelper() {
  return `export AGENT_CONSOLE_PROVIDER="openai-codex"
export AGENT_CONSOLE_MODEL="gpt-5.5"
export AGENT_CONSOLE_OUTPUT_ENCODING="utf-8"
export PI_SKIP_VERSION_CHECK="1"
export PI_CACHE_RETENTION="long"
export PYTHONIOENCODING="utf-8"
export PYTHONUTF8="1"

echo "Agent Console environment loaded for this shell session."
`;
}

function setTomlValue(text: string, section: string | null, key: string, value: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const header = section ? `[${section}]` : null;
  let start = 0;
  let end = lines.length;

  if (header) {
    start = lines.findIndex((line) => line.trim() === header);
    if (start === -1) {
      lines.push("", header);
      start = lines.length - 1;
      end = lines.length;
    } else {
      end = lines.findIndex((line, index) => index > start && /^\s*\[.+\]\s*$/.test(line));
      if (end === -1) end = lines.length;
    }
  } else {
    end = lines.findIndex((line) => /^\s*\[.+\]\s*$/.test(line));
    if (end === -1) end = lines.length;
  }

  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  for (let index = start; index < end; index++) {
    if (keyPattern.test(lines[index])) {
      lines[index] = `${key} = ${value}`;
      removeTomlArrayTail(lines, index + 1, end);
      return normalizeFinalNewline(lines.join("\n"));
    }
  }

  lines.splice(header ? start + 1 : end, 0, `${key} = ${value}`);
  return normalizeFinalNewline(lines.join("\n"));
}

function removeTomlArrayTail(lines: string[], start: number, sectionEnd: number) {
  let index = start;
  while (index < sectionEnd && isTomlArrayTailLine(lines[index])) {
    lines.splice(index, 1);
    sectionEnd -= 1;
  }
}

function isTomlArrayTailLine(line: string) {
  const trimmed = line.trim();
  return /^"[^"]*",?$/.test(trimmed) || trimmed === "]";
}

function readJson(path: string) {
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    warnings.push(`JSON을 읽지 못해 새 설정으로 재생성합니다: ${path}`);
    return {};
  }
}

function writeJson(path: string, value: unknown) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, normalizeFinalNewline(text), "utf8");
}

function backupIfExists(path: string) {
  if (!existsSync(path)) return;
  const backup = `${path}.bak.${stamp}`;
  try {
    copyFileSync(path, backup);
    changes.push(`backup: ${backup}`);
  } catch (error) {
    warnings.push(`백업 실패: ${path} (${error instanceof Error ? error.message : String(error)})`);
  }
}

function findHermesCommand() {
  const candidates = [
    process.env.HERMES_BIN || "",
    join(home, "AppData", "Local", "hermes", "hermes-agent", "venv", "Scripts", process.platform === "win32" ? "hermes.exe" : "hermes"),
    join(home, ".local", "bin", "hermes"),
    join(home, ".hermes", "bin", "hermes"),
    "hermes",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate) || run([candidate, "version"], { quiet: true }).ok) || "";
}

function run(args: string[], options: { quiet?: boolean } = {}) {
  try {
    const result = Bun.spawnSync(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    return {
      ok: result.exitCode === 0,
      stdout: new TextDecoder().decode(result.stdout || new Uint8Array()).trim(),
      stderr: new TextDecoder().decode(result.stderr || new Uint8Array()).trim(),
    };
  } catch (error) {
    if (!options.quiet) warnings.push(`명령 실행 실패: ${args.join(" ")} (${error instanceof Error ? error.message : String(error)})`);
    return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

function tomlString(value: string) {
  return JSON.stringify(value);
}

function normalizeFinalNewline(text: string) {
  return `${text.replace(/\s+$/g, "")}\n`;
}

function timestamp() {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
