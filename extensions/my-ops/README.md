# My Ops (private workflow bridge)

`my-ops` is a plugin skeleton for a stable, controllable workflow layer in your fork.

It is intentionally split by responsibility:

- `ops_calendar` -> your calendar adapter
- `ops_mail` -> your mail adapter
- `ops_mowen` -> your Mowen adapter
- `/ops status` -> plugin health/config inspection (no LLM required)
- plugin service -> persistent state + status/call logs for debugging

## Why this shape

The plugin keeps OpenClaw core changes minimal while moving unstable workflow logic
out of prompts/skills and into deterministic adapters.

- OpenClaw handles channels, sessions, cron, heartbeat, and tool routing.
- This plugin exposes stable tool contracts (`action` + JSON `payload`).
- Your adapter CLI/service owns business logic and external API quirks.

This makes upstream syncing easier because your custom behavior lives mostly in:

- `extensions/my-ops/**`
- your external adapter repo/binaries
- cron/heartbeat config
- Lobster workflows

## Enable

1. Install/enable this plugin in your OpenClaw setup.
2. Allow the optional tools:

```json5
{
  tools: {
    alsoAllow: ["my-ops"],
  },
}
```

Or allow the concrete tools explicitly:

```json5
{
  tools: {
    alsoAllow: ["ops_calendar", "ops_mail", "ops_mowen"],
  },
}
```

## Configure adapters

Each domain points to a local command that reads JSON from stdin and returns JSON on stdout.

```json5
{
  plugins: {
    entries: {
      "my-ops": {
        enabled: true,
        config: {
          adapters: {
            calendar: {
              command: "/Users/owen/bin/myops-adapter",
              args: ["calendar"],
              timeoutMs: 20000,
            },
            mail: {
              command: "/Users/owen/bin/myops-adapter",
              args: ["mail"],
              timeoutMs: 30000,
            },
            mowen: {
              command: "/Users/owen/bin/myops-adapter",
              args: ["mowen"],
              timeoutMs: 30000,
            },
          },
          service: {
            enabled: true,
            tickSeconds: 300,
            writeStatusFile: true,
          },
          observability: {
            recordCalls: true,
            maxOutputChars: 4000,
          },
        },
      },
    },
  },
}
```

## Adapter protocol (stdin -> stdout)

The plugin writes one JSON envelope to stdin:

```json
{
  "version": 1,
  "domain": "calendar",
  "action": "list_events",
  "payload": { "start": "2026-02-22", "end": "2026-02-23" },
  "requestId": "optional",
  "idempotencyKey": "optional",
  "meta": {
    "plugin": "my-ops",
    "tool": "ops_calendar",
    "timestamp": "2026-02-22T00:00:00.000Z"
  }
}
```

The adapter should return JSON on stdout and exit `0` on success.

## Himalaya mail adapter (included)

This repo now includes a ready-to-wire Himalaya adapter script:

- `extensions/my-ops/bin/himalaya-mail-adapter.js`

It is designed to be used behind `ops_mail`, so the LLM calls a stable `ops_mail` API while the
adapter translates that into `himalaya` commands.

Supported actions (current skeleton):

- `health`
- `list_messages`
- `search`
- `get_message`
- `draft_reply`
- `send_message`
- `archive`
- `mark_read`
- `label` (mapped to Himalaya flags)

### Mail adapter config example (Himalaya)

Use `node` to run the adapter and pass Himalaya settings via env:

```json5
{
  plugins: {
    entries: {
      "my-ops": {
        enabled: true,
        config: {
          adapters: {
            mail: {
              command: "node",
              args: ["/Users/owen/go/src/openclaw/extensions/my-ops/bin/himalaya-mail-adapter.js"],
              timeoutMs: 30000,
              env: {
                MYOPS_HIMALAYA_BIN: "/opt/homebrew/bin/himalaya",
                MYOPS_HIMALAYA_CONFIG: "/Users/owen/Library/Application Support/himalaya/config.toml",
                MYOPS_HIMALAYA_ACCOUNT: "work",
                MYOPS_HIMALAYA_FOLDER: "INBOX",
              },
            },
          },
        },
      },
    },
  },
}
```

Notes:

- `MYOPS_HIMALAYA_ACCOUNT` is optional if your Himalaya config has a default account.
- `MYOPS_HIMALAYA_CONFIG` is optional if Himalaya can find its default config path.
- `MYOPS_HIMALAYA_STATE_DIR` is optional (used for send idempotency storage).
- You can override `account`, `folder`, and `timeoutMs` per tool call via `payload`.

### `ops_mail` payload examples

List inbox:

```json
{
  "action": "list_messages",
  "payload": {
    "folder": "INBOX",
    "page": 1,
    "pageSize": 20
  }
}
```

Search (query string or tokens):

```json
{
  "action": "search",
  "payload": {
    "query": "from boss@example.com order by date desc",
    "pageSize": 10
  }
}
```

```json
{
  "action": "search",
  "payload": {
    "queryTokens": ["from", "boss@example.com", "order by", "date", "desc"],
    "pageSize": 10
  }
}
```

Read message without marking seen:

```json
{
  "action": "get_message",
  "payload": {
    "id": 42,
    "preview": true
  }
}
```

Generate reply draft template:

```json
{
  "action": "draft_reply",
  "payload": {
    "id": 42,
    "allRecipients": false,
    "body": "Thanks for the update.\\n\\n"
  }
}
```

Send raw RFC822 message:

```json
{
  "action": "send_message",
  "payload": {
    "rawMessage": "From: you@example.com\\nTo: a@example.com\\nSubject: Hello\\n\\nHi"
  }
}
```

Idempotent send (recommended):

```json
{
  "action": "send_message",
  "idempotencyKey": "mail-send-2026-02-22-standup-reply-42",
  "payload": {
    "rawMessage": "From: you@example.com\\nTo: a@example.com\\nSubject: Hello\\n\\nHi"
  }
}
```

If the same `idempotencyKey` is retried with the same content, the adapter returns a successful
`duplicate/skippedSend` response instead of sending again.

Mark read + archive:

```json
{ "action": "mark_read", "payload": { "ids": [42] } }
```

```json
{ "action": "archive", "payload": { "ids": [42], "archiveFolder": "Archive" } }
```

## Mowen API adapter (included)

This repo now includes a ready-to-wire Mowen OpenAPI adapter script:

- `extensions/my-ops/bin/mowen-api-adapter.js`

It is designed to sit behind `ops_mowen`, so the LLM uses stable, explicit actions while the adapter
handles Mowen auth, rate limiting, payload shaping, and error normalization.

Supported `ops_mowen` actions:

- `health` (local config check, no quota consumed)
- `create_doc` / `create_note` -> `POST /api/open/api/v1/note/create`
- `update_doc` / `edit_note` -> `POST /api/open/api/v1/note/edit`
- `set_doc` / `set_note` -> `POST /api/open/api/v1/note/set`
- `upload_prepare` -> `POST /api/open/api/v1/upload/prepare`
- `upload_url` -> `POST /api/open/api/v1/upload/url`

Notes:

- The current Mowen OpenAPI docs do not expose `read_doc/search/list_spaces`, so those are not exposed in `ops_mowen`.
- `append_doc` is intentionally not implemented because the API docs do not provide a safe read+merge flow in the same adapter contract.
- The adapter enforces a small local pacing gap by default (`1100ms`) to stay under the documented `1 req/sec` limit.

### Mowen adapter config example

```json5
{
  plugins: {
    entries: {
      "my-ops": {
        enabled: true,
        config: {
          adapters: {
            mowen: {
              command: "node",
              args: ["/Users/owen/go/src/openclaw/extensions/my-ops/bin/mowen-api-adapter.js"],
              timeoutMs: 30000,
              env: {
                MYOPS_MOWEN_API_KEY: "<YOUR_MOWEN_API_KEY>",
                MYOPS_MOWEN_BASE_URL: "https://open.mowen.cn",
                MYOPS_MOWEN_MIN_INTERVAL_MS: "1100",
                MYOPS_MOWEN_STATE_DIR: "/Users/owen/.openclaw/my-ops/mowen",
              },
            },
          },
        },
      },
    },
  },
}
```

### `ops_mowen` payload examples

Health (local-only):

```json
{ "action": "health" }
```

Create a note from plain text (adapter builds `NoteAtom`):

```json
{
  "action": "create_doc",
  "payload": {
    "text": "今天要做的事\\n1. 清理邮件\\n2. 安排日程",
    "autoPublish": true,
    "tags": ["日报", "自动化"]
  }
}
```

Edit a note with explicit `NoteAtom` body:

```json
{
  "action": "update_doc",
  "payload": {
    "noteId": "mw_note_xxx",
    "body": {
      "type": "doc",
      "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "更新后的正文" }] }]
    }
  }
}
```

Set note privacy (maps to `note/set`, `section=1` by default):

```json
{
  "action": "set_doc",
  "payload": {
    "noteId": "mw_note_xxx",
    "privacy": {
      "type": "private"
    }
  }
}
```

Upload file by URL:

```json
{
  "action": "upload_url",
  "payload": {
    "fileKind": "image",
    "url": "https://example.com/image.png",
    "fileName": "image.png"
  }
}
```

## Recommended workflow pattern

- Use `ops_*` tools for stable reads/writes to your systems
- Use `cron`/`heartbeat` for scheduling
- Use `lobster` for multi-step pipelines with approval gates
- Keep skills as documentation/policy, not the execution engine

### Lobster approval pattern for `ops_mail` (template)

The exact `openclaw.invoke` flags may evolve, but the stable pattern is:

1. `ops_mail draft_reply` (read-only)
2. `approve` gate with preview
3. `ops_mail send_message` (side effect)

Example Lobster pipeline string (adapt before production use):

```lobster
openclaw.invoke --tool ops_mail --action json --args-json '{
  "action":"draft_reply",
  "idempotencyKey":"draft-42",
  "payload":{"id":42,"folder":"INBOX","body":"Thanks for the update.\\n\\n"}
}' \
| approve --preview-from-stdin --limit 1 --prompt 'Send this reply template?' \
| openclaw.invoke --tool ops_mail --action json --args-json '{
  "action":"send_message",
  "idempotencyKey":"send-42-2026-02-22",
  "payload":{"format":"mml","template":"<PASTE_APPROVED_TEMPLATE_HERE>"}
}'
```

Operational rule:

- Put the final `send_message` step behind approval.
- Always include `idempotencyKey` on send actions.
- For recurring automations, derive the key from a stable tuple (`account + message-id + intent`).

Template file included:

- `extensions/my-ops/workflows/mail-reply-approval.template.lobster.yaml`

## Next steps for this plugin

- Add per-domain schema validation (`payload` shapes by action)
- Add idempotency storage in `stateDir`
- Add mailbox/calendar cursor polling in the plugin service
- Add webhooks for push-driven events (mail/calendar)
