import { defaultCwd, resolveCwd, timeoutDefault } from "./config";
import type { RunOptions, RunResult } from "./types";

export function printableCommand(args: string[]) {
  return args.map((arg) => {
    const text = String(arg);
    return /[\s"]/.test(text) ? `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : text;
  }).join(" ");
}

export async function runCommand(args: string[], options: RunOptions = {}): Promise<RunResult> {
  const cwd = resolveCwd(options.cwd);
  const timeoutSeconds = Number(options.timeout || timeoutDefault);
  let timedOut = false;
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let exited = false;

  try {
    child = Bun.spawn(args, {
      cwd,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcess(child);
    }, timeoutSeconds * 1000);
    let aborted = false;
    const abortHandler = () => {
      aborted = true;
      killProcess(child);
    };
    options.signal?.addEventListener("abort", abortHandler, { once: true });

    try {
      const [stdout, stderr, code] = await Promise.all([
        readStreamText(child.stdout),
        readStreamText(child.stderr),
        child.exited.then((code) => {
          exited = true;
          return code;
        }).catch(() => {
          exited = true;
          return null;
        }),
      ]);

      return {
        ok: !timedOut && !aborted && code === 0,
        code: timedOut || aborted ? null : code,
        stdout: stripAnsi(stdout),
        stderr: timedOut
          ? stripAnsi(`${stderr}\nTimed out after ${timeoutSeconds} seconds.`.trim())
          : aborted
            ? stripAnsi(`${stderr}\nRequest aborted.`.trim())
            : stripAnsi(stderr),
        command: printableCommand(args),
        cwd,
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortHandler);
      if (child && !exited) killProcess(child);
    }
  } catch (error) {
    return {
      ok: false,
      code: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      command: printableCommand(args),
      cwd,
    };
  }
}

export function streamCommandResponse(args: string[], options: RunOptions = {}) {
  const cwd = resolveCwd(options.cwd);
  const timeoutSeconds = Number(options.timeout || timeoutDefault);
  const command = printableCommand(args);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let timedOut = false;
      let aborted = false;
      let child: ReturnType<typeof Bun.spawn> | null = null;
      let exited = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let closed = false;
      const send = (event: Record<string, unknown>) => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          return true;
        } catch {
          closed = true;
          if (child) killProcess(child);
          return false;
        }
      };
      const abortHandler = () => {
        aborted = true;
        if (child) killProcess(child);
      };

      try {
        child = Bun.spawn(args, {
          cwd,
          env: {
            ...process.env,
            PYTHONIOENCODING: "utf-8",
          },
          stdout: "pipe",
          stderr: "pipe",
        });

        send({ type: "start", command, cwd });
        timer = setTimeout(() => {
          timedOut = true;
          if (child) killProcess(child);
        }, timeoutSeconds * 1000);
        options.signal?.addEventListener("abort", abortHandler, { once: true });

        const stdout = pipeProcessStream(child.stdout, "stdout", send);
        const stderr = pipeProcessStream(child.stderr, "stderr", send);
        const code = await child.exited.then((value) => {
          exited = true;
          return value;
        }).catch(() => {
          exited = true;
          return null;
        });
        await Promise.allSettled([stdout, stderr]);

        if (timedOut) {
          send({ type: "stderr", text: `Timed out after ${timeoutSeconds} seconds.` });
        } else if (aborted) {
          send({ type: "stderr", text: "Request aborted." });
        }

        send({
          type: "done",
          ok: !timedOut && !aborted && code === 0,
          code: timedOut || aborted ? null : code,
          command,
          cwd,
        });
      } catch (error) {
        send({
          type: "done",
          ok: false,
          code: null,
          command,
          cwd,
          stderr: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abortHandler);
        if (child && !exited) killProcess(child);
        if (!closed) {
          try {
            controller.close();
          } catch {
          }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

async function pipeProcessStream(
  stream: ReadableStream<Uint8Array> | null,
  type: "stdout" | "stderr",
  send: (event: Record<string, unknown>) => void,
) {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = outputDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = stripAnsi(decoder.decode(value, { stream: true }));
      if (text) send({ type, text });
    }
    const tail = stripAnsi(decoder.decode());
    if (tail) send({ type, text: tail });
  } finally {
    reader.releaseLock();
  }
}

function killProcess(child: { kill: () => void }) {
  try {
    child.kill();
  } catch {
  }
}

async function readStreamText(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = outputDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function outputDecoder() {
  const encoding = process.env.AGENT_CONSOLE_OUTPUT_ENCODING || "utf-8";
  try {
    return new TextDecoder(encoding);
  } catch {
    return new TextDecoder("utf-8");
  }
}

export function emptyRunResult(args: string[]): RunResult {
  return {
    ok: false,
    code: null,
    stdout: "",
    stderr: "Tool is not installed; command was not run.",
    command: printableCommand(args),
    cwd: defaultCwd,
  };
}

export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function firstLine(result: RunResult) {
  const text = stripAnsi(`${result.stdout || result.stderr || ""}`).trim();
  return text.split(/\r?\n/).find(Boolean) || "";
}

export function firstNonEmpty(text: string) {
  return stripAnsi(`${text || ""}`).split(/\r?\n/).find((line) => line.trim())?.trim() || "";
}

export function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}
