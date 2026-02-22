import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk";
import { registerMyOpsCommand } from "./src/command.js";
import { registerMyOpsGuide } from "./src/guide.js";
import { createMyOpsService } from "./src/service.js";
import { createDomainAdapterTool } from "./src/tools.js";

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

  api.registerService(createMyOpsService(api));
  registerMyOpsGuide(api);
  registerMyOpsCommand(api);

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
        "- For Feishu link -> Mowen publish/edit, remember deterministic fallback commands: /ops mowen fetch|post|edit (supports Docx/Wiki links).",
        "Hard fallback exists via /ops mowen post|edit for deterministic publishing from Feishu Docx/Wiki links.",
        "</my-ops-exec-rules>",
      ].join("\n"),
    };
  });
}
