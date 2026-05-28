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

export type AgentDefinition = {
  id: string;
  label: string;
  commandName: string;
  envName: string;
  knownPaths: string[];
  chatKind: "hermes" | "pi" | "zeroclaw";
  supportsChat: boolean;
  supportsThinking?: boolean;
  updateCommand?: string[];
  updateArgs?: string[];
  versionArgs: string[];
  modelArgs?: string[];
  statusArgs?: string[];
  presets?: Array<{
    key: string;
    label: string;
    args: string[];
  }>;
};

export const agentDefinitions: AgentDefinition[] = [
  {
    id: "hermes",
    label: "Hermes",
    commandName: "hermes",
    envName: "HERMES_BIN",
    knownPaths: [
      join(home, "AppData", "Local", "hermes", "hermes-agent", "venv", "Scripts", "hermes.exe"),
      join(home, ".local", "bin", "hermes"),
      join(home, ".hermes", "bin", "hermes"),
    ],
    chatKind: "hermes",
    supportsChat: true,
    updateArgs: ["update", "--yes"],
    versionArgs: ["version"],
    presets: [
      { key: "hermes_status", label: "Hermes 상태", args: ["status"] },
      { key: "hermes_config", label: "Hermes 설정", args: ["config", "show"] },
      { key: "hermes_skills", label: "Hermes 스킬", args: ["skills", "list"] },
      { key: "hermes_tools", label: "Hermes 도구", args: ["tools", "--summary", "list"] },
      { key: "hermes_logs", label: "Hermes 로그", args: ["logs"] },
    ],
  },
  {
    id: "pi",
    label: "Pi",
    commandName: "pi",
    envName: "PI_BIN",
    knownPaths: [
      join(home, ".bun", "bin", executableName("pi")),
      join(home, ".local", "bin", "pi"),
    ],
    chatKind: "pi",
    supportsChat: true,
    supportsThinking: true,
    updateArgs: ["update"],
    versionArgs: ["--version"],
    modelArgs: ["--list-models", defaultModel],
    presets: [
      { key: "pi_models", label: "Pi 모델", args: ["--list-models", defaultModel] },
      { key: "pi_packages", label: "Pi 패키지", args: ["list"] },
      { key: "pi_version", label: "Pi 버전", args: ["--version"] },
    ],
  },
  {
    id: "zeroclaw",
    label: "ZeroClaw",
    commandName: "zeroclaw",
    envName: "ZEROCLAW_BIN",
    knownPaths: [
      join(home, ".zeroclaw", "bin", executableName("zeroclaw")),
      join(home, ".cargo", "bin", executableName("zeroclaw")),
      join(home, ".local", "bin", "zeroclaw"),
    ],
    chatKind: "zeroclaw",
    supportsChat: true,
    updateCommand: process.platform === "win32"
      ? ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts", "update-zeroclaw-windows.ps1")]
      : undefined,
    versionArgs: ["--version"],
    statusArgs: ["status"],
    presets: [
      { key: "zeroclaw_status", label: "ZeroClaw 상태", args: ["status"] },
      { key: "zeroclaw_doctor", label: "ZeroClaw 진단", args: ["doctor"] },
      { key: "zeroclaw_version", label: "ZeroClaw 버전", args: ["--version"] },
    ],
  },
];

export const tools: Record<ToolName, ToolResolution> = Object.fromEntries(
  agentDefinitions.map((agent) => [agent.id, resolveTool(agent.commandName, agent.envName, agent.knownPaths)]),
);

const bunCommand = process.execPath || "bun";

const localPresets = [
  {
    key: "apply_free_agent_profile",
    label: "자유 설정 적용",
    args: [bunCommand, join(root, "scripts", "apply-agent-profile.ts")],
  },
];

const localPresetMetadata = localPresets.map((preset) => ({
  key: preset.key,
  label: preset.label,
  agents: agentDefinitions.map((agent) => agent.id),
  require: "any" as const,
}));

export const presets = Object.fromEntries(
  [
    ...agentDefinitions.flatMap((agent) => (agent.presets || []).map((preset) => [
      preset.key,
      [tools[agent.id].command, ...preset.args],
    ])),
    ...localPresets.map((preset) => [preset.key, preset.args]),
  ],
) as Record<string, string[]>;

export const presetMetadata = agentDefinitions.flatMap((agent) => (agent.presets || []).map((preset) => ({
  key: preset.key,
  label: preset.label,
  agent: agent.id,
  agents: [agent.id],
  require: "all" as const,
}))).concat(localPresetMetadata);

export const updateTargets = Object.fromEntries(
  agentDefinitions
    .filter((agent) => agent.updateCommand?.length || agent.updateArgs?.length)
    .map((agent) => [agent.id, agent.updateCommand || [tools[agent.id].command, ...agent.updateArgs!]]),
) as Record<string, string[]>;

export function agentDefinition(id: string) {
  return agentDefinitions.find((agent) => agent.id === id);
}

export function agentLabel(id: string) {
  return agentDefinition(id)?.label || id;
}

export function agentMetadata() {
  return agentDefinitions.map((agent) => ({
    id: agent.id,
    label: agent.label,
    supportsChat: agent.supportsChat,
    supportsUpdate: Boolean(agent.updateCommand?.length || agent.updateArgs?.length),
    supportsThinking: Boolean(agent.supportsThinking),
  }));
}

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
  return agentDefinition(target)?.envName || `${target.toUpperCase()}_BIN`;
}
