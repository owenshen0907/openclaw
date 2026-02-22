#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readBoolean(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function readPositiveInt(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const n = Math.floor(value);
    if (n > 0) {
      return n;
    }
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

function readStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeIdList(value, fallbackId) {
  const ids = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "number" && Number.isFinite(entry)) {
        ids.push(String(Math.trunc(entry)));
      } else if (typeof entry === "string" && entry.trim()) {
        ids.push(entry.trim());
      }
    }
  } else if (typeof value === "number" && Number.isFinite(value)) {
    ids.push(String(Math.trunc(value)));
  } else if (typeof value === "string" && value.trim()) {
    ids.push(value.trim());
  }
  if (ids.length === 0 && fallbackId !== undefined && fallbackId !== null) {
    if (typeof fallbackId === "number" && Number.isFinite(fallbackId)) {
      ids.push(String(Math.trunc(fallbackId)));
    } else if (typeof fallbackId === "string" && fallbackId.trim()) {
      ids.push(fallbackId.trim());
    }
  }
  return ids;
}

function headersToArgs(headers) {
  if (!headers) {
    return [];
  }
  if (Array.isArray(headers)) {
    return headers.filter((entry) => typeof entry === "string").flatMap((entry) => ["-H", entry]);
  }
  if (isRecord(headers)) {
    return Object.entries(headers)
      .filter(([key, value]) => typeof key === "string" && typeof value === "string")
      .flatMap(([key, value]) => ["-H", `${key}:${value}`]);
  }
  return [];
}

function queryArgs(payload) {
  if (!isRecord(payload)) {
    return [];
  }
  const tokens = readStringArray(payload.queryTokens);
  if (tokens.length > 0) {
    return tokens;
  }
  const query = readString(payload.query);
  return query ? [query] : [];
}

async function readJsonStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    throw new Error("empty stdin; expected JSON envelope");
  }
  return JSON.parse(text);
}

function writeJson(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

function defaultConfigPath() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "himalaya", "config.toml");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "himalaya", "config.toml");
  }
  return path.join(os.homedir(), ".config", "himalaya", "config.toml");
}

function resolveAdapterSettings(envelope) {
  const payload = isRecord(envelope?.payload) ? envelope.payload : {};
  const envConfigPath = readString(process.env.MYOPS_HIMALAYA_CONFIG);
  const envAccount = readString(process.env.MYOPS_HIMALAYA_ACCOUNT);
  const envFolder = readString(process.env.MYOPS_HIMALAYA_FOLDER);
  const envBinary = readString(process.env.MYOPS_HIMALAYA_BIN);
  const envTimeoutMs = readPositiveInt(process.env.MYOPS_HIMALAYA_TIMEOUT_MS, 30_000);
  const envStateDir = readString(process.env.MYOPS_HIMALAYA_STATE_DIR);

  return {
    binary: envBinary ?? "himalaya",
    configPath: readString(payload.configPath) ?? envConfigPath,
    account: readString(payload.account) ?? envAccount,
    folder: readString(payload.folder) ?? envFolder ?? "INBOX",
    timeoutMs: readPositiveInt(payload.timeoutMs, envTimeoutMs),
    stateDir: readString(payload.stateDir) ?? envStateDir,
    payload,
  };
}

function buildGlobalArgs(settings, opts = {}) {
  const jsonOutput = opts.jsonOutput !== false;
  const argv = [];
  if (jsonOutput) {
    argv.push("-o", "json");
  }
  if (settings.configPath) {
    argv.push("-c", settings.configPath);
  }
  if (readBoolean(opts.quiet, true)) {
    argv.push("--quiet");
  }
  return argv;
}

function withAccountArg(subcommandArgs, account) {
  if (!account) {
    return [...subcommandArgs];
  }
  const args = [...subcommandArgs];
  const insertAt = args.length >= 2 ? 2 : args.length;
  args.splice(insertAt, 0, "-a", account);
  return args;
}

async function runCommand(argv, options = {}) {
  const timeoutMs = readPositiveInt(options.timeoutMs, 30_000);
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const hasInput = typeof options.input === "string";
    const child = spawn(argv[0], argv.slice(1), {
      stdio: [hasInput ? "pipe" : "ignore", "pipe", "pipe"],
      env: options.env ? { ...process.env, ...options.env } : process.env,
      cwd: options.cwd,
    });
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    if (hasInput && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        killed: child.killed,
        stdout,
        stderr,
        timeoutMs,
      });
    });
  });
}

async function runHimalaya(settings, subcommandArgs, opts = {}) {
  const includeAccount = opts.includeAccount !== false;
  const argv = [
    settings.binary,
    ...buildGlobalArgs(settings, opts),
    ...(includeAccount ? withAccountArg(subcommandArgs, settings.account) : [...subcommandArgs]),
  ];
  const startedAt = Date.now();
  const result = await runCommand(argv, {
    timeoutMs: opts.timeoutMs ?? settings.timeoutMs,
    input: typeof opts.input === "string" ? opts.input : undefined,
  });
  let stdoutJson;
  let stdoutJsonError;
  const trimmed = result.stdout.trim();
  if (trimmed && opts.jsonOutput !== false) {
    try {
      stdoutJson = JSON.parse(trimmed);
    } catch (err) {
      stdoutJsonError = String(err);
    }
  }
  return {
    ok: result.code === 0,
    argv,
    exec: {
      code: result.code,
      signal: result.signal,
      killed: result.killed,
      timeoutMs: result.timeoutMs,
      durationMs: Date.now() - startedAt,
    },
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutJson,
    stdoutJsonError,
  };
}

async function fileExists(filePath) {
  if (!filePath) {
    return false;
  }
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function defaultStateDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "openclaw", "my-ops");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "openclaw", "my-ops");
  }
  return path.join(os.homedir(), ".local", "state", "openclaw", "my-ops");
}

function resolveIdempotencyStorePath(settings) {
  const root = settings.stateDir ?? defaultStateDir();
  return path.join(root, "himalaya-mail-idempotency.json");
}

async function readIdempotencyStore(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.keys)) {
      return { version: 1, keys: {} };
    }
    return {
      version: parsed.version === 1 ? 1 : 1,
      keys: parsed.keys,
    };
  } catch {
    return { version: 1, keys: {} };
  }
}

async function writeIdempotencyStore(filePath, store) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function buildIdempotencyEntryKey({ account, mode, idempotencyKey }) {
  return `${account || "default"}::${mode}::${idempotencyKey}`;
}

function envelopeOkResponse(base, payload) {
  return {
    ok: true,
    domain: "mail",
    action: base.action,
    adapter: "himalaya",
    ...payload,
  };
}

function envelopeErrorResponse(base, payload) {
  return {
    ok: false,
    domain: "mail",
    action: base.action,
    adapter: "himalaya",
    ...payload,
  };
}

async function handleHealth(base) {
  const settings = resolveAdapterSettings(base.envelope);
  const cfgPath = settings.configPath ?? defaultConfigPath();
  let versionResult;
  try {
    versionResult = await runCommand([settings.binary, "--version"], {
      timeoutMs: settings.timeoutMs,
    });
  } catch (err) {
    return {
      exitCode: 3,
      body: envelopeErrorResponse(base, {
        error: `failed to execute himalaya: ${String(err)}`,
        settings: {
          binary: settings.binary,
          configPath: settings.configPath ?? null,
          account: settings.account ?? null,
          folder: settings.folder,
          timeoutMs: settings.timeoutMs,
        },
      }),
    };
  }

  const deep = readBoolean(settings.payload.deep, false);
  let deepProbe;
  if (deep && (settings.account || settings.configPath)) {
    deepProbe = await runHimalaya(
      settings,
      ["envelope", "list", "-f", settings.folder, "-s", "1"],
      { timeoutMs: settings.timeoutMs },
    );
  }

  return {
    exitCode: versionResult.code === 0 ? 0 : 3,
    body: envelopeOkResponse(base, {
      settings: {
        binary: settings.binary,
        configPath: settings.configPath ?? null,
        account: settings.account ?? null,
        folder: settings.folder,
        timeoutMs: settings.timeoutMs,
      },
      checks: {
        binaryVersion: versionResult.stdout.trim() || null,
        binaryOk: versionResult.code === 0,
        configPathChecked: cfgPath,
        configPathExists: await fileExists(cfgPath),
      },
      probe: deep
        ? {
            requested: true,
            ok: Boolean(deepProbe?.ok),
            result: deepProbe
              ? {
                  exec: deepProbe.exec,
                  stdoutJson: deepProbe.stdoutJson,
                  stdoutJsonError: deepProbe.stdoutJsonError,
                  stderr: deepProbe.stderr || undefined,
                }
              : undefined,
          }
        : { requested: false },
    }),
  };
}

async function handleListAccounts(base) {
  const settings = resolveAdapterSettings(base.envelope);
  const result = await runHimalaya(settings, ["account", "list"], {
    includeAccount: false,
  });
  return {
    exitCode: result.ok ? 0 : 3,
    body: (result.ok ? envelopeOkResponse : envelopeErrorResponse)(base, {
      result: {
        exec: result.exec,
        stdoutJson: result.stdoutJson,
        stdoutJsonError: result.stdoutJsonError,
        stderr: result.stderr || undefined,
        stdoutRaw: result.stdoutJson === undefined ? result.stdout : undefined,
      },
    }),
  };
}

async function handleListFolders(base) {
  const settings = resolveAdapterSettings(base.envelope);
  const result = await runHimalaya(settings, ["folder", "list"]);
  return {
    exitCode: result.ok ? 0 : 3,
    body: (result.ok ? envelopeOkResponse : envelopeErrorResponse)(base, {
      result: {
        exec: result.exec,
        stdoutJson: result.stdoutJson,
        stdoutJsonError: result.stdoutJsonError,
        stderr: result.stderr || undefined,
        stdoutRaw: result.stdoutJson === undefined ? result.stdout : undefined,
      },
    }),
  };
}

async function handleListMessages(base) {
  const settings = resolveAdapterSettings(base.envelope);
  const page = readPositiveInt(settings.payload.page, 1);
  const pageSize = readPositiveInt(settings.payload.pageSize, 50);
  const folder = readString(settings.payload.folder) ?? settings.folder;
  const query = queryArgs(settings.payload);
  const args = [
    "envelope",
    "list",
    "-f",
    folder,
    "-p",
    String(page),
    "-s",
    String(pageSize),
    ...query,
  ];
  const result = await runHimalaya(settings, args);
  return {
    exitCode: result.ok ? 0 : 3,
    body: (result.ok ? envelopeOkResponse : envelopeErrorResponse)(base, {
      request: { folder, page, pageSize, query },
      result: {
        exec: result.exec,
        stdoutJson: result.stdoutJson,
        stdoutJsonError: result.stdoutJsonError,
        stderr: result.stderr || undefined,
        stdoutRaw: result.stdoutJson === undefined ? result.stdout : undefined,
      },
    }),
  };
}

async function handleSearch(base) {
  return await handleListMessages(base);
}

async function handleGetMessage(base) {
  const settings = resolveAdapterSettings(base.envelope);
  const ids = normalizeIdList(settings.payload.ids, settings.payload.id);
  if (ids.length === 0) {
    return {
      exitCode: 2,
      body: envelopeErrorResponse(base, { error: "payload.id or payload.ids required" }),
    };
  }
  const folder = readString(settings.payload.folder) ?? settings.folder;
  const args = ["message", "read", "-f", folder];
  if (readBoolean(settings.payload.preview, false)) {
    args.push("-p");
  }
  if (readBoolean(settings.payload.noHeaders, false)) {
    args.push("--no-headers");
  }
  args.push(...headersToArgs(settings.payload.headers));
  args.push(...ids);

  const result = await runHimalaya(settings, args);
  return {
    exitCode: result.ok ? 0 : 3,
    body: (result.ok ? envelopeOkResponse : envelopeErrorResponse)(base, {
      request: { folder, ids },
      result: {
        exec: result.exec,
        stdoutJson: result.stdoutJson,
        stdoutJsonError: result.stdoutJsonError,
        stderr: result.stderr || undefined,
        stdoutRaw: result.stdoutJson === undefined ? result.stdout : undefined,
      },
    }),
  };
}

async function handleDraftReply(base) {
  const settings = resolveAdapterSettings(base.envelope);
  const id = readString(settings.payload.id);
  if (!id) {
    return {
      exitCode: 2,
      body: envelopeErrorResponse(base, { error: "payload.id required" }),
    };
  }
  const folder = readString(settings.payload.folder) ?? settings.folder;
  const body = readString(settings.payload.body);
  const args = ["template", "reply", "-f", folder];
  if (readBoolean(settings.payload.allRecipients, false)) {
    args.push("-A");
  }
  args.push(...headersToArgs(settings.payload.headers));
  args.push(id);
  if (body) {
    args.push(body);
  }

  const result = await runHimalaya(settings, args);
  return {
    exitCode: result.ok ? 0 : 3,
    body: (result.ok ? envelopeOkResponse : envelopeErrorResponse)(base, {
      request: { id, folder },
      result: {
        exec: result.exec,
        stdoutJson: result.stdoutJson,
        stdoutJsonError: result.stdoutJsonError,
        stderr: result.stderr || undefined,
        stdoutRaw: result.stdoutJson === undefined ? result.stdout : undefined,
      },
    }),
  };
}

async function handleSendMessage(base) {
  const settings = resolveAdapterSettings(base.envelope);
  const rawMessage =
    readString(settings.payload.rawMessage) ??
    readString(settings.payload.message) ??
    readString(settings.payload.raw);
  const template = readString(settings.payload.template);
  if (!rawMessage && !template) {
    return {
      exitCode: 2,
      body: envelopeErrorResponse(base, {
        error: "payload.rawMessage (or payload.message/raw) or payload.template required",
      }),
    };
  }

  const useTemplate = Boolean(template) || readString(settings.payload.format) === "mml";
  const content = template ?? rawMessage;
  const contentHash = sha256Hex(content ?? "");
  const idempotencyKey =
    readString(base.envelope.idempotencyKey) ??
    readString(settings.payload.idempotencyKey) ??
    undefined;
  const idempotencyRequired = readBoolean(settings.payload.requireIdempotencyKey, false);
  if (idempotencyRequired && !idempotencyKey) {
    return {
      exitCode: 2,
      body: envelopeErrorResponse(base, {
        error: "idempotencyKey required (payload.requireIdempotencyKey=true)",
      }),
    };
  }

  let idempotencyMeta;
  if (idempotencyKey) {
    const storePath = resolveIdempotencyStorePath(settings);
    const store = await readIdempotencyStore(storePath);
    const entryKey = buildIdempotencyEntryKey({
      account: settings.account,
      mode: useTemplate ? "template" : "raw-message",
      idempotencyKey,
    });
    const existing = isRecord(store.keys[entryKey]) ? store.keys[entryKey] : undefined;
    if (existing) {
      const existingHash = readString(existing.contentHash);
      if (existingHash && existingHash !== contentHash) {
        return {
          exitCode: 2,
          body: envelopeErrorResponse(base, {
            error: "idempotency key reuse with different payload content",
            idempotency: {
              key: idempotencyKey,
              storePath,
              conflict: true,
              existingContentHash: existingHash,
              contentHash,
            },
          }),
        };
      }
      return {
        exitCode: 0,
        body: envelopeOkResponse(base, {
          request: {
            mode: useTemplate ? "template" : "raw-message",
            bytes: Buffer.byteLength(content ?? "", "utf8"),
          },
          idempotency: {
            key: idempotencyKey,
            storePath,
            duplicate: true,
            skippedSend: true,
            entryKey,
            existing,
          },
          result: {
            exec: {
              code: 0,
              signal: null,
              killed: false,
              timeoutMs: settings.timeoutMs,
              durationMs: 0,
            },
          },
        }),
      };
    }
    idempotencyMeta = { storePath, store, entryKey };
  }

  const args = useTemplate ? ["template", "send"] : ["message", "send"];
  const result = await runHimalaya(settings, args, { input: content ?? "" });

  if (result.ok && idempotencyKey && idempotencyMeta) {
    idempotencyMeta.store.keys[idempotencyMeta.entryKey] = {
      ts: new Date().toISOString(),
      idempotencyKey,
      account: settings.account ?? null,
      mode: useTemplate ? "template" : "raw-message",
      contentHash,
      bytes: Buffer.byteLength(content ?? "", "utf8"),
      exec: result.exec,
      stdoutJson: result.stdoutJson ?? null,
    };
    await writeIdempotencyStore(idempotencyMeta.storePath, idempotencyMeta.store);
  }

  return {
    exitCode: result.ok ? 0 : 3,
    body: (result.ok ? envelopeOkResponse : envelopeErrorResponse)(base, {
      request: {
        mode: useTemplate ? "template" : "raw-message",
        bytes: Buffer.byteLength(content ?? "", "utf8"),
      },
      idempotency: idempotencyKey
        ? {
            key: idempotencyKey,
            duplicate: false,
            storePath: idempotencyMeta?.storePath,
            contentHash,
          }
        : undefined,
      result: {
        exec: result.exec,
        stdoutJson: result.stdoutJson,
        stdoutJsonError: result.stdoutJsonError,
        stderr: result.stderr || undefined,
        stdoutRaw: result.stdoutJson === undefined ? result.stdout : undefined,
      },
    }),
  };
}

async function handleArchive(base) {
  const settings = resolveAdapterSettings(base.envelope);
  const ids = normalizeIdList(settings.payload.ids, settings.payload.id);
  if (ids.length === 0) {
    return {
      exitCode: 2,
      body: envelopeErrorResponse(base, { error: "payload.id or payload.ids required" }),
    };
  }
  const sourceFolder = readString(settings.payload.folder) ?? settings.folder;
  const targetFolder = readString(settings.payload.archiveFolder) ?? "Archive";
  const args = ["message", "move", "-f", sourceFolder, targetFolder, ...ids];
  const result = await runHimalaya(settings, args);
  return {
    exitCode: result.ok ? 0 : 3,
    body: (result.ok ? envelopeOkResponse : envelopeErrorResponse)(base, {
      request: { sourceFolder, targetFolder, ids },
      result: {
        exec: result.exec,
        stdoutJson: result.stdoutJson,
        stdoutJsonError: result.stdoutJsonError,
        stderr: result.stderr || undefined,
        stdoutRaw: result.stdoutJson === undefined ? result.stdout : undefined,
      },
    }),
  };
}

async function handleDeleteMessages(base) {
  const settings = resolveAdapterSettings(base.envelope);
  const ids = normalizeIdList(settings.payload.ids, settings.payload.id);
  if (ids.length === 0) {
    return {
      exitCode: 2,
      body: envelopeErrorResponse(base, { error: "payload.id or payload.ids required" }),
    };
  }
  const folder = readString(settings.payload.folder) ?? settings.folder;
  const args = ["message", "delete", "-f", folder, ...ids];
  const result = await runHimalaya(settings, args);
  return {
    exitCode: result.ok ? 0 : 3,
    body: (result.ok ? envelopeOkResponse : envelopeErrorResponse)(base, {
      request: { folder, ids },
      result: {
        exec: result.exec,
        stdoutJson: result.stdoutJson,
        stdoutJsonError: result.stdoutJsonError,
        stderr: result.stderr || undefined,
        stdoutRaw: result.stdoutJson === undefined ? result.stdout : undefined,
      },
    }),
  };
}

async function handlePurgeFolder(base) {
  const settings = resolveAdapterSettings(base.envelope);
  const folder = readString(settings.payload.folder) ?? readString(settings.payload.name);
  if (!folder) {
    return {
      exitCode: 2,
      body: envelopeErrorResponse(base, { error: "payload.folder (or payload.name) required" }),
    };
  }
  const result = await runHimalaya(settings, ["folder", "purge", "-y", folder]);
  return {
    exitCode: result.ok ? 0 : 3,
    body: (result.ok ? envelopeOkResponse : envelopeErrorResponse)(base, {
      request: { folder },
      result: {
        exec: result.exec,
        stdoutJson: result.stdoutJson,
        stdoutJsonError: result.stdoutJsonError,
        stderr: result.stderr || undefined,
        stdoutRaw: result.stdoutJson === undefined ? result.stdout : undefined,
      },
    }),
  };
}

async function handleMarkRead(base) {
  const settings = resolveAdapterSettings(base.envelope);
  const ids = normalizeIdList(settings.payload.ids, settings.payload.id);
  if (ids.length === 0) {
    return {
      exitCode: 2,
      body: envelopeErrorResponse(base, { error: "payload.id or payload.ids required" }),
    };
  }
  const folder = readString(settings.payload.folder) ?? settings.folder;
  const markRead = readBoolean(settings.payload.read, true);
  const flags = markRead ? ["seen"] : ["seen"];
  const command = markRead ? "add" : "remove";
  const args = ["flag", command, "-f", folder, ...flags, ...ids];
  const result = await runHimalaya(settings, args);
  return {
    exitCode: result.ok ? 0 : 3,
    body: (result.ok ? envelopeOkResponse : envelopeErrorResponse)(base, {
      request: { folder, ids, read: markRead },
      result: {
        exec: result.exec,
        stdoutJson: result.stdoutJson,
        stdoutJsonError: result.stdoutJsonError,
        stderr: result.stderr || undefined,
        stdoutRaw: result.stdoutJson === undefined ? result.stdout : undefined,
      },
    }),
  };
}

async function handleLabel(base) {
  const settings = resolveAdapterSettings(base.envelope);
  const ids = normalizeIdList(settings.payload.ids, settings.payload.id);
  if (ids.length === 0) {
    return {
      exitCode: 2,
      body: envelopeErrorResponse(base, { error: "payload.id or payload.ids required" }),
    };
  }
  const folder = readString(settings.payload.folder) ?? settings.folder;
  const mode = readString(settings.payload.mode) ?? "add";
  if (!["add", "remove", "set"].includes(mode)) {
    return {
      exitCode: 2,
      body: envelopeErrorResponse(base, {
        error: "payload.mode must be one of add/remove/set",
      }),
    };
  }
  const flags = readStringArray(settings.payload.flags);
  if (flags.length === 0) {
    return {
      exitCode: 2,
      body: envelopeErrorResponse(base, { error: "payload.flags required (string[])" }),
    };
  }
  const args = ["flag", mode, "-f", folder, ...flags, ...ids];
  const result = await runHimalaya(settings, args);
  return {
    exitCode: result.ok ? 0 : 3,
    body: (result.ok ? envelopeOkResponse : envelopeErrorResponse)(base, {
      request: { folder, ids, mode, flags },
      result: {
        exec: result.exec,
        stdoutJson: result.stdoutJson,
        stdoutJsonError: result.stdoutJsonError,
        stderr: result.stderr || undefined,
        stdoutRaw: result.stdoutJson === undefined ? result.stdout : undefined,
      },
    }),
  };
}

async function dispatch(base) {
  switch (base.action) {
    case "health":
      return await handleHealth(base);
    case "list_accounts":
      return await handleListAccounts(base);
    case "list_folders":
      return await handleListFolders(base);
    case "list_messages":
      return await handleListMessages(base);
    case "search":
      return await handleSearch(base);
    case "get_message":
      return await handleGetMessage(base);
    case "draft_reply":
      return await handleDraftReply(base);
    case "send_message":
      return await handleSendMessage(base);
    case "archive":
      return await handleArchive(base);
    case "delete_messages":
      return await handleDeleteMessages(base);
    case "purge_folder":
      return await handlePurgeFolder(base);
    case "mark_read":
      return await handleMarkRead(base);
    case "label":
      return await handleLabel(base);
    default:
      return {
        exitCode: 2,
        body: envelopeErrorResponse(base, {
          error: `unsupported action '${base.action}'`,
          supportedActions: [
            "health",
            "list_accounts",
            "list_folders",
            "list_messages",
            "search",
            "get_message",
            "draft_reply",
            "send_message",
            "archive",
            "delete_messages",
            "purge_folder",
            "mark_read",
            "label",
          ],
        }),
      };
  }
}

async function main() {
  const envelope = await readJsonStdin();
  if (!isRecord(envelope)) {
    writeJson({
      ok: false,
      domain: "mail",
      adapter: "himalaya",
      error: "expected JSON object envelope",
    });
    process.exit(2);
    return;
  }
  const action = readString(envelope.action);
  if (!action) {
    writeJson({
      ok: false,
      domain: "mail",
      adapter: "himalaya",
      error: "envelope.action required",
    });
    process.exit(2);
    return;
  }

  const base = { envelope, action };
  const res = await dispatch(base);
  writeJson(res.body);
  process.exit(res.exitCode);
}

main().catch((err) => {
  writeJson({
    ok: false,
    domain: "mail",
    adapter: "himalaya",
    error: `adapter crash: ${String(err)}`,
  });
  process.exit(99);
});
