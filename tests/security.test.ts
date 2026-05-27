import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { MAX_RUN_HISTORY_LIMIT, normalizeRunHistoryLimit } from "../src/server/runs";

const root = fileURLToPath(new URL("..", import.meta.url));

function readProjectFile(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("security regressions", () => {
  test("run history limits reject malformed and excessive values", () => {
    expect(normalizeRunHistoryLimit(null)).toBe(30);
    expect(normalizeRunHistoryLimit("1")).toBe(1);
    expect(normalizeRunHistoryLimit("0")).toBe(30);
    expect(normalizeRunHistoryLimit("NaN")).toBe(30);
    expect(normalizeRunHistoryLimit("Infinity")).toBe(30);
    expect(normalizeRunHistoryLimit("999999")).toBe(MAX_RUN_HISTORY_LIMIT);
  });

  test("run history reads stay bounded to a tail window", () => {
    const source = readProjectFile("src/server/runs.ts");

    expect(source).not.toContain("readFileSync");
    expect(source).toContain("LEDGER_TAIL_MAX_BYTES");
    expect(source).toContain("readRecentLedgerLines");
  });

  test("ZeroClaw update path does not install unsigned GitHub release fallback", () => {
    const source = readProjectFile("src/server/agents.ts");

    expect(source).not.toContain("releases/latest/download");
    expect(source).not.toContain("Invoke-WebRequest");
    expect(source).not.toContain("Copy-Item -LiteralPath $exe.FullName");
    expect(source).toContain("unsigned remote executables must not be installed or run");
  });

  test("Windows stop helper delegates to a script instead of interpolating the batch path into PowerShell source", () => {
    const stopCmd = readProjectFile("stop.cmd");
    const stopPs1 = readProjectFile("stop.ps1");

    expect(stopCmd).toContain('-File "%~dp0stop.ps1"');
    expect(stopCmd).not.toContain("-Command");
    expect(stopCmd).not.toContain("Resolve-Path '%~dp0'");
    expect(stopPs1).toContain("$PSScriptRoot");
  });

  test("Hermes admin helper refuses elevated or broadly writable user-profile script actions", () => {
    const source = readProjectFile("fix-hermes-gateway-task-admin.ps1");

    expect(source).toContain('RunLevel -eq "Highest"');
    expect(source).toContain("unsafeWriterSids");
    expect(source).toContain("Refusing to use Hermes gateway VBS");
    expect(source).not.toContain("$task.Settings.Hidden = $true");
  });
});
