import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ADAPTER_PATH = path.resolve("extensions/my-ops/bin/himalaya-mail-adapter.js");

type RunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  json?: unknown;
};

const describeMaybe = process.platform === "win32" ? describe.skip : describe;

describeMaybe("himalaya-mail-adapter", () => {
  let tempDir = "";
  let fakeHimalayaPath = "";
  let fakeCallsLog = "";
  let stateDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-myops-himalaya-"));
    fakeHimalayaPath = path.join(tempDir, "fake-himalaya");
    fakeCallsLog = path.join(tempDir, "fake-calls.jsonl");
    stateDir = path.join(tempDir, "state");

    const fake = `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const log = process.env.FAKE_HIMALAYA_CALLS_LOG;
if (log) {
  fs.appendFileSync(log, JSON.stringify({ args }) + "\\n", "utf8");
}
if (args.includes("--version")) {
  console.log("himalaya test 1.2.0");
  process.exit(0);
}
if (args.includes("account") && args.includes("list")) {
  console.log(JSON.stringify([{ name: "acc1", backend: "IMAP", default: true }]));
  process.exit(0);
}
if (args.includes("folder") && args.includes("list")) {
  console.log(JSON.stringify([{ name: "INBOX", desc: "\\\\HasNoChildren" }, { name: "Spam", desc: "\\\\Junk" }]));
  process.exit(0);
}
if (args.includes("envelope") && args.includes("list")) {
  console.log(JSON.stringify({ items: [{ id: 42, subject: "Test subject" }] }));
  process.exit(0);
}
if (args.includes("message") && args.includes("read")) {
  console.log(JSON.stringify({ messages: [{ id: 42, body: "Hello" }] }));
  process.exit(0);
}
if (args.includes("template") && args.includes("reply")) {
  console.log(JSON.stringify({ template: "To: a@example.com\\nSubject: Re: Test\\n\\nThanks" }));
  process.exit(0);
}
if (args.includes("message") && args.includes("send")) {
  console.log(JSON.stringify({ sent: true, mode: "message" }));
  process.exit(0);
}
if (args.includes("template") && args.includes("send")) {
  console.log(JSON.stringify({ sent: true, mode: "template" }));
  process.exit(0);
}
if (args.includes("message") && args.includes("move")) {
  console.log(JSON.stringify({ moved: true }));
  process.exit(0);
}
if (args.includes("flag")) {
  console.log(JSON.stringify({ ok: true, flagOp: args[args.findIndex((a) => a === "flag") + 1] }));
  process.exit(0);
}
console.error("unexpected args", JSON.stringify(args));
process.exit(2);
`;
    await writeFile(fakeHimalayaPath, fake, "utf8");
    await chmod(fakeHimalayaPath, 0o755);
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  async function runAdapter(envelope: Record<string, unknown>, extraEnv: NodeJS.ProcessEnv = {}) {
    return await new Promise<RunResult>((resolve, reject) => {
      const child = spawn(process.execPath, [ADAPTER_PATH], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          MYOPS_HIMALAYA_BIN: fakeHimalayaPath,
          MYOPS_HIMALAYA_STATE_DIR: stateDir,
          FAKE_HIMALAYA_CALLS_LOG: fakeCallsLog,
          ...extraEnv,
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
        const trimmed = stdout.trim();
        let json: unknown;
        if (trimmed) {
          try {
            json = JSON.parse(trimmed) as unknown;
          } catch {
            // leave undefined for assertions on raw stdout if needed
          }
        }
        resolve({ code, signal, stdout, stderr, json });
      });

      child.stdin.write(`${JSON.stringify(envelope)}\n`);
      child.stdin.end();
    });
  }

  async function readCallArgs(): Promise<string[][]> {
    try {
      const raw = await readFile(fakeCallsLog, "utf8");
      return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parsed = JSON.parse(line) as { args?: unknown };
          return Array.isArray(parsed.args)
            ? parsed.args.filter((v): v is string => typeof v === "string")
            : [];
        });
    } catch {
      return [];
    }
  }

  it("returns health info when himalaya binary is available", async () => {
    const res = await runAdapter({
      version: 1,
      domain: "mail",
      action: "health",
      payload: {},
    });

    expect(res.code).toBe(0);
    expect(res.json).toMatchObject({
      ok: true,
      domain: "mail",
      action: "health",
      adapter: "himalaya",
      checks: {
        binaryOk: true,
      },
    });
  });

  it("maps list_messages to himalaya envelope list with json output", async () => {
    const res = await runAdapter({
      version: 1,
      domain: "mail",
      action: "list_messages",
      payload: {
        folder: "INBOX",
        page: 2,
        pageSize: 10,
        query: "from boss@example.com",
      },
    });

    expect(res.code).toBe(0);
    expect(res.json).toMatchObject({
      ok: true,
      action: "list_messages",
      result: {
        stdoutJson: {
          items: [{ id: 42 }],
        },
      },
    });

    const calls = await readCallArgs();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toContain("-o");
    expect(calls[0]).toContain("json");
    expect(calls[0]).toContain("envelope");
    expect(calls[0]).toContain("list");
    expect(calls[0]).toContain("-p");
    expect(calls[0]).toContain("2");
    expect(calls[0]).toContain("-s");
    expect(calls[0]).toContain("10");
  });

  it("lists accounts without injecting subcommand-level -a override", async () => {
    const res = await runAdapter(
      {
        version: 1,
        domain: "mail",
        action: "list_accounts",
        payload: {},
      },
      { MYOPS_HIMALAYA_ACCOUNT: "default-acc" },
    );

    expect(res.code).toBe(0);
    expect(res.json).toMatchObject({
      ok: true,
      action: "list_accounts",
      result: {
        stdoutJson: [{ name: "acc1" }],
      },
    });

    const calls = await readCallArgs();
    const accountListCall = calls.find((argv) => argv.includes("account") && argv.includes("list"));
    expect(accountListCall).toBeTruthy();
    expect(accountListCall).not.toContain("-a");
    expect(accountListCall).not.toContain("default-acc");
  });

  it("skips duplicate send_message with same idempotency key and same content", async () => {
    const envelope = {
      version: 1,
      domain: "mail",
      action: "send_message",
      idempotencyKey: "send-42",
      payload: {
        rawMessage: "From: a@example.com\\nTo: b@example.com\\nSubject: Hello\\n\\nHi",
      },
    };

    const first = await runAdapter(envelope);
    const second = await runAdapter(envelope);

    expect(first.code).toBe(0);
    expect(first.json).toMatchObject({
      ok: true,
      action: "send_message",
      idempotency: {
        key: "send-42",
        duplicate: false,
      },
    });

    expect(second.code).toBe(0);
    expect(second.json).toMatchObject({
      ok: true,
      action: "send_message",
      idempotency: {
        key: "send-42",
        duplicate: true,
        skippedSend: true,
      },
    });

    const calls = await readCallArgs();
    const sendCalls = calls.filter((argv) => argv.includes("message") && argv.includes("send"));
    expect(sendCalls).toHaveLength(1);
  });

  it("rejects idempotency key reuse when message content changes", async () => {
    const first = await runAdapter({
      version: 1,
      domain: "mail",
      action: "send_message",
      idempotencyKey: "same-key",
      payload: {
        rawMessage: "From: a@example.com\\nTo: b@example.com\\nSubject: A\\n\\nBody A",
      },
    });
    const second = await runAdapter({
      version: 1,
      domain: "mail",
      action: "send_message",
      idempotencyKey: "same-key",
      payload: {
        rawMessage: "From: a@example.com\\nTo: b@example.com\\nSubject: B\\n\\nBody B",
      },
    });

    expect(first.code).toBe(0);
    expect(second.code).toBe(2);
    expect(second.json).toMatchObject({
      ok: false,
      action: "send_message",
      idempotency: {
        key: "same-key",
        conflict: true,
      },
    });
  });
});
