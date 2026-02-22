import { constants as FS_CONSTANTS } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import { jsonResult, readNumberParam, readStringParam } from "openclaw/plugin-sdk";
import { readMyOpsConfig, type AdapterDomain } from "./config.js";
import { expandUserPath, resolveLocalFileRoots } from "./local-files.js";
import { appendCallRecord } from "./state.js";

const DOMAIN_ACTIONS: Record<AdapterDomain, string[]> = {
  calendar: [
    "health",
    "list_calendars",
    "list_events",
    "get_event",
    "create_event",
    "update_event",
    "delete_event",
    "search",
  ],
  mail: [
    "health",
    "list_accounts",
    "list_folders",
    "list_messages",
    "get_message",
    "draft_reply",
    "send_message",
    "archive",
    "delete_messages",
    "purge_folder",
    "label",
    "mark_read",
    "search",
  ],
  mowen: [
    "health",
    "create_doc",
    "update_doc",
    "set_doc",
    "create_note",
    "edit_note",
    "set_note",
    "upload_prepare",
    "upload_url",
  ],
};

function toolNameForDomain(domain: AdapterDomain): string {
  return `ops_${domain}`;
}

function toolLabelForDomain(domain: AdapterDomain): string {
  return `Ops ${domain[0]!.toUpperCase()}${domain.slice(1)}`;
}

function toolDescriptionForDomain(domain: AdapterDomain): string {
  const actions = DOMAIN_ACTIONS[domain].join(", ");
  return `Stable ${domain} adapter bridge. Executes a local adapter command with JSON I/O. Actions: ${actions}`;
}

function toolSchemaForDomain(domain: AdapterDomain): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: DOMAIN_ACTIONS[domain],
        description: `Operation for the ${domain} adapter.`,
      },
      payload: {
        description: "Adapter-specific JSON payload. Passed through unchanged.",
      },
      requestId: {
        type: "string",
        description: "Optional request id for tracing and dedupe.",
      },
      idempotencyKey: {
        type: "string",
        description: "Optional idempotency key for write actions.",
      },
      timeoutMs: {
        type: "number",
        description: "Per-call timeout override for the adapter subprocess.",
      },
    },
    required: ["action"],
  };
}

type AdapterEnvelope = {
  version: 1;
  domain: AdapterDomain;
  action: string;
  requestId?: string;
  idempotencyKey?: string;
  payload?: unknown;
  meta: {
    plugin: string;
    tool: string;
    timestamp: string;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readBoolParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const raw = params[key];
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return undefined;
}

function snippet(text: string, max = 220): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function buildHealthResult(api: OpenClawPluginApi, domain: AdapterDomain) {
  const cfg = readMyOpsConfig(api.pluginConfig);
  const adapter = cfg.adapters[domain];
  return {
    ok: Boolean(adapter.enabled && adapter.command),
    domain,
    configured: Boolean(adapter.command),
    enabled: adapter.enabled,
    command: adapter.command ?? null,
    argsCount: adapter.args.length,
    cwd: adapter.cwd ?? null,
    timeoutMs: adapter.timeoutMs,
    stateDir: api.runtime.state.resolveStateDir(),
    note:
      adapter.command && adapter.enabled
        ? "Adapter is configured. Health probe will run when action=health is called."
        : "Configure adapters.<domain>.command to enable this tool.",
  };
}

function parseAdapterStdout(stdout: string): { parsed?: unknown; parseError?: string } {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return { parsed: JSON.parse(trimmed) as unknown };
  } catch (err) {
    return { parseError: String(err) };
  }
}

export function createDomainAdapterTool(api: OpenClawPluginApi, domain: AdapterDomain) {
  return {
    name: toolNameForDomain(domain),
    label: toolLabelForDomain(domain),
    description: toolDescriptionForDomain(domain),
    parameters: toolSchemaForDomain(domain),
    async execute(_toolCallId: string, rawParams: unknown) {
      if (!isRecord(rawParams)) {
        return jsonResult({ ok: false, error: "params must be an object", domain });
      }

      const action = readStringParam(rawParams, "action", { required: true });
      const cfg = readMyOpsConfig(api.pluginConfig);
      const adapter = cfg.adapters[domain];

      if (action === "health" && !adapter.command) {
        return jsonResult(buildHealthResult(api, domain));
      }

      if (!adapter.enabled) {
        return jsonResult({
          ok: false,
          domain,
          action,
          error: `Adapter '${domain}' is disabled in plugin config`,
        });
      }
      if (!adapter.command) {
        return jsonResult({
          ok: false,
          domain,
          action,
          error: `Adapter '${domain}' is not configured`,
          hint: `Set plugins.entries.my-ops.config.adapters.${domain}.command`,
        });
      }

      const envelope: AdapterEnvelope = {
        version: 1,
        domain,
        action,
        requestId: readStringParam(rawParams, "requestId"),
        idempotencyKey: readStringParam(rawParams, "idempotencyKey"),
        payload: rawParams.payload,
        meta: {
          plugin: "my-ops",
          tool: toolNameForDomain(domain),
          timestamp: new Date().toISOString(),
        },
      };

      const timeoutMs =
        readNumberParam(rawParams, "timeoutMs", { integer: true }) ?? adapter.timeoutMs;
      const argv = [adapter.command, ...adapter.args];
      const startedAt = Date.now();

      try {
        const result = await api.runtime.system.runCommandWithTimeout(argv, {
          timeoutMs,
          cwd: adapter.cwd,
          input: `${JSON.stringify(envelope)}\n`,
          env: adapter.env,
        });

        const parsed = parseAdapterStdout(result.stdout);
        const ok = result.code === 0;

        void appendCallRecord(api, {
          ts: new Date().toISOString(),
          domain,
          action,
          argv,
          cwd: adapter.cwd,
          timeoutMs,
          durationMs: Date.now() - startedAt,
          code: result.code,
          signal: result.signal,
          killed: result.killed,
          stdout: result.stdout,
          stderr: result.stderr,
        }).catch(() => {});

        return jsonResult({
          ok,
          domain,
          action,
          adapter: {
            command: adapter.command,
            args: adapter.args,
            cwd: adapter.cwd ?? null,
          },
          exec: {
            code: result.code,
            signal: result.signal,
            killed: result.killed,
            durationMs: Date.now() - startedAt,
          },
          stdoutJson: parsed.parsed,
          stdoutRaw: parsed.parsed === undefined ? result.stdout : undefined,
          stdoutParseError: parsed.parseError,
          stderr: result.stderr || undefined,
        });
      } catch (err) {
        void appendCallRecord(api, {
          ts: new Date().toISOString(),
          domain,
          action,
          argv,
          cwd: adapter.cwd,
          timeoutMs,
          durationMs: Date.now() - startedAt,
          error: String(err),
        }).catch(() => {});

        return jsonResult({
          ok: false,
          domain,
          action,
          error: `adapter subprocess failed: ${String(err)}`,
          adapter: {
            command: adapter.command,
            args: adapter.args,
            cwd: adapter.cwd ?? null,
          },
          exec: { durationMs: Date.now() - startedAt, timeoutMs },
        });
      }
    },
  };
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

type SessionDeliveryInfo = {
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
  };
  threadId?: string;
};

function parseSessionThreadInfo(sessionKey: string | undefined): {
  baseSessionKey?: string;
  threadId?: string;
} {
  if (!sessionKey) return {};
  const topicIndex = sessionKey.lastIndexOf(":topic:");
  const threadIndex = sessionKey.lastIndexOf(":thread:");
  const markerIndex = Math.max(topicIndex, threadIndex);
  const marker = topicIndex > threadIndex ? ":topic:" : ":thread:";
  if (markerIndex === -1) {
    return { baseSessionKey: sessionKey };
  }
  const baseSessionKey = sessionKey.slice(0, markerIndex) || sessionKey;
  const threadIdRaw = sessionKey.slice(markerIndex + marker.length).trim();
  return {
    baseSessionKey,
    threadId: threadIdRaw || undefined,
  };
}

async function readSessionDeliveryInfo(
  api: OpenClawPluginApi,
  sessionKey: string | undefined,
): Promise<SessionDeliveryInfo> {
  const { baseSessionKey, threadId } = parseSessionThreadInfo(sessionKey);
  if (!sessionKey || !baseSessionKey) {
    return { threadId };
  }
  try {
    const cfg = api.runtime.config.loadConfig();
    const storePath = api.runtime.channel.session.resolveStorePath(cfg.session?.store);
    const raw = await fs.readFile(storePath, "utf8");
    const store = JSON.parse(raw) as unknown;
    if (!isRecord(store)) {
      return { threadId };
    }
    let entry = store[sessionKey];
    if (!isRecord(entry) && baseSessionKey !== sessionKey) {
      entry = store[baseSessionKey];
    }
    if (!isRecord(entry) || !isRecord(entry.deliveryContext)) {
      return { threadId };
    }
    const deliveryContext = entry.deliveryContext as Record<string, unknown>;
    return {
      deliveryContext: {
        channel: typeof deliveryContext.channel === "string" ? deliveryContext.channel : undefined,
        to: typeof deliveryContext.to === "string" ? deliveryContext.to : undefined,
        accountId:
          typeof deliveryContext.accountId === "string" ? deliveryContext.accountId : undefined,
      },
      threadId,
    };
  } catch {
    return { threadId };
  }
}

async function probeLocalPath(raw: string): Promise<LocalPathProbeResult> {
  const resolved = expandUserPath(raw);
  const out: LocalPathProbeResult = {
    raw,
    resolved: resolved || raw,
    exists: false,
  };
  try {
    const stat = await fs.stat(out.resolved);
    out.exists = true;
    out.isDir = stat.isDirectory();
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
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
      await fs.readdir(out.resolved);
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

const FILE_TOOL_ACTIONS = [
  "paths",
  "probe_path",
  "ensure_inbox",
  "send_feishu",
  "capture_screen",
  "capture_screen_send_feishu",
] as const;

function filesToolSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: [...FILE_TOOL_ACTIONS],
        description:
          "Local-files helper action. Use send_feishu for deterministic local-file delivery in Feishu chats.",
      },
      path: {
        type: "string",
        description: "Target file/path for probe_path or send_feishu. Supports ~/ expansion.",
      },
      filePath: {
        type: "string",
        description: "Alias for path (useful when models prefer filePath).",
      },
      fileName: {
        type: "string",
        description: "Optional override file name when sending to Feishu.",
      },
      to: {
        type: "string",
        description:
          "Optional explicit Feishu chat/user id. Usually omitted so the tool uses current session delivery target.",
      },
      accountId: {
        type: "string",
        description: "Optional Feishu account id override (e.g. personal/main).",
      },
      dryRun: {
        type: "boolean",
        description: "Validate and resolve target without uploading/sending.",
      },
      saveDir: {
        type: "string",
        description:
          "Target directory for screenshots (capture_screen/capture_screen_send_feishu). Defaults to my-ops inbox.",
      },
      timeoutMs: {
        type: "number",
        description: "Optional timeout override (ms) for screenshot capture.",
      },
    },
    required: ["action"],
  };
}

function buildDefaultScreenshotFileName(): string {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  return `desktop-screenshot-${iso}.png`;
}

function normalizeScreenshotFileName(input: string | undefined): string {
  const trimmed = input?.trim() || buildDefaultScreenshotFileName();
  if (!trimmed) return buildDefaultScreenshotFileName();
  return path.extname(trimmed) ? trimmed : `${trimmed}.png`;
}

export function createLocalFilesTool(api: OpenClawPluginApi, toolCtx: OpenClawPluginToolContext) {
  return {
    name: "ops_files",
    label: "Ops Files",
    description:
      "Deterministic local-files helper for my-ops. Actions: paths, probe_path, ensure_inbox, send_feishu, capture_screen, capture_screen_send_feishu.",
    parameters: filesToolSchema(),
    async execute(_toolCallId: string, rawParams: unknown) {
      if (!isRecord(rawParams)) {
        return jsonResult({ ok: false, error: "params must be an object", tool: "ops_files" });
      }

      const action = readStringParam(rawParams, "action", { required: true });
      const cfg = readMyOpsConfig(api.pluginConfig);
      const localFiles = resolveLocalFileRoots(cfg);

      const sendFeishuFromPath = async (params: {
        actionName: string;
        rawPath: string;
        resolvedPath?: string;
        dryRun?: boolean;
        fileNameOverride?: string;
        toOverride?: string;
        accountIdOverride?: string;
      }) => {
        const rawPath = params.rawPath;
        const dryRun = params.dryRun ?? false;
        const resolvedPath = params.resolvedPath ?? expandUserPath(rawPath);
        const probe = await probeLocalPath(rawPath);
        if (!probe.exists) {
          return jsonResult({
            ok: false,
            tool: "ops_files",
            action: params.actionName,
            error: "target path does not exist",
            probe,
          });
        }
        if (probe.isDir) {
          return jsonResult({
            ok: false,
            tool: "ops_files",
            action: params.actionName,
            error: "target path is a directory; file required",
            probe,
          });
        }
        if (probe.readable === false) {
          return jsonResult({
            ok: false,
            tool: "ops_files",
            action: params.actionName,
            error:
              "target file is not readable (possibly macOS TCC). Move it to inbox/Downloads or grant permission.",
            probe,
            inbox: {
              raw: localFiles.inboxRaw,
              resolved: localFiles.inboxResolved,
            },
          });
        }
        if (!isPathAllowedByLocalRoots(resolvedPath, localFiles.rootsResolved)) {
          return jsonResult({
            ok: false,
            tool: "ops_files",
            action: params.actionName,
            error: "path is outside configured localFiles.roots",
            path: resolvedPath,
            allowedRoots: localFiles.rootsRaw,
            inbox: localFiles.inboxRaw,
          });
        }

        const stat = await fs.stat(resolvedPath);
        const fileName = params.fileNameOverride ?? path.basename(resolvedPath);

        const sessionInfo = await readSessionDeliveryInfo(api, toolCtx.sessionKey);
        const sessionChannel = sessionInfo.deliveryContext?.channel?.toLowerCase();
        const effectiveChannel = (toolCtx.messageChannel ?? sessionChannel ?? "").toLowerCase();
        const to = params.toOverride ?? sessionInfo.deliveryContext?.to;
        const accountId =
          params.accountIdOverride ??
          sessionInfo.deliveryContext?.accountId ??
          toolCtx.agentAccountId;

        if (effectiveChannel !== "feishu") {
          return jsonResult({
            ok: false,
            tool: "ops_files",
            action: params.actionName,
            error:
              "send_feishu requires a Feishu message context (or explicit target in a Feishu-run session)",
            context: {
              messageChannel: toolCtx.messageChannel ?? null,
              sessionChannel: sessionInfo.deliveryContext?.channel ?? null,
              sessionKey: toolCtx.sessionKey ?? null,
            },
          });
        }
        if (!to) {
          return jsonResult({
            ok: false,
            tool: "ops_files",
            action: params.actionName,
            error:
              "could not resolve Feishu target from current session; retry in a Feishu chat or pass `to`",
            context: {
              sessionKey: toolCtx.sessionKey ?? null,
              deliveryContext: sessionInfo.deliveryContext ?? null,
            },
          });
        }

        const msgType = inferFeishuSendMsgType(fileName);
        if (dryRun) {
          return jsonResult({
            ok: true,
            tool: "ops_files",
            action: params.actionName,
            dryRun: true,
            target: {
              channel: "feishu",
              to,
              accountId: accountId ?? null,
              fromSession: Boolean(sessionInfo.deliveryContext?.to),
            },
            file: {
              rawPath,
              resolvedPath,
              fileName,
              sizeBytes: stat.size,
              msgType,
            },
          });
        }

        try {
          const mediaMod = await import("../../feishu/src/media.js");
          const fileType = mediaMod.detectFileType(fileName);
          const sendCfg = toolCtx.config ?? api.config;

          const uploaded = await mediaMod.uploadFileFeishu({
            cfg: sendCfg,
            file: resolvedPath,
            fileName,
            fileType,
            accountId: accountId ?? undefined,
          });
          const sent = await mediaMod.sendFileFeishu({
            cfg: sendCfg,
            to,
            fileKey: uploaded.fileKey,
            msgType,
            accountId: accountId ?? undefined,
          });

          return jsonResult({
            ok: true,
            tool: "ops_files",
            action: params.actionName,
            target: {
              channel: "feishu",
              to,
              accountId: accountId ?? null,
            },
            file: {
              rawPath,
              resolvedPath,
              fileName,
              sizeBytes: stat.size,
              msgType,
              fileKey: uploaded.fileKey,
            },
            result: {
              messageId: sent.messageId,
              chatId: sent.chatId,
            },
          });
        } catch (err) {
          return jsonResult({
            ok: false,
            tool: "ops_files",
            action: params.actionName,
            error: `feishu upload/send failed: ${snippet(err instanceof Error ? err.message : String(err), 400)}`,
            hint: "可先用 dryRun=true 验证路径与会话目标；若是本地文件权限问题，请检查 macOS 文件夹权限。",
          });
        }
      };

      if (action === "paths") {
        const roots = await Promise.all(localFiles.rootsRaw.map((raw) => probeLocalPath(raw)));
        const tccTargets = localFiles.showTccHints
          ? ["~/Desktop", "~/Documents", "~/Downloads", "~/Movies", "~/Pictures"]
          : [];
        const tccChecks = await Promise.all(tccTargets.map((raw) => probeLocalPath(raw)));
        return jsonResult({
          ok: true,
          tool: "ops_files",
          action,
          inbox: {
            raw: localFiles.inboxRaw,
            resolved: localFiles.inboxResolved,
          },
          roots: roots.map((p) => ({
            raw: p.raw,
            resolved: p.resolved,
            exists: p.exists,
            isDir: p.isDir,
            readable: p.readable,
            writable: p.writable,
            listable: p.listable,
            error: p.error,
          })),
          tccHintsEnabled: localFiles.showTccHints,
          tccChecks: tccChecks.length > 0 ? tccChecks : undefined,
          note: "Configured roots control my-ops local file helpers. macOS TCC may still block Desktop/Documents/etc until system permissions are granted.",
        });
      }

      if (action === "ensure_inbox") {
        await fs.mkdir(localFiles.inboxResolved, { recursive: true });
        const probe = await probeLocalPath(localFiles.inboxRaw);
        return jsonResult({
          ok: true,
          tool: "ops_files",
          action,
          inbox: {
            raw: localFiles.inboxRaw,
            resolved: localFiles.inboxResolved,
          },
          probe,
        });
      }

      if (action === "probe_path") {
        const rawPath =
          readStringParam(rawParams, "path") ?? readStringParam(rawParams, "filePath");
        if (!rawPath) {
          return jsonResult({
            ok: false,
            tool: "ops_files",
            action,
            error: "path is required for probe_path",
          });
        }
        const probe = await probeLocalPath(rawPath);
        return jsonResult({
          ok: true,
          tool: "ops_files",
          action,
          probe,
          allowedByRoots: isPathAllowedByLocalRoots(probe.resolved, localFiles.rootsResolved),
        });
      }

      if (action === "send_feishu") {
        const rawPath =
          readStringParam(rawParams, "path", { trim: false }) ??
          readStringParam(rawParams, "filePath", { trim: false });
        if (!rawPath) {
          return jsonResult({
            ok: false,
            tool: "ops_files",
            action,
            error: "path/filePath is required for send_feishu",
          });
        }
        return await sendFeishuFromPath({
          actionName: action,
          rawPath,
          dryRun: readBoolParam(rawParams, "dryRun") ?? false,
          fileNameOverride: readStringParam(rawParams, "fileName", { trim: false }) ?? undefined,
          toOverride: readStringParam(rawParams, "to", { trim: false }) ?? undefined,
          accountIdOverride: readStringParam(rawParams, "accountId") ?? undefined,
        });
      }

      if (action === "capture_screen" || action === "capture_screen_send_feishu") {
        const dryRun = readBoolParam(rawParams, "dryRun") ?? false;
        const saveDirRaw =
          readStringParam(rawParams, "saveDir", { trim: false }) ?? localFiles.inboxRaw;
        const saveDir = expandUserPath(saveDirRaw);
        if (!isPathAllowedByLocalRoots(saveDir, localFiles.rootsResolved)) {
          return jsonResult({
            ok: false,
            tool: "ops_files",
            action,
            error: "saveDir is outside configured localFiles.roots",
            saveDir,
            allowedRoots: localFiles.rootsRaw,
            inbox: localFiles.inboxRaw,
          });
        }
        const fileName = normalizeScreenshotFileName(
          readStringParam(rawParams, "fileName", { trim: false }) ?? undefined,
        );
        const outputPath = path.join(saveDir, fileName);
        const timeoutMs = readNumberParam(rawParams, "timeoutMs", { integer: true }) ?? 15_000;

        if (dryRun) {
          return jsonResult({
            ok: true,
            tool: "ops_files",
            action,
            dryRun: true,
            screenshot: {
              saveDirRaw,
              saveDir,
              fileName,
              outputPath,
              timeoutMs,
              command: ["/usr/sbin/screencapture", "-x", outputPath],
            },
            next:
              action === "capture_screen_send_feishu"
                ? "Will capture first, then upload/send to current Feishu session via send_feishu flow."
                : "Will capture a full-screen screenshot to the output path.",
          });
        }

        try {
          await fs.mkdir(saveDir, { recursive: true });
        } catch (err) {
          return jsonResult({
            ok: false,
            tool: "ops_files",
            action,
            error: `failed to create screenshot directory: ${snippet(err instanceof Error ? err.message : String(err), 300)}`,
            saveDir,
          });
        }

        let captureResult;
        try {
          captureResult = await api.runtime.system.runCommandWithTimeout(
            ["/usr/sbin/screencapture", "-x", outputPath],
            { timeoutMs },
          );
        } catch (err) {
          return jsonResult({
            ok: false,
            tool: "ops_files",
            action,
            error: `screencapture command failed: ${snippet(err instanceof Error ? err.message : String(err), 400)}`,
            hint: "需要 macOS 屏幕录制权限：系统设置 -> 隐私与安全性 -> 屏幕录制，给 OpenClaw 和终端授予权限。",
            screenshot: { outputPath, timeoutMs },
          });
        }

        if (captureResult.code !== 0) {
          return jsonResult({
            ok: false,
            tool: "ops_files",
            action,
            error: "screencapture exited with non-zero status",
            exec: {
              code: captureResult.code,
              signal: captureResult.signal,
              killed: captureResult.killed,
            },
            stdout: captureResult.stdout ? snippet(captureResult.stdout, 400) : undefined,
            stderr: captureResult.stderr ? snippet(captureResult.stderr, 400) : undefined,
            hint: "常见原因是未授予‘屏幕录制’权限，或当前环境禁止屏幕捕获。",
            screenshot: { outputPath, timeoutMs },
          });
        }

        let stat;
        try {
          stat = await fs.stat(outputPath);
        } catch (err) {
          return jsonResult({
            ok: false,
            tool: "ops_files",
            action,
            error: `screenshot file not found after capture: ${snippet(err instanceof Error ? err.message : String(err), 300)}`,
            screenshot: { outputPath, timeoutMs },
          });
        }

        if (action === "capture_screen") {
          return jsonResult({
            ok: true,
            tool: "ops_files",
            action,
            screenshot: {
              outputPath,
              fileName,
              sizeBytes: stat.size,
              savedInAllowedRoots: true,
            },
          });
        }

        return await sendFeishuFromPath({
          actionName: action,
          rawPath: outputPath,
          resolvedPath: outputPath,
          fileNameOverride: fileName,
          toOverride: readStringParam(rawParams, "to", { trim: false }) ?? undefined,
          accountIdOverride: readStringParam(rawParams, "accountId") ?? undefined,
        });
      }

      return jsonResult({
        ok: false,
        tool: "ops_files",
        action,
        error: `unsupported action: ${action}`,
        allowedActions: [...FILE_TOOL_ACTIONS],
      });
    },
  };
}

export { toolNameForDomain, type AdapterDomain };
