#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const ADAPTER_NAME = "mowen-openapi";
const DEFAULT_BASE_URL = "https://open.mowen.cn";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MIN_INTERVAL_MS = 1_100;

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
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function pick(obj, keys) {
  if (!isRecord(obj)) {
    return undefined;
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      return obj[key];
    }
  }
  return undefined;
}

function readStringFromKeys(obj, keys) {
  return readString(pick(obj, keys));
}

function readIntFromKeys(obj, keys, fallback) {
  return readPositiveInt(pick(obj, keys), fallback);
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

function writeAndExit(payload, code = 0) {
  writeJson(payload);
  process.exit(code);
}

function defaultStateDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "my-ops", "mowen");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "my-ops", "mowen");
  }
  return path.join(os.homedir(), ".local", "state", "my-ops", "mowen");
}

function normalizeBaseUrl(value) {
  const raw = readString(value) ?? DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

function normalizeAction(action) {
  switch (action) {
    case "create_doc":
      return "create_note";
    case "update_doc":
      return "edit_note";
    case "set_doc":
      return "set_note";
    default:
      return action;
  }
}

function unsupportedActionMessage(action) {
  if (action === "append_doc") {
    return "append_doc is not supported by Mowen OpenAPI directly (no read/merge helper in adapter). Use edit_note/update_doc with an explicit NoteAtom body.";
  }
  if (action === "read_doc" || action === "search" || action === "list_spaces") {
    return `${action} is not available in the current Mowen OpenAPI docs. Supported actions: create/edit/set note and upload APIs.`;
  }
  return `unsupported action: ${action}`;
}

function resolveSettings(envelope) {
  const payload = isRecord(envelope?.payload) ? envelope.payload : {};

  const envApiKey = readString(process.env.MYOPS_MOWEN_API_KEY);
  const envBaseUrl = readString(process.env.MYOPS_MOWEN_BASE_URL);
  const envTimeoutMs = readPositiveInt(process.env.MYOPS_MOWEN_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const envMinIntervalMs = readPositiveInt(
    process.env.MYOPS_MOWEN_MIN_INTERVAL_MS,
    DEFAULT_MIN_INTERVAL_MS,
  );
  const envStateDir = readString(process.env.MYOPS_MOWEN_STATE_DIR);
  const envUserAgent = readString(process.env.MYOPS_MOWEN_USER_AGENT);

  return {
    apiKey: readStringFromKeys(payload, ["apiKey", "api_key"]) ?? envApiKey,
    baseUrl: normalizeBaseUrl(readStringFromKeys(payload, ["baseUrl", "base_url"]) ?? envBaseUrl),
    timeoutMs: readIntFromKeys(payload, ["timeoutMs", "timeout_ms"], envTimeoutMs),
    minIntervalMs: readIntFromKeys(payload, ["minIntervalMs", "min_interval_ms"], envMinIntervalMs),
    stateDir:
      readStringFromKeys(payload, ["stateDir", "state_dir"]) ?? envStateDir ?? defaultStateDir(),
    userAgent: envUserAgent ?? "my-ops-mowen-adapter/1",
    payload,
  };
}

function sanitizeForHealth(settings) {
  return {
    ok: Boolean(settings.apiKey),
    domain: "mowen",
    action: "health",
    adapter: ADAPTER_NAME,
    configured: {
      apiKey: Boolean(settings.apiKey),
      baseUrl: Boolean(settings.baseUrl),
    },
    baseUrl: settings.baseUrl,
    timeoutMs: settings.timeoutMs,
    rateLimit: {
      minIntervalMs: settings.minIntervalMs,
      stateDir: settings.stateDir,
    },
    note: settings.apiKey
      ? "Mowen adapter is configured. Health is local-only to avoid consuming API quotas."
      : "Set MYOPS_MOWEN_API_KEY (or payload.apiKey) to enable Mowen API calls.",
  };
}

function toNoteAtomTextNode(text) {
  return {
    type: "text",
    text,
  };
}

function toNoteAtomParagraphNode(text) {
  const clean = typeof text === "string" ? text : "";
  if (!clean) {
    return { type: "paragraph" };
  }
  return {
    type: "paragraph",
    content: [toNoteAtomTextNode(clean)],
  };
}

function buildNoteAtomFromText(text) {
  const source = typeof text === "string" ? text : "";
  const lines = source.split(/\r?\n/);
  return {
    type: "doc",
    content: lines.map((line) => toNoteAtomParagraphNode(line)),
  };
}

function buildNoteAtomFromParagraphs(paragraphs) {
  if (!Array.isArray(paragraphs)) {
    return undefined;
  }
  return {
    type: "doc",
    content: paragraphs.map((entry) => {
      if (typeof entry === "string") {
        return toNoteAtomParagraphNode(entry);
      }
      if (isRecord(entry)) {
        return entry;
      }
      return toNoteAtomParagraphNode(String(entry ?? ""));
    }),
  };
}

function readNoteAtomBody(payload) {
  const directBody = pick(payload, ["body"]);
  if (isRecord(directBody)) {
    return directBody;
  }
  const noteAtom = pick(payload, ["noteAtom", "note_atom"]);
  if (isRecord(noteAtom)) {
    return noteAtom;
  }

  const paragraphs = pick(payload, ["paragraphs"]);
  const fromParagraphs = buildNoteAtomFromParagraphs(paragraphs);
  if (fromParagraphs) {
    return fromParagraphs;
  }

  const text =
    readStringFromKeys(payload, ["text", "bodyText", "body_text", "contentText", "content_text"]) ??
    undefined;
  if (typeof text === "string") {
    return buildNoteAtomFromText(text);
  }
  return undefined;
}

function normalizeTags(value) {
  const tags = readStringArray(value);
  if (tags.length === 0) {
    return undefined;
  }
  return tags.slice(0, 10).map((tag) => tag.slice(0, 30));
}

function buildCreateNoteRequest(payload) {
  const raw = pick(payload, ["request"]);
  if (isRecord(raw)) {
    return raw;
  }

  const body = readNoteAtomBody(payload);
  if (!body) {
    throw new Error(
      "create_note requires payload.body (NoteAtom) or payload.text / payload.paragraphs",
    );
  }

  let settings = isRecord(pick(payload, ["settings"])) ? pick(payload, ["settings"]) : undefined;
  if (!settings) {
    const autoPublish = pick(payload, ["autoPublish", "auto_publish"]);
    const tags = normalizeTags(pick(payload, ["tags"]));
    if (typeof autoPublish === "boolean" || tags) {
      settings = {};
      if (typeof autoPublish === "boolean") {
        settings.autoPublish = autoPublish;
      }
      if (tags) {
        settings.tags = tags;
      }
    }
  }

  return {
    body,
    ...(settings ? { settings } : {}),
  };
}

function readNoteId(payload, fallbackKeys = ["noteId", "note_id", "id"]) {
  const noteId = readStringFromKeys(payload, fallbackKeys);
  if (!noteId) {
    throw new Error("payload.noteId is required");
  }
  return noteId;
}

function extractNoteIdFromResponseJson(value) {
  if (!isRecord(value)) {
    return undefined;
  }
  const direct = readStringFromKeys(value, ["noteId", "note_id", "id"]);
  if (direct) {
    return direct;
  }
  const nestedKeys = ["data", "result", "note"];
  for (const key of nestedKeys) {
    const nested = value[key];
    if (isRecord(nested)) {
      const nestedId = readStringFromKeys(nested, ["noteId", "note_id", "id"]);
      if (nestedId) {
        return nestedId;
      }
      if (isRecord(nested.note)) {
        const deepId = readStringFromKeys(nested.note, ["noteId", "note_id", "id"]);
        if (deepId) {
          return deepId;
        }
      }
    }
  }
  return undefined;
}

function buildEditNoteRequest(payload) {
  const raw = pick(payload, ["request"]);
  if (isRecord(raw)) {
    return raw;
  }
  const noteId = readNoteId(payload);
  const body = readNoteAtomBody(payload);
  if (!body) {
    throw new Error(
      "edit_note requires payload.body (NoteAtom) or payload.text / payload.paragraphs",
    );
  }
  return { noteId, body };
}

function normalizeFileType(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const n = Math.floor(value);
    if (n >= 1 && n <= 3) {
      return n;
    }
  }

  const raw = readString(value);
  if (!raw) {
    return undefined;
  }
  if (/^\d+$/.test(raw)) {
    const n = Number.parseInt(raw, 10);
    if (n >= 1 && n <= 3) {
      return n;
    }
  }
  switch (raw.toLowerCase()) {
    case "image":
    case "img":
    case "picture":
      return 1;
    case "audio":
      return 2;
    case "pdf":
      return 3;
    default:
      return undefined;
  }
}

function buildUploadPrepareRequest(payload) {
  const raw = pick(payload, ["request"]);
  if (isRecord(raw)) {
    return raw;
  }
  const fileType =
    normalizeFileType(pick(payload, ["fileType", "file_type"])) ??
    normalizeFileType(pick(payload, ["fileKind", "file_kind"]));
  if (!fileType) {
    throw new Error(
      "upload_prepare requires payload.fileType (1=image, 2=audio, 3=pdf) or payload.fileKind",
    );
  }
  const fileName = readStringFromKeys(payload, ["fileName", "file_name"]);
  return {
    fileType,
    ...(fileName ? { fileName } : {}),
  };
}

function buildUploadUrlRequest(payload) {
  const raw = pick(payload, ["request"]);
  if (isRecord(raw)) {
    return raw;
  }
  const fileType =
    normalizeFileType(pick(payload, ["fileType", "file_type"])) ??
    normalizeFileType(pick(payload, ["fileKind", "file_kind"]));
  if (!fileType) {
    throw new Error(
      "upload_url requires payload.fileType (1=image, 2=audio, 3=pdf) or payload.fileKind",
    );
  }
  const url = readStringFromKeys(payload, ["url"]);
  if (!url) {
    throw new Error("upload_url requires payload.url");
  }
  const fileName = readStringFromKeys(payload, ["fileName", "file_name"]);
  return {
    fileType,
    url,
    ...(fileName ? { fileName } : {}),
  };
}

function buildSetNoteRequest(payload) {
  const raw = pick(payload, ["request"]);
  if (isRecord(raw)) {
    return raw;
  }
  const noteId = readNoteId(payload);
  const section = readIntFromKeys(payload, ["section"], undefined);

  let settings = isRecord(pick(payload, ["settings"])) ? pick(payload, ["settings"]) : undefined;
  const privacy = pick(payload, ["privacy"]);
  if (!settings && isRecord(privacy)) {
    settings = { privacy };
  }
  if (!settings) {
    throw new Error("set_note requires payload.settings or payload.privacy");
  }

  return {
    noteId,
    section: section ?? 1,
    settings,
  };
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJsonFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function writeJsonFile(filePath, payload) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function applyRateLimit(settings, key) {
  const minIntervalMs = readPositiveInt(settings.minIntervalMs, DEFAULT_MIN_INTERVAL_MS);
  if (minIntervalMs <= 0) {
    return { key, minIntervalMs: 0, sleptMs: 0, stateDir: settings.stateDir };
  }

  const stateDir = settings.stateDir || defaultStateDir();
  const stateFile = path.join(stateDir, "rate-limit.json");
  const now = Date.now();
  const state = (await readJsonFile(stateFile)) ?? {};
  const lastByKey = isRecord(state.lastByKey) ? { ...state.lastByKey } : {};
  const lastTs =
    typeof lastByKey[key] === "number" && Number.isFinite(lastByKey[key]) ? lastByKey[key] : 0;
  const waitMs = Math.max(0, minIntervalMs - (now - lastTs));
  if (waitMs > 0) {
    await sleep(waitMs);
  }

  lastByKey[key] = Date.now();
  await writeJsonFile(stateFile, {
    updatedAt: new Date().toISOString(),
    lastByKey,
  });

  return {
    key,
    minIntervalMs,
    sleptMs: waitMs,
    stateDir,
  };
}

function summarizeRequest(action, body) {
  if (!isRecord(body)) {
    return { action };
  }
  const summary = { action };
  if (typeof body.noteId === "string") {
    summary.noteId = body.noteId;
  }
  if (typeof body.fileType === "number") {
    summary.fileType = body.fileType;
  }
  if (typeof body.url === "string") {
    summary.url = body.url;
  }
  if (typeof body.fileName === "string") {
    summary.fileName = body.fileName;
  }
  if (isRecord(body.body) && Array.isArray(body.body.content)) {
    summary.bodyBlocks = body.body.content.length;
  }
  if (isRecord(body.settings)) {
    summary.hasSettings = true;
  }
  return summary;
}

function pickResponseHeaders(headers) {
  const selected = {};
  for (const name of ["content-type", "x-request-id", "x-trace-id"]) {
    const value = headers.get(name);
    if (value) {
      selected[name] = value;
    }
  }
  return selected;
}

async function callMowenApi(settings, endpointPath, body) {
  const url = `${settings.baseUrl}${endpointPath}`;
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": settings.userAgent,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const errorName = isRecord(err) && typeof err.name === "string" ? err.name : undefined;
    const timeout = errorName === "TimeoutError" || String(err).includes("TimeoutError");
    const out = {
      ok: false,
      domain: "mowen",
      adapter: ADAPTER_NAME,
      api: {
        method: "POST",
        path: endpointPath,
        baseUrl: settings.baseUrl,
        durationMs,
        timeoutMs: settings.timeoutMs,
      },
      error: timeout ? "request timed out" : `request failed: ${String(err)}`,
    };
    writeAndExit(out, 2);
  }

  const durationMs = Date.now() - startedAt;
  const text = await response.text();
  let json;
  let jsonParseError;
  const trimmed = text.trim();
  if (trimmed) {
    try {
      json = JSON.parse(trimmed);
    } catch (err) {
      jsonParseError = String(err);
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: pickResponseHeaders(response.headers),
    durationMs,
    json,
    text,
    jsonParseError,
  };
}

function buildApiResult({
  originalAction,
  mappedAction,
  endpointPath,
  requestBody,
  response,
  rateLimit,
  settings,
}) {
  const noteId = extractNoteIdFromResponseJson(response.json);
  return {
    ok: response.ok,
    domain: "mowen",
    action: originalAction,
    mappedAction,
    adapter: ADAPTER_NAME,
    ...(noteId ? { noteId } : {}),
    api: {
      method: "POST",
      path: endpointPath,
      baseUrl: settings.baseUrl,
      status: response.status,
      statusText: response.statusText,
      durationMs: response.durationMs,
      timeoutMs: settings.timeoutMs,
      headers: response.headers,
    },
    rateLimit,
    request: {
      summary: summarizeRequest(mappedAction, requestBody),
    },
    response: {
      json: response.json,
      text: response.json === undefined ? response.text : undefined,
      jsonParseError: response.jsonParseError,
    },
  };
}

function resolveEndpointAndRequest(mappedAction, payload) {
  switch (mappedAction) {
    case "create_note":
      return {
        endpointPath: "/api/open/api/v1/note/create",
        requestBody: buildCreateNoteRequest(payload),
        rateLimitKey: "note.write",
      };
    case "edit_note":
      return {
        endpointPath: "/api/open/api/v1/note/edit",
        requestBody: buildEditNoteRequest(payload),
        rateLimitKey: "note.write",
      };
    case "set_note":
      return {
        endpointPath: "/api/open/api/v1/note/set",
        requestBody: buildSetNoteRequest(payload),
        rateLimitKey: "note.write",
      };
    case "upload_prepare":
      return {
        endpointPath: "/api/open/api/v1/upload/prepare",
        requestBody: buildUploadPrepareRequest(payload),
        rateLimitKey: "upload.write",
      };
    case "upload_url":
      return {
        endpointPath: "/api/open/api/v1/upload/url",
        requestBody: buildUploadUrlRequest(payload),
        rateLimitKey: "upload.write",
      };
    default:
      return undefined;
  }
}

async function main() {
  const envelope = await readJsonStdin();
  if (!isRecord(envelope)) {
    writeAndExit({ ok: false, error: "envelope must be an object" }, 2);
  }

  const action = readString(envelope.action);
  if (!action) {
    writeAndExit({ ok: false, error: "envelope.action is required" }, 2);
  }

  const domain = readString(envelope.domain);
  if (domain && domain !== "mowen") {
    writeAndExit({ ok: false, error: `unexpected domain '${domain}', expected 'mowen'` }, 2);
  }

  const settings = resolveSettings(envelope);
  const payload = settings.payload;
  const mappedAction = normalizeAction(action);

  if (mappedAction === "health") {
    writeAndExit(sanitizeForHealth(settings), 0);
  }

  if (
    mappedAction === "append_doc" ||
    mappedAction === "read_doc" ||
    mappedAction === "search" ||
    mappedAction === "list_spaces"
  ) {
    writeAndExit(
      {
        ok: false,
        domain: "mowen",
        action,
        mappedAction,
        adapter: ADAPTER_NAME,
        error: unsupportedActionMessage(mappedAction),
      },
      2,
    );
  }

  if (!settings.apiKey) {
    writeAndExit(
      {
        ok: false,
        domain: "mowen",
        action,
        mappedAction,
        adapter: ADAPTER_NAME,
        error: "Missing API key. Set MYOPS_MOWEN_API_KEY or payload.apiKey",
      },
      2,
    );
  }

  const resolved = resolveEndpointAndRequest(mappedAction, payload);
  if (!resolved) {
    writeAndExit(
      {
        ok: false,
        domain: "mowen",
        action,
        mappedAction,
        adapter: ADAPTER_NAME,
        error: unsupportedActionMessage(mappedAction),
      },
      2,
    );
  }

  let requestBody;
  try {
    requestBody = resolved.requestBody;
  } catch (err) {
    writeAndExit(
      {
        ok: false,
        domain: "mowen",
        action,
        mappedAction,
        adapter: ADAPTER_NAME,
        error: `invalid payload: ${String(err)}`,
      },
      2,
    );
  }

  const rateLimit = await applyRateLimit(settings, resolved.rateLimitKey);
  const response = await callMowenApi(settings, resolved.endpointPath, requestBody);
  const result = buildApiResult({
    originalAction: action,
    mappedAction,
    endpointPath: resolved.endpointPath,
    requestBody,
    response,
    rateLimit,
    settings,
  });

  if (!response.ok) {
    writeAndExit(result, 2);
  }
  writeAndExit(result, 0);
}

main().catch((err) => {
  writeAndExit(
    {
      ok: false,
      adapter: ADAPTER_NAME,
      domain: "mowen",
      error: `adapter crashed: ${String(err)}`,
    },
    2,
  );
});
