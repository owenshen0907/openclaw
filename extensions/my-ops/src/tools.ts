import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult, readNumberParam, readStringParam } from "openclaw/plugin-sdk";
import { readMyOpsConfig, type AdapterDomain } from "./config.js";
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

export { toolNameForDomain, type AdapterDomain };
