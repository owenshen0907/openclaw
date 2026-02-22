import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ADAPTER_PATH = path.resolve("extensions/my-ops/bin/mowen-api-adapter.js");

type RunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  json?: unknown;
};

type CapturedRequest = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  bodyText: string;
  bodyJson?: unknown;
};

const describeMaybe = process.platform === "win32" ? describe.skip : describe;

describeMaybe("mowen-api-adapter", () => {
  let tempDir = "";
  let stateDir = "";
  let baseUrl = "";
  let server: http.Server;
  let requests: CapturedRequest[] = [];
  let responseStatus = 200;
  let responseBody: unknown = { ok: true };

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-myops-mowen-"));
    stateDir = path.join(tempDir, "state");
    requests = [];
    responseStatus = 200;
    responseBody = { ok: true };

    server = http.createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk.toString();
      }

      let bodyJson: unknown;
      if (raw.trim()) {
        try {
          bodyJson = JSON.parse(raw) as unknown;
        } catch {
          // ignore parse error for tests that only need raw body
        }
      }

      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        bodyText: raw,
        bodyJson,
      });

      res.statusCode = responseStatus;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(responseBody));
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.on("error", reject);
    });

    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("failed to get server address");
    }
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  async function runAdapter(envelope: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) {
    return await new Promise<RunResult>((resolve, reject) => {
      const child = spawn(process.execPath, [ADAPTER_PATH], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          MYOPS_MOWEN_API_KEY: "test-api-key",
          MYOPS_MOWEN_BASE_URL: baseUrl,
          MYOPS_MOWEN_STATE_DIR: stateDir,
          MYOPS_MOWEN_MIN_INTERVAL_MS: "1",
          ...env,
        },
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        let json: unknown;
        const trimmed = stdout.trim();
        if (trimmed) {
          try {
            json = JSON.parse(trimmed) as unknown;
          } catch {
            // leave undefined
          }
        }
        resolve({ code, signal, stdout, stderr, json });
      });

      child.stdin.write(`${JSON.stringify(envelope)}\n`);
      child.stdin.end();
    });
  }

  it("returns local health info without consuming network", async () => {
    const res = await runAdapter({
      version: 1,
      domain: "mowen",
      action: "health",
      payload: {},
    });

    expect(res.code).toBe(0);
    expect(res.json).toMatchObject({
      ok: true,
      domain: "mowen",
      action: "health",
      adapter: "mowen-openapi",
      configured: {
        apiKey: true,
      },
    });
    expect(requests).toHaveLength(0);
  });

  it("maps create_doc alias to note/create and builds NoteAtom from text", async () => {
    responseBody = { noteId: "mw-note-1" };
    const res = await runAdapter({
      version: 1,
      domain: "mowen",
      action: "create_doc",
      payload: {
        text: "第一行\n第二行",
        autoPublish: true,
        tags: ["日报", "工作流"],
      },
    });

    expect(res.code).toBe(0);
    expect(res.json).toMatchObject({
      ok: true,
      action: "create_doc",
      mappedAction: "create_note",
      noteId: "mw-note-1",
      api: {
        path: "/api/open/api/v1/note/create",
        status: 200,
      },
      response: {
        json: { noteId: "mw-note-1" },
      },
    });
    expect((res.json as { request?: { body?: unknown } }).request?.body).toBeUndefined();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/api/open/api/v1/note/create");
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.bodyJson).toMatchObject({
      body: {
        type: "doc",
        content: [{ type: "paragraph" }, { type: "paragraph" }],
      },
      settings: {
        autoPublish: true,
        tags: ["日报", "工作流"],
      },
    });

    const createBody = requests[0]?.bodyJson as
      | {
          body?: {
            content?: Array<{
              content?: Array<{ text?: string }>;
            }>;
          };
        }
      | undefined;
    const firstParagraph = createBody?.body?.content?.[0];
    expect(firstParagraph?.content?.[0]?.text).toBe("第一行");
  });

  it("maps upload_url fileKind to fileType enum", async () => {
    responseBody = {
      file: {
        fileId: "f-1",
        url: "https://cdn.example/file.png",
      },
    };
    const res = await runAdapter({
      version: 1,
      domain: "mowen",
      action: "upload_url",
      payload: {
        fileKind: "image",
        url: "https://example.com/a.png",
        fileName: "a.png",
      },
    });

    expect(res.code).toBe(0);
    expect(res.json).toMatchObject({
      ok: true,
      mappedAction: "upload_url",
      api: {
        path: "/api/open/api/v1/upload/url",
      },
    });
    expect(requests[0]?.bodyJson).toMatchObject({
      fileType: 1,
      url: "https://example.com/a.png",
      fileName: "a.png",
    });
  });

  it("rejects unsupported append_doc with actionable message", async () => {
    const res = await runAdapter({
      version: 1,
      domain: "mowen",
      action: "append_doc",
      payload: {
        noteId: "abc",
        text: "more",
      },
    });

    expect(res.code).toBe(2);
    expect(res.json).toMatchObject({
      ok: false,
      action: "append_doc",
    });
    expect(String((res.json as Record<string, unknown>).error)).toContain("not supported");
    expect(requests).toHaveLength(0);
  });
});
