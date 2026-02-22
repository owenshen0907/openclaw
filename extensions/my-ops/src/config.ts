type AdapterDomain = "calendar" | "mail" | "mowen";

export type AdapterConfig = {
  enabled: boolean;
  command?: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
  env?: Record<string, string>;
};

export type MyOpsPluginConfig = {
  adapters: Record<AdapterDomain, AdapterConfig>;
  localFiles: {
    roots: string[];
    inboxPath?: string;
    showTccHints: boolean;
  };
  service: {
    enabled: boolean;
    tickSeconds: number;
    writeStatusFile: boolean;
  };
  observability: {
    recordCalls: boolean;
    maxOutputChars: number;
  };
};

const DEFAULT_TIMEOUT_MS = 30_000;

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const n = Math.floor(value);
  return n > 0 ? n : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value !== "boolean") {
    return fallback;
  }
  return value;
}

function readStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") {
      continue;
    }
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeAdapter(raw: unknown): AdapterConfig {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    enabled: readBoolean((obj as Record<string, unknown>).enabled, true),
    command: readString((obj as Record<string, unknown>).command),
    args: readStringArray((obj as Record<string, unknown>).args),
    cwd: readString((obj as Record<string, unknown>).cwd),
    timeoutMs: readPositiveInt((obj as Record<string, unknown>).timeoutMs, DEFAULT_TIMEOUT_MS),
    env: readStringMap((obj as Record<string, unknown>).env),
  };
}

export function readMyOpsConfig(raw: unknown): MyOpsPluginConfig {
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const adaptersRaw =
    obj.adapters && typeof obj.adapters === "object" && !Array.isArray(obj.adapters)
      ? (obj.adapters as Record<string, unknown>)
      : {};
  const serviceRaw =
    obj.service && typeof obj.service === "object" && !Array.isArray(obj.service)
      ? (obj.service as Record<string, unknown>)
      : {};
  const obsRaw =
    obj.observability && typeof obj.observability === "object" && !Array.isArray(obj.observability)
      ? (obj.observability as Record<string, unknown>)
      : {};
  const localFilesRaw =
    obj.localFiles && typeof obj.localFiles === "object" && !Array.isArray(obj.localFiles)
      ? (obj.localFiles as Record<string, unknown>)
      : {};

  return {
    adapters: {
      calendar: normalizeAdapter(adaptersRaw.calendar),
      mail: normalizeAdapter(adaptersRaw.mail),
      mowen: normalizeAdapter(adaptersRaw.mowen),
    },
    localFiles: {
      roots: readStringArray(localFilesRaw.roots),
      inboxPath: readString(localFilesRaw.inboxPath),
      showTccHints: readBoolean(localFilesRaw.showTccHints, true),
    },
    service: {
      enabled: readBoolean(serviceRaw.enabled, true),
      tickSeconds: readPositiveInt(serviceRaw.tickSeconds, 300),
      writeStatusFile: readBoolean(serviceRaw.writeStatusFile, true),
    },
    observability: {
      recordCalls: readBoolean(obsRaw.recordCalls, true),
      maxOutputChars: readPositiveInt(obsRaw.maxOutputChars, 4000),
    },
  };
}

export type { AdapterDomain };
