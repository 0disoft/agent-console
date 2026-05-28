export type ToolName = string;

export type ToolResolution = {
  command: string;
  source: "env" | "known-path" | "path";
};

export type RunResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  command: string;
  cwd: string;
};

export type StatusPayload = {
  cwd: string;
  cached?: boolean;
  agents: Array<{
    id: string;
    label: string;
    supportsChat: boolean;
    supportsUpdate: boolean;
    supportsThinking: boolean;
  }>;
  presets: Array<{
    key: string;
    label: string;
    agent?: string;
    agents?: string[];
    require?: "any" | "all";
  }>;
  tools: Record<string, {
    path: string;
    source: ToolResolution["source"];
    summary: string;
    models?: string;
    installed: boolean;
    message?: string;
    ok: boolean;
  }>;
};

export type RunOptions = {
  cwd?: string;
  timeout?: number;
  interactiveInput?: boolean;
  signal?: AbortSignal;
  onStart?: (event: { command: string; cwd: string }) => void;
  onInput?: (sendInput: (text: string) => Promise<boolean> | boolean) => void;
  onOutput?: (event: { stream: "stdout" | "stderr"; text: string }) => void;
  onDone?: (result: RunResult) => void;
};
