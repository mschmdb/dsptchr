import type { Channel, InboundEvent } from "@dsptchr/channels";

export interface DaemonLog {
  info(message: string): void;
  error(message: string): void;
}

export interface RunDaemonOptions {
  channel: Channel;
  handle(event: InboundEvent): Promise<void>;
  onHandlerError?: (event: InboundEvent) => void;
  tick(): Promise<number>;
  log: DaemonLog;
  signal: AbortSignal;
  tickIntervalMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const MAX_BACKOFF_MS = 60_000;

export async function runDaemon(options: RunDaemonOptions): Promise<void> {
  const sleep = options.sleep ?? abortableSleep;
  await Promise.all([receiveLoop(options, sleep), tickLoop(options, sleep)]);
}

async function receiveLoop(options: RunDaemonOptions, sleep: NonNullable<RunDaemonOptions["sleep"]>): Promise<void> {
  const { channel, signal, log } = options;
  const aborted = new Promise<undefined>((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
  let failures = 0;

  while (!signal.aborted) {
    let events: InboundEvent[] | undefined;
    try {
      events = await Promise.race([channel.receive(signal), aborted]);
      failures = 0;
    } catch (error) {
      if (signal.aborted) break;
      failures++;
      const retryAfter = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
      const delay =
        typeof retryAfter === "number" ? retryAfter * 1000 : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (failures - 1));
      log.error(`receive failed (${describe(error)}), retrying in ${delay} ms`);
      await sleep(delay, signal);
      continue;
    }
    for (const event of events ?? []) {
      try {
        await options.handle(event);
      } catch (error) {
        log.error(`handling ${event.kind} event ${event.id} failed: ${describe(error)}`);
        options.onHandlerError?.(event);
      }
    }
  }
}

async function tickLoop(options: RunDaemonOptions, sleep: NonNullable<RunDaemonOptions["sleep"]>): Promise<void> {
  const { signal, log } = options;
  while (!signal.aborted) {
    try {
      const sent = await options.tick();
      if (sent > 0) log.info(`sent ${sent} reminder(s)`);
    } catch (error) {
      log.error(`scheduler tick failed: ${describe(error)}`);
    }
    await sleep(options.tickIntervalMs ?? 30_000, signal);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
