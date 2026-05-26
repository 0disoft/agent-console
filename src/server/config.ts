import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ToolName, ToolResolution } from "./types";

export const root = resolve(import.meta.dir, "..", "..");
export const publicDir = join(root, "public");
export const home = process.env.USERPROFILE || process.env.HOME || "";
export const host = "127.0.0.1";
export const port = Number(process.env.AGENT_CONSOLE_PORT || 8765);
export const timeoutDefault = 600;
export const defaultModel = process.env.AGENT_CONSOLE_MODEL || "gpt-5.5";
export const defaultProvider = process.env.AGENT_CONSOLE_PROVIDER || "openai-codex";
export const defaultCwd = chooseDefaultCwd();

export const tools: Record<ToolName, ToolResolution> = {
  hermes: resolveTool("hermes", "HERMES_BIN", [
    join(home, "AppData", "Local", "hermes", "hermes-agent", "venv", "Scripts", "hermes.exe"),
    join(home, ".local", "bin", "hermes"),
    join(home, ".hermes", "bin", "hermes"),
  ]),
  pi: resolveTool("pi", "PI_BIN", [
    join(home, ".bun", "bin", executableName("pi")),
    join(home, ".local", "bin", "pi"),
  ]),
  zeroclaw: resolveTool("zeroclaw", "ZEROCLAW_BIN", [
    join(home, ".cargo", "bin", executableName("zeroclaw")),
    join(home, ".local", "bin", "zeroclaw"),
  ]),
};

export const presets = {
  hermes_status: [tools.hermes.command, "status"],
  hermes_config: [tools.hermes.command, "config", "show"],
  hermes_skills: [tools.hermes.command, "skills", "list"],
  hermes_tools: [tools.hermes.command, "tools", "--summary", "list"],
  hermes_logs: [tools.hermes.command, "logs"],
  pi_models: [tools.pi.command, "--list-models", defaultModel],
  pi_packages: [tools.pi.command, "list"],
  pi_version: [tools.pi.command, "--version"],
  zeroclaw_status: [tools.zeroclaw.command, "status"],
  zeroclaw_doctor: [tools.zeroclaw.command, "doctor"],
  zeroclaw_version: [tools.zeroclaw.command, "--version"],
};

export const updateTargets = {
  hermes: [tools.hermes.command, "update", "--yes"],
  pi: [tools.pi.command, "update"],
  zeroclaw: [tools.zeroclaw.command, "update", "--force"],
};

function executableName(name: string) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function chooseDefaultCwd() {
  const candidates = [
    join(home, "Documents", "workspace"),
    join(home, "workspace"),
    home,
    root,
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try {
      return existsSync(candidate) && statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  }) || root;
}

function resolveTool(commandName: string, envName: string, knownPaths: string[]): ToolResolution {
  const envValue = process.env[envName]?.trim();
  if (envValue) {
    return { command: envValue, source: "env" };
  }

  const knownPath = knownPaths.find((candidate) => existsSync(candidate));
  if (knownPath) {
    return { command: knownPath, source: "known-path" };
  }

  return { command: commandName, source: "path" };
}

export function resolveCwd(value?: string) {
  const raw = String(value || defaultCwd).trim() || defaultCwd;
  const candidate = resolve(raw);
  if (!existsSync(candidate)) {
    throw new Error(`작업 폴더가 존재하지 않습니다: ${candidate}`);
  }
  if (!statSync(candidate).isDirectory()) {
    throw new Error(`작업 폴더가 디렉터리가 아닙니다: ${candidate}`);
  }
  return candidate;
}

export function envNameForTool(target: ToolName) {
  if (target === "hermes") return "HERMES_BIN";
  if (target === "pi") return "PI_BIN";
  return "ZEROCLAW_BIN";
}
