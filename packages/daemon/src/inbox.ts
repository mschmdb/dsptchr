import { inboundEventSchema, type InboundEvent } from "@dsptchr/channels";
import type { Store } from "@dsptchr/store";

export interface InboxDeps {
  store: Store;
  handle(event: InboundEvent): Promise<void>;
  now: () => number;
  // Tells the operator that an event was set aside. Returns true once delivered;
  // until then every drain tries again.
  onDead(entryId: string): Promise<boolean>;
  maxAttempts?: number;
  handlerTimeoutMs?: number;
}

export class HandlerTimeoutError extends Error {
  override name = "HandlerTimeoutError";
}

const BASE_DELAY_MS = 60_000;
const MAX_DELAY_MS = 60 * 60_000;

export interface Inbox {
  accept(events: readonly InboundEvent[]): void;
  // Processes due events; returns how many succeeded. Concurrent calls share one run.
  drain(): Promise<number>;
  // Resolves when no drain is running.
  idle(): Promise<void>;
}

export function createInbox({ store, handle, now, onDead, maxAttempts = 5, handlerTimeoutMs = 60_000 }: InboxDeps): Inbox {
  // A handler that never settles must not block later events such as "stop". The late
  // attempt may still finish; idempotency keys keep the retry from repeating its steps.
  async function handleBounded(event: InboundEvent): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new HandlerTimeoutError(`handler exceeded ${handlerTimeoutMs} ms`)), handlerTimeoutMs);
    });
    try {
      await Promise.race([handle(event), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  let running: Promise<number> | undefined;

  async function notifyDead(): Promise<void> {
    if (store.flags.isPaused()) return;
    for (const entry of store.inbox.deadUnnotified()) {
      if (await onDead(entry.id)) store.inbox.markDeadNotified(entry.id);
    }
  }

  async function run(): Promise<number> {
    const seen = new Set<string>();
    let succeeded = 0;
    for (;;) {
      const batch = store.inbox.due().filter((entry) => !seen.has(entry.id));
      if (batch.length === 0) {
        await notifyDead();
        return succeeded;
      }

      for (const entry of batch) {
        seen.add(entry.id);
        const parsed = inboundEventSchema.safeParse(entry.payload);
        if (!parsed.success) {
          store.inbox.markFailed(entry.id, { maxAttempts: 1, retryAt: now(), error: "invalid payload" });
          continue;
        }
        try {
          await handleBounded(parsed.data);
          store.inbox.markDone(entry.id);
          succeeded++;
        } catch (error) {
          // Only the error class goes to the audit log; messages may echo operator content.
          const name = error instanceof Error ? error.name : "unknown";
          const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** entry.attempts);
          store.inbox.markFailed(entry.id, { maxAttempts, retryAt: now() + delay, error: name });
        }
      }
    }
  }

  return {
    accept(events) {
      store.inbox.accept(events.map((event) => ({ id: event.id, receivedAt: event.receivedAt, payload: event })));
    },
    drain() {
      running ??= run().finally(() => {
        running = undefined;
      });
      return running;
    },
    async idle() {
      await running?.catch(() => undefined);
    },
  };
}
