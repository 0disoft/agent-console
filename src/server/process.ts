import { defaultCwd, resolveCwd, timeoutDefault } from "./config";
import type { RunOptions, RunResult } from "./types";

const ANSI_PATTERN = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const MAX_CAPTURED_OUTPUT_CHARS = 1_000_000;
const OUTPUT_TRUNCATED_MARKER = `\n\n[Agent Console truncated captured output after ${MAX_CAPTURED_OUTPUT_CHARS} characters.]`;

export function printableCommand(args: string[]) {
  return args.map((arg) => JSON.stringify(String(arg))).join(" ");
}

export async function runCommand(args: string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutSeconds = Number(options.timeout || timeoutDefault);
  const command = printableCommand(args);
  let cwd = defaultCwd;
  let timedOut = false;
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let exited = false;

  try {
    cwd = resolveCwd(options.cwd);
    if (options.signal?.aborted) {
      const result = buildAbortResult(command, cwd);
      options.onDone?.(result);
      return result;
    }
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
      options.onStart?.({ command, cwd });
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
        command,
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
      command,
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
  let timedOut = false;
  let aborted = false;
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let exited = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  const abortHandler = () => {
    aborted = true;
    if (child) killProcess(child);
  };

  try {
    cwd = resolveCwd(options.cwd);
    if (options.signal?.aborted) {
      const result = buildAbortResult(command, cwd, "Request was aborted before starting.");
      options.onDone?.(result);
      return jsonResponse({
        ok: result.ok,
        code: result.code,
        command,
        cwd,
        stderr: result.stderr,
      }, 409);
    }
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

      try {
        if (options.signal?.aborted) {
          const result = buildAbortResult(command, cwd, "Request was aborted before starting.");
          send({
            type: "done",
            ok: result.ok,
            code: result.code,
            command,
            cwd,
            stderr: result.stderr,
          });
          options.onDone?.(result);
          return;
        }
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
        heartbeat = setInterval(() => {
          send({ type: "heartbeat", at: new Date().toISOString() });
        }, 2000);
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
        const [stdoutResult, stderrResult] = await Promise.allSettled([stdout, stderr]);
        const stdoutText = stdoutResult.status === "fulfilled" ? stdoutResult.value : "";
        const stderrText = stderrResult.status === "fulfilled" ? stderrResult.value : "";

        if (timedOut) {
          send({ type: "stderr", text: `Timed out after ${timeoutSeconds} seconds.` });
        } else if (aborted) {
          send({ type: "stderr", text: "Request aborted." });
        }

        const result = {
          ok: !timedOut && !aborted && code === 0,
          code: timedOut || aborted ? null : code,
          stdout: stdoutText,
          stderr: timedOut
            ? `${stderrText}${stderrText ? "\n" : ""}Timed out after ${timeoutSeconds} seconds.`
            : aborted
              ? `${stderrText}${stderrText ? "\n" : ""}Request aborted.`
              : stderrText,
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
        if (heartbeat) clearInterval(heartbeat);
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
    cancel() {
      closed = true;
      aborted = true;
      if (child) killProcess(child);
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

function buildAbortResult(command: string, cwd: string, message = "Request was aborted.") {
  return {
    ok: false,
    code: null,
    stdout: "",
    stderr: message,
    command,
    cwd,
  };
}

function jsonResponse(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function pipeProcessStream(
  stream: ReadableStream<Uint8Array> | null,
  type: "stdout" | "stderr",
  send: (event: Record<string, unknown>) => void,
  onOutput?: (event: { stream: "stdout" | "stderr"; text: string }) => void,
) {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = outputDecoder();
  let output = "";
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) {
        ({ text: output, truncated } = appendCapturedOutput(output, truncated, text));
        onOutput?.({ stream: type, text });
        send({ type, text });
      }
    }
    const tail = decoder.decode();
    if (tail) {
      ({ text: output, truncated } = appendCapturedOutput(output, truncated, tail));
      onOutput?.({ stream: type, text: tail });
      send({ type, text: tail });
    }
    return stripAnsi(output);
  } catch {
    const tail = decoder.decode();
    return stripAnsi(`${output}${tail}`);
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
  try {
    child.kill();
  } catch {
  }
  if (process.platform === "win32" && child.pid) {
    let forceTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const killer = spawnTaskkill(child.pid, false);
      forceTimer = setTimeout(() => {
        try {
          spawnTaskkill(child.pid!, true);
        } catch (error) {
          console.warn(`forced taskkill launch failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }, 1500);
      if (typeof forceTimer === "object" && "unref" in forceTimer && typeof forceTimer.unref === "function") {
        forceTimer.unref();
      }
      void killer.exited.then((code) => {
        if (forceTimer) clearTimeout(forceTimer);
        if (code !== 0) spawnTaskkill(child.pid!, true);
      }).catch((error) => {
        if (forceTimer) clearTimeout(forceTimer);
        console.warn(`taskkill failed; forcing process tree: ${error instanceof Error ? error.message : String(error)}`);
        spawnTaskkill(child.pid!, true);
      });
      return;
    } catch (error) {
      if (forceTimer) clearTimeout(forceTimer);
      console.warn(`taskkill launch failed after child.kill(): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function spawnTaskkill(pid: number, force: boolean) {
  return Bun.spawn(["taskkill.exe", "/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

async function readStreamText(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = outputDecoder();
  let text = "";
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      ({ text, truncated } = appendCapturedOutput(text, truncated, decoder.decode(value, { stream: true })));
    }
    ({ text } = appendCapturedOutput(text, truncated, decoder.decode()));
    return text;
  } finally {
    reader.releaseLock();
  }
}

function appendCapturedOutput(current: string, truncated: boolean, chunk: string) {
  if (!chunk || truncated) return { text: current, truncated };
  const remaining = MAX_CAPTURED_OUTPUT_CHARS - current.length;
  if (remaining <= 0) return { text: `${current}${OUTPUT_TRUNCATED_MARKER}`, truncated: true };
  if (chunk.length <= remaining) return { text: `${current}${chunk}`, truncated: false };
  return { text: `${current}${chunk.slice(0, remaining)}${OUTPUT_TRUNCATED_MARKER}`, truncated: true };
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
  return text.replace(ANSI_PATTERN, "");
}
