import { inboundEventSchema, type InboundEvent } from "@dsptchr/channels";
import type { Store } from "@dsptchr/store";

export interface InboxDeps {
  store: Store;
  handle(event: InboundEvent): Promise<void>;
  now: () => number;
  // Called once when an event is given up; the operator should hear about it.
  onDead(entryId: string): Promise<void>;
  maxAttempts?: number;
}

const BASE_DELAY_MS = 60_000;
const MAX_DELAY_MS = 60 * 60_000;

export interface Inbox {
  accept(events: readonly InboundEvent[]): void;
  // Processes due events; returns how many succeeded. Concurrent calls share one run.
  drain(): Promise<number>;
}

export function createInbox({ store, handle, now, onDead, maxAttempts = 5 }: InboxDeps): Inbox {
  let running: Promise<number> | undefined;

  async function giveUp(id: string, error: string): Promise<void> {
    const state = store.inbox.markFailed(id, { maxAttempts: 1, retryAt: now(), error });
    if (state === "dead") await onDead(id);
  }

  async function run(): Promise<number> {
    const seen = new Set<string>();
    let succeeded = 0;
    for (;;) {
      const batch = store.inbox.due().filter((entry) => !seen.has(entry.id));
      if (batch.length === 0) return succeeded;

      for (const entry of batch) {
        seen.add(entry.id);
        const parsed = inboundEventSchema.safeParse(entry.payload);
        if (!parsed.success) {
          await giveUp(entry.id, "invalid payload");
          continue;
        }
        try {
          await handle(parsed.data);
          store.inbox.markDone(entry.id);
          succeeded++;
        } catch (error) {
          // Only the error class goes to the audit log; messages may echo operator content.
          const name = error instanceof Error ? error.name : "unknown";
          const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** entry.attempts);
          const state = store.inbox.markFailed(entry.id, { maxAttempts, retryAt: now() + delay, error: name });
          if (state === "dead") await onDead(entry.id);
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
  };
}
