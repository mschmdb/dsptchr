import { describe, expect, it } from "vitest";
import { createOperatorHandler } from "../src/operator.ts";
import { createReminderScheduler } from "../src/reminders.ts";
import { harness, T0, text, TZ } from "./support/harness.ts";

function setup() {
  const h = harness();
  const handler = createOperatorHandler({ store: h.store, dispatcher: h.dispatcher, timeZone: TZ, now: () => h.clock.now });
  const scheduler = createReminderScheduler({ store: h.store, dispatcher: h.dispatcher, now: () => h.clock.now });
  return { ...h, handler, scheduler };
}

async function capture(h: ReturnType<typeof setup>, input: string): Promise<string> {
  await h.handler.handle(text(input));
  h.sent.length = 0;
  const todo = h.store.todos.listActive().at(-1);
  if (todo === undefined) throw new Error("no todo");
  return todo.id;
}

describe("reminder scheduler", () => {
  it("does nothing before the due time", async () => {
    const h = setup();
    await capture(h, "Water plants @ in 1h");
    expect(await h.scheduler.tick()).toBe(0);
    expect(h.sent).toEqual([]);
  });

  it("sends a reminder with buttons at the due time, once", async () => {
    const h = setup();
    const id = await capture(h, "Water plants @ in 1h");
    h.clock.now = T0 + 3_600_000;

    expect(await h.scheduler.tick()).toBe(1);
    expect(await h.scheduler.tick()).toBe(0);
    expect(h.sent).toEqual([
      {
        text: "Reminder: Water plants",
        buttons: [
          [
            { label: "Done", data: `todo:done:${id}` },
            { label: "+1 h", data: `todo:hour:${id}` },
            { label: "Tomorrow", data: `todo:tomorrow:${id}` },
          ],
        ],
      },
    ]);
  });

  it("wakes a snoozed todo when its reminder fires", async () => {
    const h = setup();
    const id = await capture(h, "Water plants @ in 1h");
    await h.dispatcher.dispatch({
      type: "todo.update",
      payload: { todoId: id, event: "snooze", dueAt: T0 + 7_200_000 },
      idempotencyKey: "snooze",
      actor: "operator",
    });
    h.clock.now = T0 + 7_200_000;

    await h.scheduler.tick();

    expect(h.store.todos.get(id)?.state).toBe("open");
    expect(h.sent).toHaveLength(1);
  });

  it("drops reminders of todos that are already done", async () => {
    const h = setup();
    const id = await capture(h, "Water plants @ in 1h");
    h.store.todos.transition(id, "complete", { actor: "operator" });
    h.clock.now = T0 + 3_600_000;

    expect(await h.scheduler.tick()).toBe(0);
    expect(h.sent).toEqual([]);
    expect(h.store.reminders.due()).toEqual([]);
  });

  it("retries a failed send later and gives up after three attempts", async () => {
    const h = setup();
    await capture(h, "Water plants @ in 1h");
    h.clock.now = T0 + 3_600_000;
    h.failSends.value = true;

    await h.scheduler.tick();
    expect(await h.scheduler.tick()).toBe(0);
    h.clock.now += 5 * 60_000;
    await h.scheduler.tick();
    h.clock.now += 5 * 60_000;
    await h.scheduler.tick();
    h.clock.now += 5 * 60_000;
    h.failSends.value = false;
    expect(await h.scheduler.tick()).toBe(0);
    expect(h.sent).toEqual([]);
  });

  it("recovers after a transient failure", async () => {
    const h = setup();
    await capture(h, "Water plants @ in 1h");
    h.clock.now = T0 + 3_600_000;
    h.failSends.value = true;
    await h.scheduler.tick();
    h.failSends.value = false;
    h.clock.now += 5 * 60_000;
    expect(await h.scheduler.tick()).toBe(1);
    expect(h.sent).toHaveLength(1);
  });

  it("holds reminders while paused and fires them after resume", async () => {
    const h = setup();
    await capture(h, "Water plants @ in 1h");
    h.store.flags.setPaused(true, "operator");
    h.clock.now = T0 + 3_600_000;
    expect(await h.scheduler.tick()).toBe(0);

    h.store.flags.setPaused(false, "operator");
    expect(await h.scheduler.tick()).toBe(1);
  });
});
