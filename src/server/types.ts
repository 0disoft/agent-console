export type ToolName = "hermes" | "pi" | "zeroclaw";

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
  signal?: AbortSignal;
};
