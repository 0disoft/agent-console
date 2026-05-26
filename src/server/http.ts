import { join } from "node:path";
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
  port,
  presets,
  publicDir,
  resolveCwd,
  root,
  updateTargets,
} from "./config";
import { runCommand, streamCommandResponse } from "./process";

export function startServer() {
  Bun.serve({
    hostname: host,
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/") {
        return staticFile(join(root, "index.html"), "text/html; charset=utf-8");
      }
      if (request.method === "GET" && (url.pathname === "/app.css" || url.pathname === "/app.js")) {
        return staticFile(join(publicDir, url.pathname.slice(1)), contentType(url.pathname));
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        return jsonResponse(await statusPayload());
      }
      if (request.method === "POST") {
        return handlePost(request, url.pathname);
      }
      return new Response("Not found", { status: 404 });
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
  if (!origin) return true;
  return origin === `http://${host}:${port}` || origin === `http://localhost:${port}`;
}

async function handlePost(request: Request, route: string) {
  try {
    if (!isAllowedOrigin(request)) {
      return jsonResponse({ ok: false, stderr: "허용되지 않은 Origin입니다." }, 403);
    }
    const payload = await request.json();
    if (route === "/api/chat-stream") {
      const { args, timeout } = chatCommand(payload);
      return streamCommandResponse(args, { cwd: payload.cwd, timeout, signal: request.signal });
    }
    if (route === "/api/chat") {
      const { args, timeout } = chatCommand(payload);
      return jsonResponse(await runCommand(args, { cwd: payload.cwd, timeout, signal: request.signal }));
    }
    if (route === "/api/preset") {
      const key = String(payload.key || "");
      if (!(key in presets)) throw new Error(`알 수 없는 관리 작업입니다: ${key}`);
      return jsonResponse(await runCommand(presets[key as keyof typeof presets], { cwd: payload.cwd, timeout: 120, signal: request.signal }));
    }
    if (route === "/api/update") {
      const target = String(payload.target || "all");
      clearStatusCache();
      if (target === "all") return jsonResponse(await updateAll(String(payload.cwd || defaultCwd), request.signal));
      if (!(target in updateTargets)) throw new Error(`알 수 없는 업데이트 대상입니다: ${target}`);
      return jsonResponse(await updateAgent(target as keyof typeof updateTargets, String(payload.cwd || defaultCwd), request.signal));
    }
    if (route === "/api/validate-cwd") {
      const cwd = resolveCwd(String(payload.cwd || defaultCwd));
      return jsonResponse({ ok: true, cwd });
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
