import os from "node:os";
import path from "node:path";
import type { MyOpsPluginConfig } from "./config.js";

export type LocalFileRootsResolved = {
  rootsRaw: string[];
  rootsResolved: string[];
  inboxRaw: string;
  inboxResolved: string;
  showTccHints: boolean;
};

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function expandUserPath(input: string): string {
  const raw = input.trim();
  if (!raw) return raw;
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

export function resolveLocalFileRoots(cfg: MyOpsPluginConfig): LocalFileRootsResolved {
  const defaultInboxRaw = "~/.openclaw/workspace/inbox";
  const defaultRootsRaw = [
    "~/.openclaw/workspace",
    "~/Desktop",
    "~/Documents",
    "~/Downloads",
    "~/Movies",
    "~/Pictures",
  ];
  const rootsRaw = uniqueStrings([...(cfg.localFiles.roots ?? []), ...defaultRootsRaw]);
  const inboxRaw = (cfg.localFiles.inboxPath ?? "").trim() || defaultInboxRaw;
  const rootsWithInboxRaw = uniqueStrings([...rootsRaw, inboxRaw]);

  return {
    rootsRaw: rootsWithInboxRaw,
    rootsResolved: rootsWithInboxRaw.map(expandUserPath),
    inboxRaw,
    inboxResolved: expandUserPath(inboxRaw),
    showTccHints: cfg.localFiles.showTccHints,
  };
}
