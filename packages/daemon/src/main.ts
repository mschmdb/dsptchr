import { parseArgs } from "node:util";
import { createApp } from "./app.ts";
import { loadInstance } from "./instance/loader.ts";
import { stderrLog } from "./log.ts";
import { runDaemon } from "./run.ts";

const USAGE = "usage: node packages/daemon/src/main.ts --instance <name>";

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { instance: { type: "string" } }, strict: true });
  if (values.instance === undefined) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  // State and logs hold private data; keep new files owner-only.
  process.umask(0o077);

  const log = stderrLog(values.instance);
  const instance = await loadInstance(values.instance);
  const app = await createApp(instance, { onHeartbeatError: (error) => log.error(`heartbeat failed: ${error}`) });
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      log.info(`received ${signal}, stopping`);
      controller.abort();
    });
  }

  log.info("started");
  app.store.audit.append({ actor: "daemon", event: "daemon.started" });
  try {
    await runDaemon({ channel: app.channel, inbox: app.inbox, tick: app.tick, log, signal: controller.signal });
  } finally {
    app.store.audit.append({ actor: "daemon", event: "daemon.stopped" });
    app.close();
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"}\n`);
    process.exitCode = 1;
  },
);
