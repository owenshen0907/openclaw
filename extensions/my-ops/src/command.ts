import { createHash } from "node:crypto";
import { constants as FS_CONSTANTS } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { readMyOpsConfig } from "./config.js";
import { MY_OPS_GUIDE_PATH, renderGuideLinkHintsText, renderGuideMenuText } from "./guide.js";
import { expandUserPath, resolveLocalFileRoots } from "./local-files.js";
import { resolveCallsLogPath, resolveMyOpsStateDir, resolveServiceStatusPath } from "./state.js";

type OpsCommandCtx = {
  args?: string;
  config: Record<string, unknown>;
  channel: string;
  from?: string;
  to?: string;
  accountId?: string;
  messageThreadId?: number;
};

type ParsedArgs = {
  positionals: string[];
  flags: Record<string, string | boolean>;
};

type MowenAdapterRunResult = {
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  json?: Record<string, unknown>;
  debugId?: string;
  debugPath?: string;
};

type FeishuDocFetchResult = {
  accountId: string;
  url: string;
  docToken: string;
  title: string;
  content: string;
  revisionId?: string;
};

type MowenVisibility = "private" | "public";
type MailAdapterRunResult = MowenAdapterRunResult;

function renderStatus(api: OpenClawPluginApi): string {
  const cfg = readMyOpsConfig(api.pluginConfig);
  const lines: string[] = [];
  lines.push("My Ops plugin status");
  lines.push("");
  lines.push(`State dir: ${resolveMyOpsStateDir(api)}`);
  lines.push(`Service status file: ${resolveServiceStatusPath(api)}`);
  lines.push(`Call log: ${resolveCallsLogPath(api)}`);
  lines.push(`Guide page: ${MY_OPS_GUIDE_PATH}`);
  lines.push("");
  lines.push(
    `Service: ${cfg.service.enabled ? "enabled" : "disabled"} (tick ${cfg.service.tickSeconds}s, writeStatusFile=${cfg.service.writeStatusFile})`,
  );
  lines.push(
    `Observability: recordCalls=${cfg.observability.recordCalls}, maxOutputChars=${cfg.observability.maxOutputChars}`,
  );
  const localFiles = resolveLocalFileRoots(cfg);
  lines.push(
    `Local files: roots=${localFiles.rootsRaw.length} inbox=${localFiles.inboxRaw} tccHints=${localFiles.showTccHints}`,
  );
  lines.push("");
  lines.push("Adapters:");

  for (const [domain, adapter] of Object.entries(cfg.adapters)) {
    const command = adapter.command ?? "(not set)";
    const cwd = adapter.cwd ?? "(default)";
    const envKeys = Object.keys(adapter.env ?? {}).sort();
    lines.push(
      `- ${domain}: enabled=${adapter.enabled} configured=${Boolean(adapter.command)} command=${command} cwd=${cwd} timeoutMs=${adapter.timeoutMs} args=${adapter.args.length} envKeys=${envKeys.join(",") || "(none)"}`,
    );
  }

  lines.push("");
  lines.push("Notes:");
  lines.push(
    "- This plugin is a stable adapter bridge. Put business logic in your own adapter CLI/service.",
  );
  lines.push(
    "- Use cron/heartbeat for scheduling; use Lobster for deterministic multi-step workflows.",
  );
  lines.push("- Local file management should use core tools (group:fs) rather than this plugin.");
  return lines.join("\n");
}

function shellSplit(input: string): string[] {
  const out: string[] = [];
  const regex = /"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    out.push(token.replace(/\\(["'])/g, "$1"));
  }
  return out;
}

function parseArgs(input: string): ParsedArgs {
  const tokens = shellSplit(input);
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const raw = token.slice(2);
    if (!raw) {
      continue;
    }
    const eqIndex = raw.indexOf("=");
    if (eqIndex >= 0) {
      const key = raw.slice(0, eqIndex);
      const value = raw.slice(eqIndex + 1);
      if (key) {
        flags[key] = value;
      }
      continue;
    }

    const next = tokens[i + 1];
    if (next && !next.startsWith("--")) {
      flags[raw] = next;
      i++;
    } else {
      flags[raw] = true;
    }
  }

  return { positionals, flags };
}

function readFlagString(parsed: ParsedArgs, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = parsed.flags[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

function hasFlag(parsed: ParsedArgs, ...keys: string[]): boolean {
  return keys.some((key) => parsed.flags[key] === true);
}

type ParsedFeishuDocRef =
  | { kind: "docx"; token: string; url: URL }
  | { kind: "wiki"; token: string; url: URL };

function normalizeUrlLikeInput(input: string): string {
  const trimmed = input.trim().replace(/[\u200B-\u200D\uFEFF]/g, "");
  if (!trimmed) return trimmed;

  // Try to extract the first URL from a sentence pasted from mobile/chat apps.
  const match = trimmed.match(/https?:\/\/[^\s<>"'）】〕》」]+/i);
  let value = match?.[0] ?? trimmed;

  // Support pasting without scheme, e.g. feishu.cn/wiki/xxx
  if (!/^https?:\/\//i.test(value) && /^(?:[\w-]+\.)*(?:feishu|larksuite)\.[^\s]+$/i.test(value)) {
    value = `https://${value}`;
  }

  // Strip common wrappers/trailing punctuation from messaging apps.
  value = value.replace(/^[<({\[（【《「“"']+/, "");
  value = value.replace(/[>)}\]）】》」”"'，。；;！!？?,]+$/, "");

  return value.trim();
}

function parseFeishuDocRef(urlRaw: string): { ref?: ParsedFeishuDocRef; error?: string } {
  const normalizedRaw = normalizeUrlLikeInput(urlRaw);
  let url: URL;
  try {
    url = new URL(normalizedRaw);
  } catch {
    return { error: "无效链接：请提供完整 URL（https://...）" };
  }

  const host = url.hostname.toLowerCase();
  if (!host.includes("feishu.") && !host.includes("larksuite.")) {
    return { error: "目前 /ops mowen 只支持飞书文档链接（Docx/Wiki，feishu/larksuite）" };
  }

  const docxMatch = url.pathname.match(/\/docx\/([A-Za-z0-9]+)/);
  if (docxMatch?.[1]) {
    return { ref: { kind: "docx", token: docxMatch[1], url } };
  }

  const wikiMatch = url.pathname.match(/\/wiki\/([^/?#]+)/);
  if (wikiMatch?.[1]) {
    return { ref: { kind: "wiki", token: wikiMatch[1], url } };
  }

  return { error: "无法从链接中识别文档 token，请确认是飞书 docx/wiki 链接" };
}

function normalizeMowenTextFromFeishu(doc: FeishuDocFetchResult): string {
  const title = doc.title.trim();
  const content = (doc.content ?? "").trim();
  if (!content) {
    return title;
  }

  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (title && firstLine === title) {
    return content;
  }
  if (!title) {
    return content;
  }
  return `${title}\n\n${content}`;
}

function snippet(input: string, max = 240): string {
  const compact = input.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max)}...`;
}

function readFlagInt(parsed: ParsedArgs, fallback: number, ...keys: string[]): number {
  for (const key of keys) {
    const value = parsed.flags[key];
    const num =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number.parseInt(value.trim(), 10)
          : Number.NaN;
    if (Number.isFinite(num) && num > 0) {
      return Math.floor(num);
    }
  }
  return fallback;
}

function readFlagCsvStrings(parsed: ParsedArgs, ...keys: string[]): string[] {
  const raw = readFlagString(parsed, ...keys);
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

async function fetchFeishuDocForMowen(
  _api: OpenClawPluginApi,
  ctx: OpsCommandCtx,
  docUrl: string,
  accountHint?: string,
): Promise<FeishuDocFetchResult> {
  const parsed = parseFeishuDocRef(docUrl);
  if (!parsed.ref) {
    throw new Error(parsed.error ?? "无法解析飞书文档链接");
  }

  const accountsMod = await import("../../feishu/src/accounts.js");
  const clientMod = await import("../../feishu/src/client.js");

  const cfg = ctx.config as Parameters<typeof accountsMod.listEnabledFeishuAccounts>[0];
  const accounts = accountsMod.listEnabledFeishuAccounts(cfg);
  if (accounts.length === 0) {
    throw new Error("未找到可用的飞书账号配置，无法读取飞书文档");
  }

  const preferredIds = [
    accountHint,
    ctx.channel === "feishu" ? ctx.accountId : undefined,
    "main",
    "personal",
  ].filter((v): v is string => typeof v === "string" && v.trim().length > 0);

  const account =
    preferredIds.map((id) => accounts.find((a) => a.accountId === id)).find(Boolean) ?? accounts[0];

  if (!account) {
    throw new Error("未找到匹配的飞书账号");
  }

  const client = clientMod.createFeishuClient(account);
  let docToken = parsed.ref.token;
  if (parsed.ref.kind === "wiki") {
    // Resolve wiki node to the underlying object token so the rest of the flow stays on docx APIs.
    const wikiRes = await client.wiki.space.getNode({
      params: { token: parsed.ref.token },
    });
    if (wikiRes.code !== 0) {
      throw new Error(`读取飞书 Wiki 节点失败: ${wikiRes.msg || wikiRes.code}`);
    }

    const node = wikiRes.data?.node;
    const objType = String(node?.obj_type ?? "").trim();
    const objToken = String(node?.obj_token ?? "").trim();
    if (objType !== "docx") {
      throw new Error(`当前 wiki 链接指向 ${objType || "unknown"} 类型，托底命令仅支持 docx 文档`);
    }
    if (!objToken) {
      throw new Error("飞书 Wiki 节点未返回底层 docx token");
    }
    docToken = objToken;
  }

  const [contentRes, infoRes] = await Promise.all([
    client.docx.document.rawContent({ path: { document_id: docToken } }),
    client.docx.document.get({ path: { document_id: docToken } }),
  ]);

  if (contentRes.code !== 0) {
    throw new Error(`读取飞书文档正文失败: ${contentRes.msg || contentRes.code}`);
  }
  if (infoRes.code !== 0) {
    throw new Error(`读取飞书文档信息失败: ${infoRes.msg || infoRes.code}`);
  }

  const title = String(infoRes.data?.document?.title ?? "").trim();
  const content = String(contentRes.data?.content ?? "").trim();
  if (!title && !content) {
    throw new Error("飞书文档为空或当前接口未返回可读文本内容");
  }

  return {
    accountId: account.accountId,
    url: docUrl,
    docToken,
    title: title || `Feishu Doc ${docToken}`,
    content,
    revisionId:
      typeof infoRes.data?.document?.revision_id === "string"
        ? infoRes.data.document.revision_id
        : undefined,
  };
}

async function runMowenAdapter(
  api: OpenClawPluginApi,
  action: string,
  payload: Record<string, unknown>,
  opts?: { idempotencyKey?: string },
): Promise<MowenAdapterRunResult> {
  const cfg = readMyOpsConfig(api.pluginConfig);
  const adapter = cfg.adapters.mowen;

  if (!adapter.enabled) {
    throw new Error("my-ops mowen adapter is disabled");
  }
  if (!adapter.command) {
    throw new Error("my-ops mowen adapter is not configured");
  }

  const envelope = {
    version: 1 as const,
    domain: "mowen" as const,
    action,
    ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    payload,
    meta: {
      plugin: "my-ops",
      tool: "ops_mowen",
      timestamp: new Date().toISOString(),
    },
  };

  const argv = [adapter.command, ...adapter.args];
  const result = await api.runtime.system.runCommandWithTimeout(argv, {
    timeoutMs: adapter.timeoutMs,
    cwd: adapter.cwd,
    env: adapter.env,
    input: `${JSON.stringify(envelope)}\n`,
  });

  let parsedJson: Record<string, unknown> | undefined;
  const stdoutTrimmed = result.stdout.trim();
  if (stdoutTrimmed) {
    try {
      const parsed = JSON.parse(stdoutTrimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parsedJson = parsed as Record<string, unknown>;
      }
    } catch {
      // Keep raw stdout only
    }
  }

  const adapterOk = parsedJson?.ok === true || result.code === 0;
  const debugId = `mowen-${new Date().toISOString().replace(/[:.]/g, "-")}-${hashShort(
    JSON.stringify({
      action,
      idempotencyKey: opts?.idempotencyKey ?? null,
      payloadKeys: Object.keys(payload).sort(),
    }),
  )}`;
  const debugPath = path.join(resolveMyOpsStateDir(api), "debug", `${debugId}.json`);

  try {
    await fs.mkdir(path.dirname(debugPath), { recursive: true });
    await fs.writeFile(
      debugPath,
      `${JSON.stringify(
        {
          debugId,
          timestamp: new Date().toISOString(),
          action,
          idempotencyKey: opts?.idempotencyKey,
          adapter: {
            command: adapter.command,
            args: adapter.args,
            cwd: adapter.cwd,
            timeoutMs: adapter.timeoutMs,
            envKeys: Object.keys(adapter.env ?? {}).sort(),
          },
          envelope,
          result: {
            ok: adapterOk,
            code: result.code,
            signal: result.signal,
            stdout: result.stdout,
            stderr: result.stderr,
            json: parsedJson,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch {
    // Debug dump is best-effort; command result should still be returned to the user.
  }

  return {
    ok: adapterOk,
    code: result.code,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    json: parsedJson,
    debugId,
    debugPath,
  };
}

async function runMailAdapter(
  api: OpenClawPluginApi,
  action: string,
  payload: Record<string, unknown>,
  opts?: { idempotencyKey?: string },
): Promise<MailAdapterRunResult> {
  const cfg = readMyOpsConfig(api.pluginConfig);
  const adapter = cfg.adapters.mail;

  if (!adapter?.enabled) {
    throw new Error("my-ops mail adapter is disabled");
  }
  if (!adapter.command) {
    throw new Error("my-ops mail adapter is not configured");
  }

  const envelope = {
    version: 1 as const,
    domain: "mail" as const,
    action,
    ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    payload,
    meta: {
      plugin: "my-ops",
      tool: "ops_mail",
      timestamp: new Date().toISOString(),
    },
  };

  const argv = [adapter.command, ...adapter.args];
  const result = await api.runtime.system.runCommandWithTimeout(argv, {
    timeoutMs: adapter.timeoutMs,
    cwd: adapter.cwd,
    env: adapter.env,
    input: `${JSON.stringify(envelope)}\n`,
  });

  let parsedJson: Record<string, unknown> | undefined;
  const stdoutTrimmed = result.stdout.trim();
  if (stdoutTrimmed) {
    try {
      const parsed = JSON.parse(stdoutTrimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parsedJson = parsed as Record<string, unknown>;
      }
    } catch {
      // Keep raw stdout only
    }
  }

  return {
    ok: parsedJson?.ok === true || result.code === 0,
    code: result.code,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    json: parsedJson,
  };
}

async function runCalendarAdapter(
  api: OpenClawPluginApi,
  action: string,
  payload: Record<string, unknown>,
  opts?: { idempotencyKey?: string },
): Promise<CalendarAdapterRunResult> {
  const cfg = readMyOpsConfig(api.pluginConfig);
  const adapter = cfg.adapters.calendar;

  if (!adapter?.enabled) {
    throw new Error("my-ops calendar adapter is disabled");
  }
  if (!adapter.command) {
    throw new Error("my-ops calendar adapter is not configured");
  }

  const envelope = {
    version: 1 as const,
    domain: "calendar" as const,
    action,
    ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    payload,
    meta: {
      plugin: "my-ops",
      tool: "ops_calendar",
      timestamp: new Date().toISOString(),
    },
  };

  const argv = [adapter.command, ...adapter.args];
  const result = await api.runtime.system.runCommandWithTimeout(argv, {
    timeoutMs: adapter.timeoutMs,
    cwd: adapter.cwd,
    env: adapter.env,
    input: `${JSON.stringify(envelope)}\n`,
  });

  let parsedJson: Record<string, unknown> | undefined;
  const stdoutTrimmed = result.stdout.trim();
  if (stdoutTrimmed) {
    try {
      const parsed = JSON.parse(stdoutTrimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parsedJson = parsed as Record<string, unknown>;
      }
    } catch {
      // Keep raw stdout only
    }
  }

  return {
    ok: parsedJson?.ok === true || result.code === 0,
    code: result.code,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    json: parsedJson,
  };
}

type CalendarAdapterRunResult = MowenAdapterRunResult;

function extractCalendarData(res: CalendarAdapterRunResult): unknown {
  const top = asRecord(res.json);
  if (top?.data !== undefined) {
    return top.data;
  }
  const result = asRecord(top?.result);
  const stdoutJson = asRecord(result?.stdoutJson);
  return stdoutJson?.data;
}

function extractCalendarStderr(res: CalendarAdapterRunResult): string | undefined {
  const top = asRecord(res.json);
  const result = asRecord(top?.result);
  return typeof result?.stderr === "string" && result.stderr.trim() ? result.stderr : undefined;
}

function renderCalendarAdapterFailure(label: string, res: CalendarAdapterRunResult): string {
  const top = asRecord(res.json);
  const error = typeof top?.error === "string" ? top.error : undefined;
  const nestedStderr = extractCalendarStderr(res);
  return [
    `${label} 失败`,
    `- exec code: ${res.code ?? "null"}${res.signal ? ` signal=${res.signal}` : ""}`,
    ...(error ? [`- error: ${error}`] : []),
    ...(nestedStderr ? [`- stderr: ${snippet(nestedStderr, 400)}`] : []),
    !error && !nestedStderr && res.stderr.trim()
      ? `- adapter stderr: ${snippet(res.stderr, 400)}`
      : "",
    !error && !nestedStderr && res.stdout.trim() ? `- stdout: ${snippet(res.stdout, 500)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function extractMailStdoutJson(res: MailAdapterRunResult): unknown {
  const top = asRecord(res.json);
  const result = asRecord(top?.result);
  return result?.stdoutJson;
}

function extractMailStderr(res: MailAdapterRunResult): string | undefined {
  const top = asRecord(res.json);
  const result = asRecord(top?.result);
  return typeof result?.stderr === "string" && result.stderr.trim() ? result.stderr : undefined;
}

function renderMailAdapterFailure(label: string, res: MailAdapterRunResult): string {
  const top = asRecord(res.json);
  const error = typeof top?.error === "string" ? top.error : undefined;
  const nestedStderr = extractMailStderr(res);
  return [
    `${label} 失败`,
    `- exec code: ${res.code ?? "null"}${res.signal ? ` signal=${res.signal}` : ""}`,
    ...(error ? [`- error: ${error}`] : []),
    ...(nestedStderr ? [`- stderr: ${snippet(nestedStderr, 400)}`] : []),
    !error && !nestedStderr && res.stderr.trim()
      ? `- adapter stderr: ${snippet(res.stderr, 400)}`
      : "",
    !error && !nestedStderr && res.stdout.trim() ? `- stdout: ${snippet(res.stdout, 500)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

type CalendarInfo = {
  name: string;
  writable?: boolean;
  calendarIdentifier?: string;
  description?: string;
};

type CalendarEventInfo = {
  id: string;
  uid?: string;
  calendar?: string;
  title?: string;
  summary?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  location?: string | null;
  notes?: string | null;
  url?: string | null;
  status?: string | null;
  modifiedAt?: string | null;
};

type MailAccountInfo = {
  name: string;
  default?: boolean;
  backend?: string;
};

type MailFolderInfo = {
  name: string;
  desc?: string;
};

type MailEnvelopeInfo = {
  id: string;
  subject?: string;
  date?: string;
  flags?: string[];
  from?: { name?: string | null; addr?: string | null };
  to?: { name?: string | null; addr?: string | null };
};

function parseCalendarCalendarsFromResult(res: CalendarAdapterRunResult): CalendarInfo[] {
  const data = asRecord(extractCalendarData(res));
  const arr = asArray(data?.calendars) ?? asArray(extractCalendarData(res)) ?? [];
  return arr
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      name: String(item.name ?? "").trim(),
      writable: item.writable === true,
      calendarIdentifier:
        typeof item.calendarIdentifier === "string" ? item.calendarIdentifier : undefined,
      description: typeof item.description === "string" ? item.description : undefined,
    }))
    .filter((item) => item.name);
}

function parseCalendarEventsFromResult(res: CalendarAdapterRunResult): CalendarEventInfo[] {
  const data = asRecord(extractCalendarData(res));
  const arr = asArray(data?.items) ?? asArray(extractCalendarData(res)) ?? [];
  return arr
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      id: String(item.id ?? item.uid ?? "").trim(),
      uid: typeof item.uid === "string" ? item.uid : undefined,
      calendar: typeof item.calendar === "string" ? item.calendar : undefined,
      title: typeof item.title === "string" ? item.title : undefined,
      summary: typeof item.summary === "string" ? item.summary : undefined,
      start: typeof item.start === "string" ? item.start : undefined,
      end: typeof item.end === "string" ? item.end : undefined,
      allDay: item.allDay === true,
      location:
        typeof item.location === "string" || item.location === null
          ? (item.location as string | null)
          : undefined,
      notes:
        typeof item.notes === "string" || item.notes === null
          ? (item.notes as string | null)
          : undefined,
      url:
        typeof item.url === "string" || item.url === null ? (item.url as string | null) : undefined,
      status:
        typeof item.status === "string" || item.status === null
          ? (item.status as string | null)
          : undefined,
      modifiedAt:
        typeof item.modifiedAt === "string" || item.modifiedAt === null
          ? (item.modifiedAt as string | null)
          : undefined,
    }))
    .filter((item) => item.id);
}

function formatCalendarTimeRange(event: CalendarEventInfo): string {
  if (!event.start) return "(unknown time)";
  const start = new Date(event.start);
  const end = event.end ? new Date(event.end) : undefined;
  if (!Number.isFinite(start.getTime())) return event.start;

  const y = start.getFullYear();
  const m = String(start.getMonth() + 1).padStart(2, "0");
  const d = String(start.getDate()).padStart(2, "0");
  if (event.allDay) {
    return `${y}-${m}-${d} (all-day)`;
  }
  const hh = String(start.getHours()).padStart(2, "0");
  const mm = String(start.getMinutes()).padStart(2, "0");
  let tail = `${y}-${m}-${d} ${hh}:${mm}`;
  if (end && Number.isFinite(end.getTime())) {
    const eh = String(end.getHours()).padStart(2, "0");
    const em = String(end.getMinutes()).padStart(2, "0");
    const sameDate =
      end.getFullYear() === start.getFullYear() &&
      end.getMonth() === start.getMonth() &&
      end.getDate() === start.getDate();
    tail += sameDate
      ? `-${eh}:${em}`
      : ` -> ${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")} ${eh}:${em}`;
  }
  return tail;
}

function formatCalendarEventLine(event: CalendarEventInfo): string {
  const title = snippet(event.title || event.summary || "(no title)", 72);
  const where = event.location ? ` · ${snippet(event.location, 28)}` : "";
  const cal = event.calendar ? ` · [${snippet(event.calendar, 24)}]` : "";
  return `  - ${title} · ${formatCalendarTimeRange(event)}${where}${cal} · id=${event.id}`;
}

function parseMailAccountsFromResult(res: MailAdapterRunResult): MailAccountInfo[] {
  const data = extractMailStdoutJson(res);
  const arr = asArray(data);
  if (!arr) return [];
  return arr
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      name: String(item.name ?? "").trim(),
      default: item.default === true,
      backend: typeof item.backend === "string" ? item.backend : undefined,
    }))
    .filter((item) => item.name);
}

function parseMailFoldersFromResult(res: MailAdapterRunResult): MailFolderInfo[] {
  const data = extractMailStdoutJson(res);
  const arr = asArray(data);
  if (!arr) return [];
  return arr
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      name: String(item.name ?? "").trim(),
      desc: typeof item.desc === "string" ? item.desc : undefined,
    }))
    .filter((item) => item.name);
}

function parseMailEnvelopesFromResult(res: MailAdapterRunResult): MailEnvelopeInfo[] {
  const data = extractMailStdoutJson(res);
  const direct = asArray(data);
  const arr = direct ?? asArray(asRecord(data)?.items) ?? [];
  return arr
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => {
      const from = asRecord(item.from);
      const to = asRecord(item.to);
      return {
        id: String(item.id ?? "").trim(),
        subject: typeof item.subject === "string" ? item.subject : undefined,
        date: typeof item.date === "string" ? item.date : undefined,
        flags: asArray(item.flags)?.filter((v): v is string => typeof v === "string"),
        from: from
          ? {
              name: typeof from.name === "string" ? from.name : null,
              addr: typeof from.addr === "string" ? from.addr : null,
            }
          : undefined,
        to: to
          ? {
              name: typeof to.name === "string" ? to.name : null,
              addr: typeof to.addr === "string" ? to.addr : null,
            }
          : undefined,
      };
    })
    .filter((item) => item.id);
}

function pickJunkFolderName(folders: MailFolderInfo[]): string | undefined {
  const byDesc =
    folders.find((f) => typeof f.desc === "string" && /\\Junk\b/.test(f.desc))?.name ?? undefined;
  if (byDesc) return byDesc;

  const byName = folders.find((f) => /(?:^|[/\]])(?:junk|spam|垃圾)/i.test(f.name))?.name;
  return byName;
}

function formatMailEnvelopeLine(item: MailEnvelopeInfo): string {
  const subject = item.subject ? snippet(item.subject, 72) : "(no subject)";
  const from =
    item.from?.name?.trim() ||
    item.from?.addr?.trim() ||
    item.to?.name?.trim() ||
    item.to?.addr?.trim() ||
    "?";
  const date = item.date ? ` · ${item.date}` : "";
  return `  - #${item.id} ${subject} · ${snippet(from, 28)}${date}`;
}

function extractMowenNoteId(res: MowenAdapterRunResult): string | undefined {
  const pickId = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const obj = value as Record<string, unknown>;
    const direct = [obj.noteId, obj.note_id, obj.id].find(
      (v): v is string => typeof v === "string" && v.trim().length > 0,
    );
    if (direct) return direct.trim();
    return undefined;
  };

  const adapterTopLevelId = pickId(res.json);
  if (adapterTopLevelId) {
    return adapterTopLevelId;
  }

  const response = res.json?.response;
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return undefined;
  }
  const responseJson = (response as Record<string, unknown>).json;
  if (!responseJson || typeof responseJson !== "object" || Array.isArray(responseJson)) {
    return undefined;
  }

  const root = responseJson as Record<string, unknown>;
  return (
    pickId(root) ??
    pickId(root.data) ??
    pickId(root.result) ??
    pickId(root.note) ??
    (root.data && typeof root.data === "object" && !Array.isArray(root.data)
      ? pickId((root.data as Record<string, unknown>).note)
      : undefined)
  );
}

function renderAdapterFailure(label: string, res: MowenAdapterRunResult): string {
  const error = typeof res.json?.error === "string" ? res.json.error : undefined;
  const apiStatus =
    res.json?.api && typeof res.json.api === "object" && !Array.isArray(res.json.api)
      ? (res.json.api as Record<string, unknown>).status
      : undefined;
  return [
    `${label} 失败`,
    `- exec code: ${res.code ?? "null"}${res.signal ? ` signal=${res.signal}` : ""}`,
    ...(apiStatus !== undefined ? [`- API status: ${String(apiStatus)}`] : []),
    ...(error ? [`- error: ${error}`] : []),
    ...(res.debugId ? [`- debugId: ${res.debugId}`] : []),
    ...(res.debugPath ? [`- debugPath: ${res.debugPath}`] : []),
    ...(res.stderr.trim() ? [`- stderr: ${snippet(res.stderr, 400)}`] : []),
    !error && !res.stderr.trim() && res.stdout.trim()
      ? `- stdout: ${snippet(res.stdout, 400)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildMowenPrivacyPayload(
  noteId: string,
  visibility: MowenVisibility,
): Record<string, unknown> {
  return {
    noteId,
    privacy: {
      type: visibility,
    },
  };
}

function parseVisibility(parsed: ParsedArgs): MowenVisibility | undefined {
  if (hasFlag(parsed, "private")) return "private";
  if (hasFlag(parsed, "public")) return "public";

  for (const token of parsed.positionals) {
    const lower = token.toLowerCase();
    if (lower === "private" || lower === "私有") return "private";
    if (lower === "public" || lower === "公开") return "public";
  }
  return undefined;
}

function hashShort(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 10);
}

function mowenCommandHelp(): string {
  return [
    "Mowen fallback commands (deterministic, no LLM):",
    "",
    "/ops mowen fetch <feishu_doc_or_wiki_url> [--account <feishuAccountId>]",
    "  读取飞书文档正文并预览（支持 Docx/Wiki；不发布）",
    "",
    "/ops mowen post <feishu_doc_or_wiki_url> [--private|--public] [--dry-run] [--account <feishuAccountId>]",
    "  从飞书 Docx/Wiki 链接直接发布到墨问（默认 private）",
    "",
    "/ops mowen edit <noteId> <feishu_doc_or_wiki_url> [--private|--public] [--dry-run] [--account <feishuAccountId>]",
    "  用飞书 Docx/Wiki 内容直接覆盖编辑墨问文章；可选顺带改可见范围",
    "",
    "Examples:",
    "- /ops mowen post https://feishu.cn/docx/XXX --private",
    "- /ops mowen post https://feishu.cn/wiki/XXX --private",
    "- /ops mowen edit zfmx5VcwCf0ErKY3M3zZF https://feishu.cn/docx/XXX",
  ].join("\n");
}

async function handleMowenFetchCommand(
  api: OpenClawPluginApi,
  ctx: OpsCommandCtx,
  parsed: ParsedArgs,
): Promise<{ text: string }> {
  const url = parsed.positionals[2];
  if (!url) {
    return { text: mowenCommandHelp() };
  }

  const account = readFlagString(parsed, "account", "feishu-account");
  const doc = await fetchFeishuDocForMowen(api, ctx, url, account);
  const text = normalizeMowenTextFromFeishu(doc);

  return {
    text: [
      "Feishu -> Mowen source preview",
      `- account: ${doc.accountId}`,
      `- docToken: ${doc.docToken}`,
      `- title: ${doc.title}`,
      `- revision: ${doc.revisionId ?? "(unknown)"}`,
      `- chars: ${text.length}`,
      "",
      snippet(text, 600),
    ].join("\n"),
  };
}

async function handleMowenPostOrEditCommand(
  api: OpenClawPluginApi,
  ctx: OpsCommandCtx,
  parsed: ParsedArgs,
): Promise<{ text: string }> {
  const sub = (parsed.positionals[1] ?? "").toLowerCase();
  const isEdit = sub === "edit";
  const isPost = sub === "post" || sub === "publish";
  if (!isEdit && !isPost) {
    return { text: mowenCommandHelp() };
  }

  const noteIdArg = isEdit ? parsed.positionals[2] : undefined;
  const urlArg = isEdit ? parsed.positionals[3] : parsed.positionals[2];
  if (!urlArg || (isEdit && !noteIdArg)) {
    return { text: mowenCommandHelp() };
  }

  const accountHint = readFlagString(parsed, "account", "feishu-account");
  const dryRun = hasFlag(parsed, "dry-run", "dry");
  const requestedVisibility = parseVisibility(parsed);
  const visibility: MowenVisibility | undefined = isPost
    ? (requestedVisibility ?? "private")
    : requestedVisibility;

  const doc = await fetchFeishuDocForMowen(api, ctx, urlArg, accountHint);
  const text = normalizeMowenTextFromFeishu(doc);
  const baseKey = `mowen-${sub}-${hashShort(`${doc.url}|${doc.revisionId ?? ""}|${noteIdArg ?? ""}`)}`;

  if (dryRun) {
    return {
      text: [
        `Mowen ${isEdit ? "edit" : "post"} dry-run`,
        `- source account: ${doc.accountId}`,
        `- source title: ${doc.title}`,
        `- source revision: ${doc.revisionId ?? "(unknown)"}`,
        ...(isEdit ? [`- target noteId: ${noteIdArg}`] : []),
        ...(visibility ? [`- visibility: ${visibility}`] : []),
        `- chars: ${text.length}`,
        `- planned actions: ${isEdit ? "update_doc" : "create_doc"}${visibility ? " + set_doc" : ""}`,
        "",
        snippet(text, 800),
      ].join("\n"),
    };
  }

  const writeAction = isEdit ? "update_doc" : "create_doc";
  const writePayload: Record<string, unknown> = isEdit
    ? { noteId: noteIdArg, text }
    : { text, autoPublish: true };

  const writeRes = await runMowenAdapter(api, writeAction, writePayload, {
    idempotencyKey: `${baseKey}-write`,
  });
  if (!writeRes.ok) {
    return { text: renderAdapterFailure(`Mowen ${sub}`, writeRes) };
  }

  const noteId = isEdit ? noteIdArg : extractMowenNoteId(writeRes);
  if (!noteId) {
    return {
      text: [
        `Mowen ${sub} 已调用成功，但未拿到 noteId`,
        "- 请查看 calls.jsonl 或 adapter 输出",
        ...(writeRes.debugId ? [`- debugId: ${writeRes.debugId}`] : []),
        ...(writeRes.debugPath ? [`- debugPath: ${writeRes.debugPath}`] : []),
        `- callsPath: ${resolveCallsLogPath(api)}`,
        `- stdout: ${snippet(writeRes.stdout, 500)}`,
      ].join("\n"),
    };
  }

  let setRes: MowenAdapterRunResult | undefined;
  if (visibility) {
    setRes = await runMowenAdapter(api, "set_doc", buildMowenPrivacyPayload(noteId, visibility), {
      idempotencyKey: `${baseKey}-visibility-${visibility}`,
    });
    if (!setRes.ok) {
      return {
        text: [
          `Mowen ${sub} 已完成，但设置可见范围失败`,
          `- noteId: ${noteId}`,
          renderAdapterFailure("Mowen set_doc", setRes),
        ].join("\n"),
      };
    }
  }

  return {
    text: [
      `Mowen ${isEdit ? "编辑" : "发布"}成功`,
      `- noteId: ${noteId}`,
      `- source: Feishu[${doc.accountId}] ${doc.title}`,
      `- source revision: ${doc.revisionId ?? "(unknown)"}`,
      `- action: ${writeAction}`,
      ...(visibility ? [`- visibility: ${visibility}`] : []),
      `- chars: ${text.length}`,
      ...(setRes ? ["- steps: write ✓ / set_visibility ✓"] : ["- steps: write ✓"]),
    ].join("\n"),
  };
}

async function handleMowenCommand(
  api: OpenClawPluginApi,
  ctx: OpsCommandCtx,
  args: string,
): Promise<{ text: string }> {
  const parsed = parseArgs(args);
  const sub = (parsed.positionals[1] ?? "").toLowerCase();

  if (!sub || sub === "help") {
    return { text: mowenCommandHelp() };
  }
  if (sub === "fetch") {
    return await handleMowenFetchCommand(api, ctx, parsed);
  }
  if (sub === "post" || sub === "publish" || sub === "edit") {
    return await handleMowenPostOrEditCommand(api, ctx, parsed);
  }

  return { text: `Unknown /ops mowen subcommand: ${sub}\n\n${mowenCommandHelp()}` };
}

function mailCommandHelp(): string {
  return [
    "Mail fallback commands (deterministic, no LLM):",
    "",
    "/ops mail accounts",
    "  查看 Himalaya 已配置邮箱账号列表",
    "",
    "/ops mail summary [--accounts a,b,c] [--limit 5] [--folder INBOX]",
    "  汇总多个邮箱最近邮件（默认所有账号）",
    "",
    "/ops mail junk list [--accounts a,b,c] [--limit 20]",
    "  查看各账号垃圾邮件概览（自动识别 Junk/Spam 文件夹）",
    "",
    "/ops mail junk clear [--accounts a,b,c] [--limit 50] [--dry-run] [--confirm] [--purge]",
    "  清理垃圾邮件：默认 dry-run；加 --confirm 执行。--purge 会清空整个垃圾箱（危险）",
    "",
    "Examples:",
    "- /ops mail accounts",
    "- /ops mail summary --accounts owenshen-gmail,owenshen-qq --limit 5",
    "- /ops mail junk list --limit 20",
    "- /ops mail junk clear --accounts owenshen-gmail --limit 50 --dry-run",
    "- /ops mail junk clear --accounts owenshen-gmail --limit 50 --confirm",
  ].join("\n");
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const v = value.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function resolveRequestedMailAccounts(
  parsed: ParsedArgs,
  allAccounts: MailAccountInfo[],
): string[] {
  const byCsv = readFlagCsvStrings(parsed, "accounts", "account-list");
  const single = readFlagString(parsed, "account");
  const requested = uniqueStrings([...byCsv, ...(single ? [single] : [])]);
  if (requested.length > 0) {
    return requested;
  }
  return allAccounts.map((a) => a.name);
}

async function fetchMailAccounts(api: OpenClawPluginApi): Promise<
  | {
      ok: true;
      accounts: MailAccountInfo[];
    }
  | {
      ok: false;
      errorText: string;
    }
> {
  const res = await runMailAdapter(api, "list_accounts", {});
  if (!res.ok) {
    return { ok: false, errorText: renderMailAdapterFailure("Mail accounts", res) };
  }
  const accounts = parseMailAccountsFromResult(res);
  if (accounts.length === 0) {
    return { ok: false, errorText: "未读取到 Himalaya 账号列表（请检查 config.toml）" };
  }
  return { ok: true, accounts };
}

async function resolveJunkFolderForAccount(
  api: OpenClawPluginApi,
  account: string,
  explicitFolder?: string,
): Promise<{ ok: true; folder: string; detected?: boolean } | { ok: false; text: string }> {
  if (explicitFolder) {
    return { ok: true, folder: explicitFolder, detected: false };
  }
  const foldersRes = await runMailAdapter(api, "list_folders", { account });
  if (!foldersRes.ok) {
    return {
      ok: false,
      text: `- ${account}: 读取文件夹列表失败\n${renderMailAdapterFailure("Mail list_folders", foldersRes)}`,
    };
  }
  const folders = parseMailFoldersFromResult(foldersRes);
  const junkFolder = pickJunkFolderName(folders);
  if (!junkFolder) {
    return {
      ok: false,
      text: `- ${account}: 未识别到垃圾邮件文件夹（可手动指定 --folder）`,
    };
  }
  return { ok: true, folder: junkFolder, detected: true };
}

async function handleMailAccountsCommand(api: OpenClawPluginApi): Promise<{ text: string }> {
  const accountsResult = await fetchMailAccounts(api);
  if (!accountsResult.ok) {
    return { text: accountsResult.errorText };
  }

  return {
    text: [
      "Himalaya accounts",
      ...accountsResult.accounts.map(
        (a) => `- ${a.name}${a.default ? " (default)" : ""}${a.backend ? ` · ${a.backend}` : ""}`,
      ),
    ].join("\n"),
  };
}

async function handleMailSummaryCommand(
  api: OpenClawPluginApi,
  parsed: ParsedArgs,
): Promise<{ text: string }> {
  const accountsResult = await fetchMailAccounts(api);
  if (!accountsResult.ok) {
    return { text: accountsResult.errorText };
  }

  const limit = Math.min(50, readFlagInt(parsed, 5, "limit", "page-size", "pageSize"));
  const folder = readFlagString(parsed, "folder") ?? "INBOX";
  const requested = resolveRequestedMailAccounts(parsed, accountsResult.accounts);
  const validNames = new Set(accountsResult.accounts.map((a) => a.name));
  const unknown = requested.filter((name) => !validNames.has(name));
  const accounts = requested.filter((name) => validNames.has(name));

  if (accounts.length === 0) {
    return {
      text: [
        "Mail summary",
        "- 未匹配到有效账号",
        ...(unknown.length ? [`- unknown: ${unknown.join(", ")}`] : []),
        "",
        mailCommandHelp(),
      ].join("\n"),
    };
  }

  const results = await Promise.allSettled(
    accounts.map(async (account) => {
      const res = await runMailAdapter(api, "list_messages", {
        account,
        folder,
        page: 1,
        pageSize: limit,
      });
      return { account, res };
    }),
  );

  const lines: string[] = [];
  lines.push("Mail summary");
  lines.push(`- folder: ${folder}`);
  lines.push(`- limit per account: ${limit}`);
  lines.push(`- accounts: ${accounts.join(", ")}`);
  if (unknown.length) {
    lines.push(`- ignored unknown accounts: ${unknown.join(", ")}`);
  }
  lines.push("");

  for (const item of results) {
    if (item.status !== "fulfilled") {
      lines.push(`- (unknown account): 执行失败 ${String(item.reason)}`);
      continue;
    }
    const { account, res } = item.value;
    if (!res.ok) {
      lines.push(`- ${account}: 读取失败`);
      lines.push(`  ${snippet(renderMailAdapterFailure("Mail list_messages", res), 260)}`);
      continue;
    }

    const envelopes = parseMailEnvelopesFromResult(res);
    const unreadShown = envelopes.filter(
      (m) => !(m.flags ?? []).some((flag) => flag.toLowerCase() === "seen"),
    ).length;
    lines.push(`- ${account}: ${envelopes.length} 封（本页未读 ${unreadShown}）`);
    if (envelopes.length === 0) {
      lines.push("  - (empty)");
      continue;
    }
    for (const env of envelopes) {
      lines.push(formatMailEnvelopeLine(env));
    }
  }

  return { text: lines.join("\n") };
}

async function handleMailJunkCommand(
  api: OpenClawPluginApi,
  parsed: ParsedArgs,
): Promise<{ text: string }> {
  const sub = (parsed.positionals[2] ?? "list").toLowerCase();
  if (!["list", "clear", "clean"].includes(sub)) {
    return { text: mailCommandHelp() };
  }

  const accountsResult = await fetchMailAccounts(api);
  if (!accountsResult.ok) {
    return { text: accountsResult.errorText };
  }

  const requested = resolveRequestedMailAccounts(parsed, accountsResult.accounts);
  const validNames = new Set(accountsResult.accounts.map((a) => a.name));
  const unknown = requested.filter((name) => !validNames.has(name));
  const accounts = requested.filter((name) => validNames.has(name));
  if (accounts.length === 0) {
    return { text: `Mail junk ${sub}\n- 未匹配到有效账号` };
  }

  const limit = Math.min(200, readFlagInt(parsed, 30, "limit", "page-size", "pageSize"));
  const explicitFolder = readFlagString(parsed, "folder", "junk-folder");
  const wantPurge = hasFlag(parsed, "purge");
  const confirm = hasFlag(parsed, "confirm", "yes", "execute");
  const dryRun = sub !== "clear" || hasFlag(parsed, "dry-run", "dry") || !confirm;

  const lines: string[] = [];
  lines.push(`Mail junk ${sub === "list" ? "list" : dryRun ? "clear (dry-run)" : "clear"}`);
  lines.push(`- accounts: ${accounts.join(", ")}`);
  lines.push(`- limit per account: ${limit}`);
  if (explicitFolder) {
    lines.push(`- folder override: ${explicitFolder}`);
  }
  if (sub !== "list") {
    lines.push(`- mode: ${wantPurge ? "purge-folder" : "delete-listed"}`);
    if (!confirm) {
      lines.push("- safety: 默认 dry-run；加 --confirm 才会执行删除");
    }
  }
  if (unknown.length) {
    lines.push(`- ignored unknown accounts: ${unknown.join(", ")}`);
  }
  lines.push("");

  for (const account of accounts) {
    const junkFolderRes = await resolveJunkFolderForAccount(api, account, explicitFolder);
    if (!junkFolderRes.ok) {
      lines.push(junkFolderRes.text);
      continue;
    }
    const junkFolder = junkFolderRes.folder;
    const listRes = await runMailAdapter(api, "list_messages", {
      account,
      folder: junkFolder,
      page: 1,
      pageSize: limit,
    });
    if (!listRes.ok) {
      lines.push(`- ${account}: 读取垃圾邮件失败（folder=${junkFolder}）`);
      lines.push(`  ${snippet(renderMailAdapterFailure("Mail junk list_messages", listRes), 260)}`);
      continue;
    }

    const envelopes = parseMailEnvelopesFromResult(listRes);
    lines.push(
      `- ${account}: junkFolder=${junkFolder}${junkFolderRes.detected ? " (auto)" : ""} · listed=${envelopes.length}`,
    );
    for (const env of envelopes.slice(0, Math.min(10, envelopes.length))) {
      lines.push(formatMailEnvelopeLine(env));
    }
    if (envelopes.length > 10) {
      lines.push(`  - ... and ${envelopes.length - 10} more`);
    }

    if (sub === "list" || dryRun || envelopes.length === 0) {
      continue;
    }

    if (wantPurge) {
      const purgeRes = await runMailAdapter(api, "purge_folder", {
        account,
        folder: junkFolder,
      });
      if (!purgeRes.ok) {
        lines.push(`  - purge failed`);
        lines.push(`    ${snippet(renderMailAdapterFailure("Mail purge_folder", purgeRes), 240)}`);
      } else {
        lines.push("  - purge_folder ✓");
      }
      continue;
    }

    const ids = envelopes.map((env) => env.id).filter(Boolean);
    const deleteRes = await runMailAdapter(api, "delete_messages", {
      account,
      folder: junkFolder,
      ids,
    });
    if (!deleteRes.ok) {
      lines.push(`  - delete_messages failed`);
      lines.push(
        `    ${snippet(renderMailAdapterFailure("Mail delete_messages", deleteRes), 240)}`,
      );
    } else {
      lines.push(`  - delete_messages ✓ (ids=${ids.length})`);
    }
  }

  return { text: lines.join("\n") };
}

async function handleMailCommand(
  api: OpenClawPluginApi,
  _ctx: OpsCommandCtx,
  args: string,
): Promise<{ text: string }> {
  const parsed = parseArgs(args);
  const sub = (parsed.positionals[1] ?? "").toLowerCase();

  if (!sub || sub === "help") {
    return { text: mailCommandHelp() };
  }
  if (sub === "accounts") {
    return await handleMailAccountsCommand(api);
  }
  if (sub === "summary") {
    return await handleMailSummaryCommand(api, parsed);
  }
  if (sub === "junk") {
    return await handleMailJunkCommand(api, parsed);
  }

  return { text: `Unknown /ops mail subcommand: ${sub}\n\n${mailCommandHelp()}` };
}

function calendarCommandHelp(): string {
  return [
    "Calendar fallback commands (deterministic, no LLM):",
    "",
    "/ops calendar calendars",
    "  查看本机 macOS Calendar 可用日历列表（名称/是否可写）",
    "",
    "/ops calendar today [--calendars a,b] [--limit 20]",
    "  查看今天的日程（默认所有日历）",
    "",
    "/ops calendar week [--calendars a,b] [--limit 50]",
    "  查看未来 7 天日程",
    "",
    "/ops calendar list [--start <ISO>] [--end <ISO>] [--calendars a,b] [--limit 50] [--query 关键词] [--notes]",
    "  按时间范围列出日程；可用 query 过滤标题/地点（+notes 时含备注）",
    "",
    "/ops calendar create --title <标题> --start <ISO> [--end <ISO>] [--calendar <名称>] [--location ...] [--notes ...] [--all-day] [--dry-run]",
    "  创建日程（默认 dry-run 由你控制；不加 --dry-run 会执行写入）",
    "",
    "/ops calendar update --id <eventId> [--title ...] [--start ...] [--end ...] [--location ...] [--notes ...] [--all-day|--not-all-day] [--dry-run]",
    "  更新日程（按 event id）",
    "",
    "/ops calendar delete --id <eventId> [--confirm]",
    "  删除日程：默认仅预览；加 --confirm 才删除",
    "",
    "Examples:",
    "- /ops calendar calendars",
    "- /ops calendar today --limit 20",
    "- /ops calendar week --calendars 工作,个人 --limit 30",
    '- /ops calendar create --title "周会" --start 2026-02-23T10:00:00+08:00 --end 2026-02-23T11:00:00+08:00',
    "- /ops calendar update --id <eventId> --location 线上会议",
    "- /ops calendar delete --id <eventId> --confirm",
  ].join("\n");
}

function calendarRangeStartOfDay(offsetDays = 0): Date {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
}

function buildCalendarRangePayload(
  parsed: ParsedArgs,
  defaults?: { start: Date; end: Date },
): Record<string, unknown> {
  const startRaw = readFlagString(parsed, "start", "from");
  const endRaw = readFlagString(parsed, "end", "to");
  const limit = Math.min(500, readFlagInt(parsed, 50, "limit", "page-size", "pageSize"));
  const query = readFlagString(parsed, "query", "q");
  const includeNotes = hasFlag(parsed, "notes", "include-notes");
  const calendars = uniqueStrings([
    ...readFlagCsvStrings(parsed, "calendars", "calendar-list"),
    ...(readFlagString(parsed, "calendar") ? [readFlagString(parsed, "calendar")!] : []),
  ]);

  const payload: Record<string, unknown> = {
    limit,
  };
  if (startRaw) payload.start = startRaw;
  else if (defaults?.start) payload.start = defaults.start.toISOString();
  if (endRaw) payload.end = endRaw;
  else if (defaults?.end) payload.end = defaults.end.toISOString();
  if (query) payload.query = query;
  if (includeNotes) payload.includeNotes = true;
  if (calendars.length === 1) payload.calendar = calendars[0];
  if (calendars.length > 1) payload.calendars = calendars;
  return payload;
}

function parseCalendarSingleEventFromResult(
  res: CalendarAdapterRunResult,
): CalendarEventInfo | undefined {
  const data = asRecord(extractCalendarData(res));
  const event = asRecord(data?.event);
  if (!event) return undefined;
  const temp: CalendarAdapterRunResult = { ...res, json: { ok: true, data: { items: [event] } } };
  return parseCalendarEventsFromResult(temp)[0];
}

function renderCalendarEventBlock(title: string, items: CalendarEventInfo[]): string {
  const lines = [title];
  if (items.length === 0) {
    lines.push("- (empty)");
    return lines.join("\n");
  }
  for (const item of items) {
    lines.push(formatCalendarEventLine(item));
  }
  return lines.join("\n");
}

async function handleCalendarCalendarsCommand(api: OpenClawPluginApi): Promise<{ text: string }> {
  const res = await runCalendarAdapter(api, "list_calendars", {});
  if (!res.ok) {
    return { text: renderCalendarAdapterFailure("Calendar calendars", res) };
  }
  const calendars = parseCalendarCalendarsFromResult(res);
  return {
    text: [
      "Calendar calendars",
      ...(calendars.length
        ? calendars.map(
            (c) =>
              `- ${c.name}${c.writable ? " (writable)" : ""}${
                c.calendarIdentifier ? ` · id=${c.calendarIdentifier}` : ""
              }`,
          )
        : ["- (empty)"]),
    ].join("\n"),
  };
}

async function handleCalendarListCommand(
  api: OpenClawPluginApi,
  parsed: ParsedArgs,
  mode: "today" | "tomorrow" | "week" | "list" | "search",
): Promise<{ text: string }> {
  const defaults =
    mode === "today"
      ? { start: calendarRangeStartOfDay(0), end: calendarRangeStartOfDay(1) }
      : mode === "tomorrow"
        ? { start: calendarRangeStartOfDay(1), end: calendarRangeStartOfDay(2) }
        : mode === "week"
          ? { start: calendarRangeStartOfDay(0), end: calendarRangeStartOfDay(7) }
          : mode === "list" || mode === "search"
            ? { start: calendarRangeStartOfDay(0), end: calendarRangeStartOfDay(1) }
            : undefined;
  const payload = buildCalendarRangePayload(parsed, defaults);
  if (mode === "search" && !readFlagString(parsed, "query", "q")) {
    return { text: "Calendar search 需要 --query 关键词\n\n" + calendarCommandHelp() };
  }
  const action = mode === "search" ? "search" : "list_events";
  const res = await runCalendarAdapter(api, action, payload);
  if (!res.ok) {
    return { text: renderCalendarAdapterFailure(`Calendar ${mode}`, res) };
  }
  const events = parseCalendarEventsFromResult(res);
  const range = asRecord(extractCalendarData(res))?.range as Record<string, unknown> | undefined;
  const rangeText =
    range && typeof range.start === "string" && typeof range.end === "string"
      ? `- range: ${range.start} -> ${range.end}`
      : undefined;
  return {
    text: [
      `Calendar ${mode}`,
      ...(rangeText ? [rangeText] : []),
      `- count: ${events.length}`,
      "",
      renderCalendarEventBlock("Events", events),
    ].join("\n"),
  };
}

function buildCalendarWritePayload(
  parsed: ParsedArgs,
  opts: { requireId?: boolean },
): { ok: true; payload: Record<string, unknown> } | { ok: false; text: string } {
  const payload: Record<string, unknown> = {};
  const id = readFlagString(parsed, "id", "event-id", "uid");
  if (opts.requireId) {
    if (!id) {
      return { ok: false, text: "缺少 --id（eventId）\n\n" + calendarCommandHelp() };
    }
    payload.id = id;
  } else if (id) {
    payload.id = id;
  }

  const title = readFlagString(parsed, "title", "summary");
  const start = readFlagString(parsed, "start");
  const end = readFlagString(parsed, "end");
  const calendar = readFlagString(parsed, "calendar");
  const location = readFlagString(parsed, "location");
  const notes = readFlagString(parsed, "notes", "description");
  const url = readFlagString(parsed, "url");

  if (title) payload.title = title;
  if (start) payload.start = start;
  if (end) payload.end = end;
  if (calendar) payload.calendar = calendar;
  if (location) payload.location = location;
  if (notes) payload.notes = notes;
  if (url) payload.url = url;
  if (hasFlag(parsed, "all-day", "allday")) payload.allDay = true;
  if (hasFlag(parsed, "not-all-day")) payload.allDay = false;

  return { ok: true, payload };
}

async function handleCalendarCreateCommand(
  api: OpenClawPluginApi,
  parsed: ParsedArgs,
): Promise<{ text: string }> {
  const built = buildCalendarWritePayload(parsed, { requireId: false });
  if (!built.ok) return { text: built.text };
  const payload = built.payload;
  if (!payload.title || !payload.start) {
    return { text: "Calendar create 需要 --title 和 --start\n\n" + calendarCommandHelp() };
  }
  if (hasFlag(parsed, "dry-run", "dry")) {
    return {
      text: ["Calendar create dry-run", "- payload:", JSON.stringify(payload, null, 2)].join("\n"),
    };
  }
  const res = await runCalendarAdapter(api, "create_event", payload);
  if (!res.ok) {
    return { text: renderCalendarAdapterFailure("Calendar create", res) };
  }
  const event = parseCalendarSingleEventFromResult(res);
  return {
    text: event
      ? ["Calendar create 成功", formatCalendarEventLine(event)].join("\n")
      : "Calendar create 成功（未解析到 event 回执）",
  };
}

async function handleCalendarUpdateCommand(
  api: OpenClawPluginApi,
  parsed: ParsedArgs,
): Promise<{ text: string }> {
  const built = buildCalendarWritePayload(parsed, { requireId: true });
  if (!built.ok) return { text: built.text };
  const payload = built.payload;
  const changedKeys = Object.keys(payload).filter((k) => k !== "id");
  if (changedKeys.length === 0) {
    return {
      text: "Calendar update 至少需要一个更新字段（title/start/end/location/notes/url/all-day）",
    };
  }
  if (hasFlag(parsed, "dry-run", "dry")) {
    return {
      text: ["Calendar update dry-run", "- payload:", JSON.stringify(payload, null, 2)].join("\n"),
    };
  }
  const res = await runCalendarAdapter(api, "update_event", payload);
  if (!res.ok) {
    return { text: renderCalendarAdapterFailure("Calendar update", res) };
  }
  const event = parseCalendarSingleEventFromResult(res);
  return {
    text: event
      ? ["Calendar update 成功", formatCalendarEventLine(event)].join("\n")
      : "Calendar update 成功（未解析到 event 回执）",
  };
}

async function handleCalendarDeleteCommand(
  api: OpenClawPluginApi,
  parsed: ParsedArgs,
): Promise<{ text: string }> {
  const id = readFlagString(parsed, "id", "event-id", "uid");
  if (!id) {
    return { text: "Calendar delete 需要 --id（eventId）\n\n" + calendarCommandHelp() };
  }
  const previewRes = await runCalendarAdapter(api, "get_event", { id });
  if (!previewRes.ok && !hasFlag(parsed, "confirm")) {
    return { text: renderCalendarAdapterFailure("Calendar delete preview(get_event)", previewRes) };
  }
  const preview = previewRes.ok ? parseCalendarSingleEventFromResult(previewRes) : undefined;
  if (!hasFlag(parsed, "confirm")) {
    return {
      text: [
        "Calendar delete dry-run（未执行）",
        ...(preview ? [formatCalendarEventLine(preview)] : [`- id=${id}`]),
        "- 加 --confirm 才会真正删除",
      ].join("\n"),
    };
  }
  const res = await runCalendarAdapter(api, "delete_event", { id });
  if (!res.ok) {
    return { text: renderCalendarAdapterFailure("Calendar delete", res) };
  }
  const data = asRecord(extractCalendarData(res));
  const deleted = asRecord(data?.deleted);
  return {
    text: [
      "Calendar delete 成功",
      `- id: ${String(deleted?.id ?? id)}`,
      ...(typeof deleted?.title === "string" ? [`- title: ${deleted.title}`] : []),
      ...(typeof deleted?.calendar === "string" ? [`- calendar: ${deleted.calendar}`] : []),
    ].join("\n"),
  };
}

async function handleCalendarCommand(
  api: OpenClawPluginApi,
  _ctx: OpsCommandCtx,
  args: string,
): Promise<{ text: string }> {
  const parsed = parseArgs(args);
  const sub = (parsed.positionals[1] ?? "").toLowerCase();

  if (!sub || sub === "help") {
    return { text: calendarCommandHelp() };
  }
  if (sub === "calendars" || sub === "list-calendars") {
    return await handleCalendarCalendarsCommand(api);
  }
  if (["today", "tomorrow", "week", "list", "search"].includes(sub)) {
    return await handleCalendarListCommand(
      api,
      parsed,
      sub as "today" | "tomorrow" | "week" | "list" | "search",
    );
  }
  if (sub === "create" || sub === "add") {
    return await handleCalendarCreateCommand(api, parsed);
  }
  if (sub === "update" || sub === "edit") {
    return await handleCalendarUpdateCommand(api, parsed);
  }
  if (sub === "delete" || sub === "remove" || sub === "cancel") {
    return await handleCalendarDeleteCommand(api, parsed);
  }

  return { text: `Unknown /ops calendar subcommand: ${sub}\n\n${calendarCommandHelp()}` };
}

type LocalPathProbeResult = {
  raw: string;
  resolved: string;
  exists: boolean;
  isDir?: boolean;
  readable?: boolean;
  writable?: boolean;
  listable?: boolean;
  error?: string;
};

function filesCommandHelp(): string {
  return [
    "Local files helper (uses core fs tools; this command only shows safe roots/status):",
    "",
    "/ops files paths",
    "  查看 my-ops 配置的本地文件根目录、inbox 目录，以及当前进程是否可读写",
    "",
    "/ops files ensure-inbox",
    "  创建本地文件 inbox 目录（建议把桌面文件先移动到这里，再让模型处理）",
    "",
    "/ops files probe <path>",
    "  检查指定路径是否可访问（常用于确认 Desktop/Documents 是否被 TCC 拦住）",
    "",
    "/ops files send-feishu <path> [--dry-run] [--name <fileName>] [--account <feishuAccountId>]",
    "  把允许目录中的文件直接发到当前飞书会话（当前频道需为飞书）",
    "",
    "推荐流程（避免给 OpenClaw 过大权限）:",
    "1. 用 /ops files paths 看可操作目录",
    "2. 把桌面/下载的文件移动到 inbox（或 Downloads）",
    "3. 让模型用 core fs 工具读取/整理，再用 Feishu 工具发送",
  ].join("\n");
}

async function probeLocalPath(raw: string): Promise<LocalPathProbeResult> {
  const normalized = expandUserPath(raw);
  const out: LocalPathProbeResult = {
    raw,
    resolved: normalized || raw,
    exists: false,
  };

  try {
    const stat = await fs.stat(out.resolved);
    out.exists = true;
    out.isDir = stat.isDirectory();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.error = message;
    if (/enoent/i.test(message)) {
      return out;
    }
    return out;
  }

  try {
    await fs.access(out.resolved, FS_CONSTANTS.R_OK);
    out.readable = true;
  } catch {
    out.readable = false;
  }
  try {
    await fs.access(out.resolved, FS_CONSTANTS.W_OK);
    out.writable = true;
  } catch {
    out.writable = false;
  }
  if (out.isDir) {
    try {
      await fs.readdir(out.resolved, { withFileTypes: false });
      out.listable = true;
    } catch {
      out.listable = false;
    }
  }

  return out;
}

function isPathWithinRoot(targetPath: string, rootPath: string): boolean {
  const target = path.resolve(targetPath);
  const root = path.resolve(rootPath);
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isPathAllowedByLocalRoots(filePath: string, roots: string[]): boolean {
  return roots.some((root) => isPathWithinRoot(filePath, root));
}

function inferFeishuSendMsgType(fileName: string): "file" | "media" {
  const ext = path.extname(fileName).toLowerCase();
  if ([".mp4", ".mov", ".avi", ".m4v"].includes(ext)) {
    return "media";
  }
  return "file";
}

function formatLocalPathProbeLine(result: LocalPathProbeResult): string[] {
  const flags = [
    `exists=${result.exists}`,
    ...(result.isDir === undefined ? [] : [`dir=${result.isDir}`]),
    ...(result.readable === undefined ? [] : [`read=${result.readable}`]),
    ...(result.writable === undefined ? [] : [`write=${result.writable}`]),
    ...(result.listable === undefined ? [] : [`list=${result.listable}`]),
  ].join(" ");
  return [
    `- ${result.raw} -> ${result.resolved}`,
    `  ${flags}`,
    ...(result.error ? [`  error: ${snippet(result.error, 220)}`] : []),
  ];
}

async function handleFilesPathsCommand(api: OpenClawPluginApi): Promise<{ text: string }> {
  const cfg = readMyOpsConfig(api.pluginConfig);
  const localFiles = resolveLocalFileRoots(cfg);
  const probes = await Promise.all(localFiles.rootsRaw.map((raw) => probeLocalPath(raw)));

  const lines: string[] = [];
  lines.push("Local file roots (for core fs tools)");
  lines.push(`- inbox: ${localFiles.inboxRaw} -> ${localFiles.inboxResolved}`);
  lines.push(`- roots configured (${localFiles.rootsRaw.length}):`);
  for (const probe of probes) {
    lines.push(...formatLocalPathProbeLine(probe));
  }

  if (localFiles.showTccHints) {
    const tccTargets = ["~/Desktop", "~/Documents"];
    const tccProbes = await Promise.all(tccTargets.map((raw) => probeLocalPath(raw)));
    lines.push("");
    lines.push("macOS TCC quick check (common protected folders)");
    for (const probe of tccProbes) {
      lines.push(...formatLocalPathProbeLine(probe));
    }
    lines.push(
      "提示：如果这里显示 read/list=false 或 Operation not permitted，请把文件移动到 inbox/Downloads，或给 OpenClaw/终端授权。",
    );
  }

  lines.push("");
  lines.push(
    "建议：模型处理本地文件时优先使用 core fs 工具（read/write/edit/apply_patch），限制在以上根目录内。",
  );
  return { text: lines.join("\n") };
}

async function handleFilesEnsureInboxCommand(api: OpenClawPluginApi): Promise<{ text: string }> {
  const cfg = readMyOpsConfig(api.pluginConfig);
  const localFiles = resolveLocalFileRoots(cfg);
  const target = localFiles.inboxResolved;
  await fs.mkdir(target, { recursive: true });
  const probe = await probeLocalPath(localFiles.inboxRaw);
  return {
    text: [
      "Local file inbox ready",
      `- inbox: ${localFiles.inboxRaw} -> ${target}`,
      ...formatLocalPathProbeLine(probe),
      "",
      "你现在可以把桌面 PDF 移动到这个目录，再让模型读取并发到飞书。",
    ].join("\n"),
  };
}

async function handleFilesProbeCommand(parsed: ParsedArgs): Promise<{ text: string }> {
  const target = parsed.positionals[2] ?? readFlagString(parsed, "path");
  if (!target) {
    return { text: filesCommandHelp() };
  }
  const probe = await probeLocalPath(target);
  return {
    text: ["Local file path probe", ...formatLocalPathProbeLine(probe)].join("\n"),
  };
}

async function handleFilesSendFeishuCommand(
  api: OpenClawPluginApi,
  ctx: OpsCommandCtx,
  parsed: ParsedArgs,
): Promise<{ text: string }> {
  const targetArg = parsed.positionals[2] ?? readFlagString(parsed, "path");
  if (!targetArg) {
    return { text: filesCommandHelp() };
  }
  if ((ctx.channel ?? "").toLowerCase() !== "feishu") {
    return {
      text: [
        "Files send-feishu 失败",
        "- 当前命令不在飞书渠道上下文中",
        "- 请在飞书私聊/群聊中使用，或改用飞书插件工具发送",
      ].join("\n"),
    };
  }
  if (!ctx.to) {
    return {
      text: [
        "Files send-feishu 失败",
        "- 当前会话缺少飞书目标（ctx.to）",
        "- 请在飞书会话中重试",
      ].join("\n"),
    };
  }

  const cfg = readMyOpsConfig(api.pluginConfig);
  const localFiles = resolveLocalFileRoots(cfg);
  const rawPath = targetArg.trim();
  const resolvedPath = expandUserPath(rawPath);
  const fileName = readFlagString(parsed, "name", "file-name") ?? path.basename(resolvedPath);
  const dryRun = hasFlag(parsed, "dry-run", "dry");
  const feishuAccountOverride = readFlagString(parsed, "account", "feishu-account");

  const probe = await probeLocalPath(rawPath);
  if (!probe.exists) {
    return {
      text: ["Files send-feishu 失败", ...formatLocalPathProbeLine(probe)].join("\n"),
    };
  }
  if (probe.isDir) {
    return {
      text: [
        "Files send-feishu 失败",
        ...formatLocalPathProbeLine(probe),
        "- 目标必须是文件，当前是目录",
      ].join("\n"),
    };
  }
  if (probe.readable === false) {
    return {
      text: [
        "Files send-feishu 失败",
        ...formatLocalPathProbeLine(probe),
        "- 当前进程无读取权限（可能是 macOS TCC）",
        `- 建议先移动到 inbox: ${localFiles.inboxRaw}`,
      ].join("\n"),
    };
  }

  if (!isPathAllowedByLocalRoots(resolvedPath, localFiles.rootsResolved)) {
    return {
      text: [
        "Files send-feishu 失败",
        `- 路径不在允许目录内: ${resolvedPath}`,
        `- 允许目录: ${localFiles.rootsRaw.join(", ")}`,
        `- 建议先移动到 inbox: ${localFiles.inboxRaw}`,
        "- 可用 /ops files paths 查看当前配置与权限状态",
      ].join("\n"),
    };
  }

  let stat;
  try {
    stat = await fs.stat(resolvedPath);
  } catch (err) {
    return {
      text: [
        "Files send-feishu 失败",
        `- 无法读取文件信息: ${resolvedPath}`,
        `- error: ${err instanceof Error ? err.message : String(err)}`,
      ].join("\n"),
    };
  }

  const msgType = inferFeishuSendMsgType(fileName);
  if (dryRun) {
    return {
      text: [
        "Files send-feishu dry-run",
        `- channel: ${ctx.channel}`,
        `- to: ${ctx.to}`,
        `- accountId: ${feishuAccountOverride ?? ctx.accountId ?? "(auto)"}`,
        `- path: ${rawPath}`,
        `- resolved: ${resolvedPath}`,
        `- fileName: ${fileName}`,
        `- size: ${stat.size} bytes`,
        `- msgType: ${msgType}`,
        "- 执行时会：uploadFileFeishu -> sendFileFeishu",
      ].join("\n"),
    };
  }

  const mediaMod = await import("../../feishu/src/media.js");
  const fileType = mediaMod.detectFileType(fileName);
  const sendCfg = ctx.config as Parameters<typeof mediaMod.uploadFileFeishu>[0]["cfg"];

  const uploaded = await mediaMod.uploadFileFeishu({
    cfg: sendCfg,
    file: resolvedPath,
    fileName,
    fileType,
    accountId: feishuAccountOverride ?? ctx.accountId,
  });
  const sent = await mediaMod.sendFileFeishu({
    cfg: sendCfg,
    to: ctx.to,
    fileKey: uploaded.fileKey,
    msgType,
    accountId: feishuAccountOverride ?? ctx.accountId,
  });

  return {
    text: [
      "Files send-feishu 成功",
      `- path: ${rawPath}`,
      `- resolved: ${resolvedPath}`,
      `- fileName: ${fileName}`,
      `- size: ${stat.size} bytes`,
      `- fileKey: ${uploaded.fileKey}`,
      `- messageId: ${sent.messageId}`,
      `- chatId: ${sent.chatId}`,
    ].join("\n"),
  };
}

async function handleFilesCommand(
  api: OpenClawPluginApi,
  ctx: OpsCommandCtx,
  args: string,
): Promise<{ text: string }> {
  const parsed = parseArgs(args);
  const sub = (parsed.positionals[1] ?? "").toLowerCase();

  if (!sub || sub === "help") {
    return { text: filesCommandHelp() };
  }
  if (sub === "paths" || sub === "roots" || sub === "status") {
    return await handleFilesPathsCommand(api);
  }
  if (sub === "ensure-inbox" || sub === "mkdir-inbox" || sub === "init") {
    return await handleFilesEnsureInboxCommand(api);
  }
  if (sub === "probe" || sub === "check") {
    return await handleFilesProbeCommand(parsed);
  }
  if (sub === "send-feishu" || sub === "send") {
    return await handleFilesSendFeishuCommand(api, ctx, parsed);
  }
  return { text: `Unknown /ops files subcommand: ${sub}\n\n${filesCommandHelp()}` };
}

function renderOpsHelp(): string {
  return [
    "Unknown subcommand.",
    "",
    "Use:",
    "- /ops status",
    "- /ops paths",
    "- /ops guide",
    "- /ops menu",
    "- /ops files paths",
    "- /ops calendar help",
    "- /ops mail help",
    "- /ops mowen help",
  ].join("\n");
}

export function registerMyOpsCommand(api: OpenClawPluginApi) {
  api.registerCommand({
    name: "ops",
    description: "Show my-ops adapter/plugin status (stable workflow bridge).",
    acceptsArgs: true,
    handler: async (ctx) => {
      const arg = (ctx.args ?? "").trim();
      const lower = arg.toLowerCase();
      if (!arg || lower === "status" || lower === "help") {
        return { text: renderStatus(api) };
      }
      if (lower === "paths") {
        return {
          text: [
            `State dir: ${resolveMyOpsStateDir(api)}`,
            `Service status: ${resolveServiceStatusPath(api)}`,
            `Calls log: ${resolveCallsLogPath(api)}`,
            `Guide page: ${MY_OPS_GUIDE_PATH}`,
          ].join("\n"),
        };
      }
      if (lower === "guide") {
        return {
          text: renderGuideLinkHintsText(),
        };
      }
      if (lower === "menu") {
        return {
          text: renderGuideMenuText(),
        };
      }
      if (lower === "files" || lower.startsWith("files ")) {
        try {
          return await handleFilesCommand(api, ctx as OpsCommandCtx, arg);
        } catch (err) {
          return {
            text: `Files helper command failed:\n- ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
      if (lower === "mowen" || lower.startsWith("mowen ")) {
        try {
          return await handleMowenCommand(api, ctx as OpsCommandCtx, arg);
        } catch (err) {
          return {
            text: `Mowen fallback command failed:\n- ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
      if (lower === "mail" || lower.startsWith("mail ")) {
        try {
          return await handleMailCommand(api, ctx as OpsCommandCtx, arg);
        } catch (err) {
          return {
            text: `Mail fallback command failed:\n- ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
      if (lower === "calendar" || lower.startsWith("calendar ")) {
        try {
          return await handleCalendarCommand(api, ctx as OpsCommandCtx, arg);
        } catch (err) {
          return {
            text: `Calendar fallback command failed:\n- ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
      return {
        text: renderOpsHelp(),
      };
    },
  });
}
