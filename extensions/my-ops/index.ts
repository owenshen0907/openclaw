import path from "node:path";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk";
import { registerMyOpsCommand } from "./src/command.js";
import { readMyOpsConfig } from "./src/config.js";
import { registerMyOpsGuide } from "./src/guide.js";
import { expandUserPath, resolveLocalFileRoots } from "./src/local-files.js";
import { createMyOpsService } from "./src/service.js";
import { createDomainAdapterTool, createLocalFilesTool } from "./src/tools.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRemoteMediaLike(value: string): boolean {
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) || /^data:/i.test(trimmed);
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

export default function register(api: OpenClawPluginApi) {
  api.registerTool(
    ((ctx) =>
      ctx.sandboxed
        ? null
        : (createDomainAdapterTool(api, "calendar") as AnyAgentTool)) as OpenClawPluginToolFactory,
    { optional: true },
  );
  api.registerTool(
    ((ctx) =>
      ctx.sandboxed
        ? null
        : (createDomainAdapterTool(api, "mail") as AnyAgentTool)) as OpenClawPluginToolFactory,
    { optional: true },
  );
  api.registerTool(
    ((ctx) =>
      ctx.sandboxed
        ? null
        : (createDomainAdapterTool(api, "mowen") as AnyAgentTool)) as OpenClawPluginToolFactory,
    { optional: true },
  );
  api.registerTool(
    ((ctx) =>
      ctx.sandboxed
        ? null
        : (createLocalFilesTool(api, ctx) as AnyAgentTool)) as OpenClawPluginToolFactory,
    { optional: true },
  );

  api.registerService(createMyOpsService(api));
  registerMyOpsGuide(api);
  registerMyOpsCommand(api);

  api.on("before_tool_call", (event) => {
    if (event.toolName !== "message" || !isRecord(event.params)) {
      return;
    }
    const params = { ...event.params };
    const action = typeof params.action === "string" ? params.action.trim().toLowerCase() : "";
    if (action !== "send" && action !== "sendattachment") {
      return;
    }
    const channel = typeof params.channel === "string" ? params.channel.trim().toLowerCase() : "";
    if (channel !== "feishu") {
      return;
    }

    const mediaValue =
      typeof params.media === "string"
        ? params.media
        : typeof params.filePath === "string"
          ? params.filePath
          : typeof params.path === "string"
            ? params.path
            : undefined;
    if (!mediaValue || isRemoteMediaLike(mediaValue)) {
      return;
    }

    const cfg = readMyOpsConfig(api.pluginConfig);
    const localFiles = resolveLocalFileRoots(cfg);
    const resolved = expandUserPath(mediaValue.trim());

    if (!isPathAllowedByLocalRoots(resolved, localFiles.rootsResolved)) {
      return {
        block: true,
        blockReason: [
          "Feishu 本地文件发送已拦截：目标路径不在允许目录内。",
          `path=${resolved}`,
          `允许目录: ${localFiles.rootsRaw.join(", ")}`,
          `请先移动到 inbox/Downloads（建议 inbox: ${localFiles.inboxRaw}）后再重试。`,
          "可先用 /ops files paths 查看权限状态；在飞书中建议使用 /ops files send-feishu <path>。",
        ].join(" "),
      };
    }

    return {
      block: true,
      blockReason: [
        "Feishu 本地文件发送已拦截：请改用 ops_files 工具 action=send_feishu（支持 dryRun）进行确定性发送。",
        "不要使用 message(action=send, path/filePath/media=<local-path>)，否则上传失败时可能回退成发送路径文本。",
        `path=${resolved}`,
      ].join(" "),
    };
  });

  api.on("before_agent_start", () => {
    return {
      prependContext: [
        "<my-ops-exec-rules>",
        "When the user asks to publish/edit Mowen content and tools are available:",
        "- Prefer tool execution over long drafting chat (feishu_doc read -> ops_mowen create_doc/update_doc/set_doc).",
        "- Do not mention unsupported Mowen actions like list/get/publish as API operations.",
        "- If the user says 'directly publish' / '直接发', execute first and return a receipt.",
        "- Keep pre-execution confirmations brief (max one blocking clarification) unless safety-critical.",
        "When the user asks about email and ops_mail is available:",
        "- Prefer ops_mail list_messages/get_message/draft_reply before attempting send_message.",
        "- For send_message, include idempotencyKey and keep confirmations brief unless the user requests review.",
        "- Do not ask the user to manually run /ops mail commands if you can execute equivalent ops_mail tool calls yourself.",
        "- Treat /ops mail commands as internal fallback recipes; only ask the user to run them when tools are unavailable/blocked or adapter calls keep failing.",
        "- For multi-account mail questions (e.g. QQ/iCloud/StepFun recent mail), first use ops_mail list_accounts, then call list_messages/search per target account and return a direct answer.",
        "- For junk cleanup, inspect with ops_mail list_folders/list_messages first; for destructive actions keep confirmation brief and explicit.",
        "- If the user asks a yes/no question about mailbox activity, answer directly with the counts/time range after tool calls instead of replying with command instructions.",
        "When the user asks about calendar and ops_calendar is available:",
        "- Prefer ops_calendar list_calendars/list_events/get_event for inspection, and create_event/update_event/delete_event for execution.",
        "- Do not ask the user to manually run /ops calendar commands if equivalent ops_calendar tool calls are available.",
        "- Use /ops calendar ... only as a fallback recipe when tools are blocked/unavailable or repeated adapter errors occur.",
        "When the user asks about Feishu docs/wiki/knowledge bases and feishu_* tools are available:",
        "- Prefer immediate tool execution (e.g. feishu_wiki / feishu_doc) in the same turn; do not stop after a placeholder acknowledgement.",
        "- If the user references a numbered item from your previous list (e.g. '把2下面的文档列出来'), resolve the index to the previously listed item and continue without asking again.",
        "- Avoid replies like '好的，我这就...' unless you also execute the required tool call in that same turn.",
        "When the user asks about local files (especially Desktop/Downloads/PDFs):",
        "- Prefer core fs tools (read/write/edit/apply_patch) for file operations; this is a core capability, not a my-ops adapter.",
        "- If ops_files is available, use it for deterministic local-file checks and Feishu file delivery (paths/probe_path/ensure_inbox/send_feishu).",
        "- For screenshot requests (e.g. '帮我截图看看桌面' / '截图后发我'), prefer ops_files capture_screen or capture_screen_send_feishu (capture to file first, then send).",
        "- If macOS returns 'Operation not permitted' for Desktop/Documents, suggest moving the file into the configured inbox/Downloads and continue there.",
        "- If screenshot capture fails, explain that macOS '屏幕录制' permission is required (系统设置 -> 隐私与安全性 -> 屏幕录制).",
        "- If unsure which directories are safe/accessible, use the /ops files paths helper (or ask the user to run it) and then proceed.",
        "- For explicit 'send this local file to Feishu' requests in a Feishu chat, prefer the deterministic /ops files send-feishu <path> flow (prefer --dry-run first if path/target may be ambiguous).",
        "- Do NOT use message(action=send, path=<local-file>) for Feishu local file sends; use filePath/media if needed, and never claim success if upload failed.",
        "- If a local file send fails, report the exact error and suggest moving the file to inbox/Downloads instead of sending a local path as text.",
        "- For Feishu link -> Mowen publish/edit, remember deterministic fallback commands: /ops mowen fetch|post|edit (supports Docx/Wiki links).",
        "Hard fallback exists via /ops mowen post|edit for deterministic publishing from Feishu Docx/Wiki links.",
        "</my-ops-exec-rules>",
      ].join("\n"),
    };
  });
}
