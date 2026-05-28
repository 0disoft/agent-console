import { defaultCwd, resolveCwd, timeoutDefault } from "./config";
import type { RunOptions, RunResult } from "./types";

export function printableCommand(args: string[]) {
  return args.map((arg) => {
    const text = String(arg);
    return /[\s"]/.test(text) ? `"${text.replaceAll('"', '\\"')}"` : text;
  }).join(" ");
}

export async function runCommand(args: string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutSeconds = Number(options.timeout || timeoutDefault);
  let cwd = defaultCwd;
  let timedOut = false;
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let exited = false;

  try {
    cwd = resolveCwd(options.cwd);
    child = Bun.spawn(args, {
      cwd,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
      },
      stdin: options.interactiveInput ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (options.interactiveInput) registerInputWriter(child, options);
    options.onStart?.({ command: printableCommand(args), cwd });

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

      const result = {
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
      options.onDone?.(result);
      return result;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortHandler);
      if (child && !exited) killProcess(child);
    }
  } catch (error) {
    const result = {
      ok: false,
      code: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      command: printableCommand(args),
      cwd,
    };
    options.onDone?.(result);
    return result;
  }
}

export function streamCommandResponse(args: string[], options: RunOptions = {}) {
  const timeoutSeconds = Number(options.timeout || timeoutDefault);
  const command = printableCommand(args);
  const encoder = new TextEncoder();
  let cwd = defaultCwd;

  try {
    cwd = resolveCwd(options.cwd);
  } catch (error) {
    const result = {
      ok: false,
      code: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      command,
      cwd,
    };
    options.onDone?.(result);
    return new Response(JSON.stringify({
      ok: result.ok,
      code: result.code,
      command,
      cwd,
      stderr: result.stderr,
    }, null, 2), {
      status: 400,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

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
          stdin: options.interactiveInput ? "pipe" : "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        if (options.interactiveInput) registerInputWriter(child, options);

        send({ type: "start", command, cwd });
        options.onStart?.({ command, cwd });
        timer = setTimeout(() => {
          timedOut = true;
          if (child) killProcess(child);
        }, timeoutSeconds * 1000);
        options.signal?.addEventListener("abort", abortHandler, { once: true });

        const stdout = pipeProcessStream(child.stdout, "stdout", send, options.onOutput);
        const stderr = pipeProcessStream(child.stderr, "stderr", send, options.onOutput);
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

        const result = {
          ok: !timedOut && !aborted && code === 0,
          code: timedOut || aborted ? null : code,
          stdout: "",
          stderr: "",
          command,
          cwd,
        };
        send({
          type: "done",
          ok: result.ok,
          code: result.code,
          command,
          cwd,
        });
        options.onDone?.(result);
      } catch (error) {
        const result = {
          ok: false,
          code: null,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          command,
          cwd,
        };
        send({
          type: "done",
          ok: false,
          code: null,
          command,
          cwd,
          stderr: result.stderr,
        });
        options.onDone?.(result);
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
  onOutput?: (event: { stream: "stdout" | "stderr"; text: string }) => void,
) {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = outputDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) {
        onOutput?.({ stream: type, text });
        send({ type, text });
      }
    }
    const tail = decoder.decode();
    if (tail) {
      onOutput?.({ stream: type, text: tail });
      send({ type, text: tail });
    }
  } finally {
    reader.releaseLock();
  }
}

function registerInputWriter(child: ReturnType<typeof Bun.spawn>, options: RunOptions) {
  const stdin = child.stdin;
  if (!stdin) return;
  const encoder = new TextEncoder();
  if (typeof stdin.write === "function") {
    options.onInput?.(async (text: string) => {
      try {
        await stdin.write(encoder.encode(text));
        return true;
      } catch {
        return false;
      }
    });
    return;
  }
  if (typeof stdin.getWriter !== "function") return;
  options.onInput?.(async (text: string) => {
    const writer = stdin.getWriter();
    try {
      await writer.write(encoder.encode(text));
      return true;
    } catch {
      return false;
    } finally {
      writer.releaseLock();
    }
  });
}

function killProcess(child: { kill: () => void; pid?: number }) {
  if (process.platform === "win32" && child.pid) {
    try {
      Bun.spawnSync(["taskkill.exe", "/PID", String(child.pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch (error) {
      console.warn(`taskkill failed; falling back to child.kill(): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
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
