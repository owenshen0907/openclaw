import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk";
import { readMyOpsConfig } from "./config.js";
import {
  ensureMyOpsStateDir,
  resolveCallsLogPath,
  resolveMyOpsStateDir,
  writeServiceStatus,
} from "./state.js";

export function createMyOpsService(api: OpenClawPluginApi): OpenClawPluginService {
  let interval: ReturnType<typeof setInterval> | null = null;
  let startedAt = 0;

  const writeStatus = async (phase: "started" | "tick" | "stopped") => {
    const cfg = readMyOpsConfig(api.pluginConfig);
    await ensureMyOpsStateDir(api);
    await writeServiceStatus(api, {
      pluginId: "my-ops",
      phase,
      startedAt: startedAt ? new Date(startedAt).toISOString() : null,
      now: new Date().toISOString(),
      stateDir: resolveMyOpsStateDir(api),
      callsLog: resolveCallsLogPath(api),
      adapters: Object.fromEntries(
        Object.entries(cfg.adapters).map(([domain, adapter]) => [
          domain,
          {
            enabled: adapter.enabled,
            configured: Boolean(adapter.command),
            command: adapter.command ?? null,
            cwd: adapter.cwd ?? null,
            timeoutMs: adapter.timeoutMs,
            argsCount: adapter.args.length,
            envKeys: Object.keys(adapter.env ?? {}).sort(),
          },
        ]),
      ),
    });
  };

  return {
    id: "my-ops-service",
    start: async () => {
      const cfg = readMyOpsConfig(api.pluginConfig);
      if (!cfg.service.enabled) {
        api.logger.info?.("my-ops: service disabled by config");
        return;
      }

      startedAt = Date.now();
      await writeStatus("started").catch((err) => {
        api.logger.warn?.(`my-ops: failed to write service status (${String(err)})`);
      });

      const everyMs = Math.max(10_000, cfg.service.tickSeconds * 1000);
      interval = setInterval(() => {
        writeStatus("tick").catch((err) => {
          api.logger.warn?.(`my-ops: status tick failed (${String(err)})`);
        });
      }, everyMs);
      interval.unref?.();

      api.logger.info?.(`my-ops: service started (tick=${Math.floor(everyMs / 1000)}s)`);
    },
    stop: async () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      await writeStatus("stopped").catch(() => {});
      api.logger.info?.("my-ops: service stopped");
    },
  };
}
