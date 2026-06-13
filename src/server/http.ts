import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  chatCommand,
  clearStatusCache,
  statusPayload,
  updateAgent,
  updateAll,
} from "./agents";
import {
  defaultCwd,
  host,
  listCwdChildDirectories,
  openCwdFolder,
  port,
  presets,
  publicDir,
  resolveCwd,
  root,
  updateTargets,
} from "./config";
import { runCommand, streamCommandResponse } from "./process";
import {
  attachRunDone,
  attachRunInput,
  attachRunOutput,
  attachRunStart,
  beginRun,
  eventsResponse,
  getRun,
  handleWebSocketMessage,
  listRecentRuns,
  normalizeRunHistoryLimit,
  registerWebSocket,
  sendRunInput,
  snapshotPayload,
  stopRun,
  unregisterWebSocket,
  upgradeWebSocket,
} from "./runs";

const MAX_JSON_BODY_BYTES = 1024 * 1024;

export function startServer() {
  Bun.serve({
    hostname: host,
    port,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/") {
        return staticFile(join(root, "index.html"), "text/html; charset=utf-8");
      }
      if (
        request.method === "GET"
        && (
          url.pathname === "/app.css"
          || url.pathname === "/app.js"
          || url.pathname.startsWith("/css/")
          || url.pathname.startsWith("/js/")
        )
      ) {
        return staticPublicFile(url.pathname);
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        return jsonResponse(await statusPayload());
      }
      if (request.method === "GET" && url.pathname === "/api/snapshot") {
        return jsonResponse(await snapshotPayload());
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        return eventsResponse();
      }
      if (request.method === "GET" && url.pathname === "/api/ws") {
        if (!isAllowedOrigin(request)) return jsonResponse({ ok: false, stderr: "허용되지 않은 Origin입니다." }, 403);
        if (upgradeWebSocket(server, request)) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      if (request.method === "GET" && url.pathname === "/api/runs") {
        return jsonResponse({ runs: listRecentRuns(normalizeRunHistoryLimit(url.searchParams.get("limit"))) });
      }
      if (request.method === "GET" && url.pathname === "/api/cwd-children") {
        try {
          return jsonResponse({ ok: true, ...listCwdChildDirectories(url.searchParams.get("cwd") || defaultCwd) });
        } catch (error) {
          return jsonResponse({
            ok: false,
            directories: [],
            stderr: error instanceof Error ? error.message : String(error),
          }, 400);
        }
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/runs/")) {
        const id = url.pathname.split("/").at(-1) || "";
        const run = getRun(id);
        return run ? jsonResponse(run) : jsonResponse({ ok: false, stderr: "Run not found" }, 404);
      }
      if (request.method === "POST") {
        return handlePost(request, url.pathname);
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        registerWebSocket(ws);
      },
      message(ws, message) {
        handleWebSocketMessage(ws, message);
      },
      close(ws) {
        unregisterWebSocket(ws);
      },
    },
  });

  console.log(`Agent Console: http://${host}:${port}`);
  console.log("Press Ctrl+C to stop.");
}

function staticFile(path: string, type: string) {
  return new Response(Bun.file(path), {
    headers: {
      "Content-Type": type,
      "Cache-Control": "no-store",
    },
  });
}

function staticPublicFile(pathname: string) {
  const path = resolveStaticPublicPath(pathname);
  if (!path) return new Response("Not found", { status: 404 });
  return staticFile(path, contentType(pathname));
}

export function resolveStaticPublicPath(pathname: string) {
  let decoded = "";
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!isPublicAssetPath(decoded)) return null;

  const relativePath = decoded.replace(/^\/+/, "");
  const candidate = resolve(publicDir, relativePath);
  return isPathInside(publicDir, candidate) ? candidate : null;
}

function isPublicAssetPath(pathname: string) {
  return pathname === "/app.css"
    || pathname === "/app.js"
    || pathname.startsWith("/css/")
    || pathname.startsWith("/js/");
}

function isPathInside(base: string, candidate: string) {
  const relation = relative(resolve(base), candidate);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function contentType(pathname: string) {
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function isAllowedOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin) {
    return origin === `http://${host}:${port}` || origin === `http://localhost:${port}`;
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
}

async function handlePost(request: Request, route: string) {
  try {
    if (!isAllowedOrigin(request)) {
      return jsonResponse({ ok: false, stderr: "허용되지 않은 Origin입니다." }, 403);
    }
    if (route.startsWith("/api/runs/") && route.endsWith("/stop")) {
      const id = route.split("/").at(-2) || "";
      return jsonResponse({ ok: stopRun(id), id });
    }
    const payload = await readJsonPayload(request);
    if (route.startsWith("/api/runs/") && route.endsWith("/input")) {
      const id = route.split("/").at(-2) || "";
      const text = String(payload.text ?? "");
      return jsonResponse({ ok: await sendRunInput(id, text, { newline: payload.newline }), id });
    }
    if (route === "/api/chat-stream") {
      const { args, timeout } = chatCommand(payload);
      const run = beginRun({
        kind: "chat",
        label: `${payload.agent || "pi"} chat`,
        agent: String(payload.agent || "pi"),
        cwd: String(payload.cwd || defaultCwd),
      });
      const unlinkAbort = linkAbort(request.signal, run.controller);
      const response = streamCommandResponse(args, {
        cwd: payload.cwd,
        timeout,
        interactiveInput: Boolean(payload.interactiveInput),
        signal: run.controller.signal,
        onStart: attachRunStart(run.id),
        onInput: attachRunInput(run.id),
        onOutput: attachRunOutput(run.id),
        onDone: (result) => {
          attachRunDone(run.id)(result);
          unlinkAbort();
        },
      });
      response.headers.set("X-Agent-Console-Run-Id", run.id);
      return response;
    }
    if (route === "/api/chat") {
      const { args, timeout } = chatCommand(payload);
      const run = beginRun({
        kind: "chat",
        label: `${payload.agent || "pi"} chat`,
        agent: String(payload.agent || "pi"),
        cwd: String(payload.cwd || defaultCwd),
      });
      const unlinkAbort = linkAbort(request.signal, run.controller);
      try {
        return jsonResponse(await runCommand(args, {
          cwd: payload.cwd,
          timeout,
          interactiveInput: Boolean(payload.interactiveInput),
          signal: run.controller.signal,
          onStart: attachRunStart(run.id),
          onInput: attachRunInput(run.id),
          onOutput: attachRunOutput(run.id),
          onDone: attachRunDone(run.id),
        }));
      } finally {
        unlinkAbort();
      }
    }
    if (route === "/api/preset") {
      const key = String(payload.key || "");
      if (!(key in presets)) throw new Error(`알 수 없는 관리 작업입니다: ${key}`);
      const run = beginRun({
        kind: "preset",
        label: key,
        key,
        cwd: String(payload.cwd || defaultCwd),
      });
      const unlinkAbort = linkAbort(request.signal, run.controller);
      try {
        return jsonResponse(await runCommand(presets[key as keyof typeof presets], {
          cwd: payload.cwd,
          timeout: 120,
          interactiveInput: Boolean(payload.interactiveInput),
          signal: run.controller.signal,
          onStart: attachRunStart(run.id),
          onInput: attachRunInput(run.id),
          onOutput: attachRunOutput(run.id),
          onDone: attachRunDone(run.id),
        }));
      } finally {
        unlinkAbort();
      }
    }
    if (route === "/api/update") {
      const target = String(payload.target || "all");
      clearStatusCache();
      if (target !== "all" && !(target in updateTargets)) throw new Error(`알 수 없는 업데이트 대상입니다: ${target}`);
      const run = beginRun({
        kind: "update",
        label: target === "all" ? "update all agents" : `update ${target}`,
        target,
        cwd: String(payload.cwd || defaultCwd),
      });
      const unlinkAbort = linkAbort(request.signal, run.controller);
      try {
        const result = target === "all"
          ? await updateAll(String(payload.cwd || defaultCwd), run.controller.signal)
          : await updateAgent(target, String(payload.cwd || defaultCwd), run.controller.signal);
        attachRunDone(run.id)(result);
        return jsonResponse(result);
      } catch (error) {
        attachRunDone(run.id)({
          ok: false,
          code: null,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          command: target === "all" ? "update all agents" : `update ${target}`,
          cwd: String(payload.cwd || defaultCwd),
        });
        throw error;
      } finally {
        unlinkAbort();
      }
    }
    if (route === "/api/validate-cwd") {
      const cwd = resolveCwd(String(payload.cwd || defaultCwd));
      return jsonResponse({ ok: true, cwd });
    }
    if (route === "/api/open-cwd") {
      const result = openCwdFolder(String(payload.cwd || defaultCwd));
      if (!result.ok) throw new Error(result.stderr || "작업 폴더를 열지 못했습니다.");
      return jsonResponse({ ok: true, cwd: result.cwd });
    }
    return jsonResponse({ ok: false, stderr: "Not found" }, 404);
  } catch (error) {
    return jsonResponse({
      ok: false,
      code: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    }, 400);
  }
}

async function readJsonPayload(request: Request) {
  const text = await readRequestText(request, MAX_JSON_BODY_BYTES);
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function linkAbort(source: AbortSignal, target: AbortController) {
  if (source.aborted) {
    target.abort();
    return () => {};
  }
  const abort = () => target.abort();
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

async function readRequestText(request: Request, maxBytes: number) {
  const lengthHeader = request.headers.get("content-length");
  const contentLength = lengthHeader ? Number(lengthHeader) : 0;
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`요청 본문이 너무 큽니다. 최대 ${maxBytes} bytes까지 허용됩니다.`);
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error(`요청 본문이 너무 큽니다. 최대 ${maxBytes} bytes까지 허용됩니다.`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}
