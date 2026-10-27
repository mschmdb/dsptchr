import type { Channel, InboundEvent } from "@dsptchr/channels";
import type { Inbox } from "./inbox.ts";

export interface DaemonLog {
  info(message: string): void;
  error(message: string): void;
}

export interface RunDaemonOptions {
  channel: Channel;
  inbox: Inbox;
  tick(): Promise<number>;
  log: DaemonLog;
  signal: AbortSignal;
  tickIntervalMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

type Sleep = NonNullable<RunDaemonOptions["sleep"]>;

const MAX_BACKOFF_MS = 60_000;

export async function runDaemon(options: RunDaemonOptions): Promise<void> {
  const sleep = options.sleep ?? abortableSleep;
  await Promise.all([receiveLoop(options, sleep), tickLoop(options, sleep)]);
}

const backoff = (failures: number): number => Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (failures - 1));

async function receiveLoop(options: RunDaemonOptions, sleep: Sleep): Promise<void> {
  const { channel, inbox, signal, log } = options;
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
      const delay = typeof retryAfter === "number" ? retryAfter * 1000 : backoff(failures);
      log.error(`receive failed (${describe(error)}), retrying in ${delay} ms`);
      await sleep(delay, signal);
      continue;
    }
    if (events === undefined || events.length === 0) continue;

    // The channel confirms these events on the next receive. Do not receive again
    // before they are stored, or a crash would lose them.
    if (!(await acceptWithRetry(options, events, sleep))) break;
    await drain(inbox, log);
  }
}

async function acceptWithRetry(options: RunDaemonOptions, events: InboundEvent[], sleep: Sleep): Promise<boolean> {
  let failures = 0;
  while (!options.signal.aborted) {
    try {
      options.inbox.accept(events);
      return true;
    } catch (error) {
      failures++;
      const delay = backoff(failures);
      options.log.error(`storing ${events.length} event(s) failed (${describe(error)}), retrying in ${delay} ms`);
      await sleep(delay, options.signal);
    }
  }
  return false;
}

async function drain(inbox: Inbox, log: DaemonLog): Promise<void> {
  try {
    await inbox.drain();
  } catch (error) {
    log.error(`inbox drain failed: ${describe(error)}`);
  }
}

async function tickLoop(options: RunDaemonOptions, sleep: Sleep): Promise<void> {
  const { signal, log } = options;
  while (!signal.aborted) {
    await drain(options.inbox, log);
    try {
      const sent = await options.tick();
      if (sent > 0) log.info(`sent ${sent} scheduled message(s)`);
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
