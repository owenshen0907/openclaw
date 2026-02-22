import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { readMyOpsConfig } from "./config.js";

const PLUGIN_ID = "my-ops";

export function resolveMyOpsStateDir(api: OpenClawPluginApi): string {
  return path.join(api.runtime.state.resolveStateDir(), "plugins", PLUGIN_ID);
}

export function resolveCallsLogPath(api: OpenClawPluginApi): string {
  return path.join(resolveMyOpsStateDir(api), "calls.jsonl");
}

export function resolveServiceStatusPath(api: OpenClawPluginApi): string {
  return path.join(resolveMyOpsStateDir(api), "service-status.json");
}

export async function ensureMyOpsStateDir(api: OpenClawPluginApi): Promise<string> {
  const dir = resolveMyOpsStateDir(api);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function truncateText(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  return `${input.slice(0, maxChars)}…`;
}

export async function appendCallRecord(
  api: OpenClawPluginApi,
  record: Record<string, unknown>,
): Promise<void> {
  const cfg = readMyOpsConfig(api.pluginConfig);
  if (!cfg.observability.recordCalls) {
    return;
  }
  const maxChars = cfg.observability.maxOutputChars;
  const sanitized: Record<string, unknown> = { ...record };

  if (typeof sanitized.stdout === "string") {
    sanitized.stdout = truncateText(sanitized.stdout, maxChars);
  }
  if (typeof sanitized.stderr === "string") {
    sanitized.stderr = truncateText(sanitized.stderr, maxChars);
  }

  const dir = await ensureMyOpsStateDir(api);
  const file = path.join(dir, "calls.jsonl");
  await fs.appendFile(file, `${JSON.stringify(sanitized)}\n`, "utf8");
}

export async function writeServiceStatus(
  api: OpenClawPluginApi,
  status: Record<string, unknown>,
): Promise<void> {
  const cfg = readMyOpsConfig(api.pluginConfig);
  if (!cfg.service.writeStatusFile) {
    return;
  }
  const dir = await ensureMyOpsStateDir(api);
  const file = path.join(dir, "service-status.json");
  await fs.writeFile(file, `${JSON.stringify(status, null, 2)}\n`, "utf8");
}
