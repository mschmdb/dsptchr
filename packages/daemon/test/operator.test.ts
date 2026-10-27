import { describe, expect, it } from "vitest";
import { createOperatorHandler } from "../src/operator.ts";
import { button, harness, T0, text, TZ } from "./support/harness.ts";

function setup() {
  const h = harness();
  const handler = createOperatorHandler({ store: h.store, dispatcher: h.dispatcher, timeZone: TZ, now: () => h.clock.now });
  return { ...h, handler };
}

describe("text capture", () => {
  it("creates a todo with a due date and confirms it", async () => {
    const h = setup();
    await h.handler.handle(text("Call the bank @ morgen 9:00"));

    const [todo] = h.store.todos.listActive();
    expect(todo).toMatchObject({ text: "Call the bank", dueAt: Date.parse("2026-10-28T08:00:00Z") });
    expect(h.sent).toEqual([{ text: "Saved: Call the bank (due Wed 28.10. 09:00)", conversation: "-1002" }]);
  });

  it("creates an undated todo", async () => {
    const h = setup();
    await h.handler.handle(text("Buy milk"));
    expect(h.store.todos.listActive()).toMatchObject([{ text: "Buy milk", dueAt: undefined }]);
    expect(h.sent[0]?.text).toBe("Saved: Buy milk");
  });

  it("refuses an unreadable due date instead of guessing", async () => {
    const h = setup();
    await h.handler.handle(text("Pay rent @ someday"));
    expect(h.store.todos.listActive()).toEqual([]);
    expect(h.sent[0]?.text).toMatch(/due date/i);
  });

  it("ignores blank messages", async () => {
    const h = setup();
    await h.handler.handle(text("   "));
    expect(h.store.todos.listActive()).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("does not create duplicates when the same event is redelivered", async () => {
    const h = setup();
    const event = text("Buy milk");
    await h.handler.handle(event);
    await h.handler.handle(event);
    expect(h.store.todos.listActive()).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
  });
});

describe("failures", () => {
  it("throws when an action fails so the inbox retries, without duplicating effects", async () => {
    const h = setup();
    const event = text("Buy milk");
    h.failSends.value = true;
    await expect(h.handler.handle(event)).rejects.toThrow(/failed/);
    expect(h.store.todos.listActive()).toHaveLength(1);

    h.failSends.value = false;
    await h.handler.handle(event);
    expect(h.store.todos.listActive()).toHaveLength(1);
    expect(h.sent).toEqual([{ text: "Saved: Buy milk", conversation: "-1002" }]);
  });

  it("does not throw when the gate denies an action", async () => {
    const h = setup();
    h.store.flags.setPaused(true, "operator");
    await expect(h.handler.handle(text("Buy milk"))).resolves.toBeUndefined();
  });
});

describe("kill switch", () => {
  it.each(["stop", "Stopp", " STOP "])("pauses on %j and confirms first", async (word) => {
    const h = setup();
    await h.handler.handle(text(word));
    expect(h.store.flags.isPaused()).toBe(true);
    expect(h.sent[0]?.text).toMatch(/paused/i);
  });

  it("pauses immediately even when the confirmation never completes", async () => {
    const h = setup();
    h.channel.send = () => new Promise(() => {});
    void h.handler.handle(text("stop"));
    await Promise.resolve();
    expect(h.store.flags.isPaused()).toBe(true);
  });

  it("blocks todo capture while paused and resumes on start", async () => {
    const h = setup();
    await h.handler.handle(text("stop"));
    await h.handler.handle(text("Buy milk"));
    expect(h.store.todos.listActive()).toEqual([]);

    await h.handler.handle(text("start"));
    expect(h.store.flags.isPaused()).toBe(false);
    expect(h.sent.at(-1)?.text).toMatch(/resumed/i);
  });

  it("does not treat a sentence containing stop as the kill switch", async () => {
    const h = setup();
    await h.handler.handle(text("stop by the bakery"));
    expect(h.store.flags.isPaused()).toBe(false);
    expect(h.store.todos.listActive()).toHaveLength(1);
  });
});

describe("buttons", () => {
  async function todoWithDue(h: ReturnType<typeof setup>): Promise<string> {
    await h.handler.handle(text("Water plants @ in 1h"));
    const todo = h.store.todos.listActive()[0];
    if (todo === undefined) throw new Error("no todo");
    h.sent.length = 0;
    return todo.id;
  }

  it("marks a todo done", async () => {
    const h = setup();
    const id = await todoWithDue(h);
    await h.handler.handle(button(`todo:done:${id}`));
    expect(h.store.todos.get(id)?.state).toBe("done");
    expect(h.sent).toEqual([]);
    expect(h.acks).toEqual([
      { target: { conversation: "-1002", messageRef: "1", callbackRef: expect.any(String) }, note: "Done: Water plants" },
    ]);
  });

  it("keeps acknowledgement notes short for long todo texts", async () => {
    const h = setup();
    await h.handler.handle(text(`${"x".repeat(900)} @ in 1h`));
    const id = h.store.todos.listActive()[0]?.id ?? "";
    await h.handler.handle(button(`todo:done:${id}`));
    await h.handler.handle(button(`todo:done:${id}`));
    expect(h.acks.map((a) => a.note.length).every((n) => n <= 200)).toBe(true);
    expect(h.acks).toHaveLength(2);
  });

  it("snoozes by one hour", async () => {
    const h = setup();
    const id = await todoWithDue(h);
    await h.handler.handle(button(`todo:hour:${id}`));
    expect(h.store.todos.get(id)).toMatchObject({ state: "snoozed", dueAt: T0 + 3_600_000 });
    expect(h.acks[0]?.note).toBe("Snoozed until Tue 27.10. 12:00");
  });

  it("snoozes to tomorrow 09:00 local time", async () => {
    const h = setup();
    const id = await todoWithDue(h);
    await h.handler.handle(button(`todo:tomorrow:${id}`));
    expect(h.store.todos.get(id)).toMatchObject({ state: "snoozed", dueAt: Date.parse("2026-10-28T08:00:00Z") });
  });

  it("answers gracefully when the todo is already done", async () => {
    const h = setup();
    const id = await todoWithDue(h);
    await h.handler.handle(button(`todo:done:${id}`));
    await h.handler.handle(button(`todo:done:${id}`));
    expect(h.acks.at(-1)?.note).toMatch(/already done/i);
  });

  it("ignores unknown or malformed button data", async () => {
    const h = setup();
    for (const data of ["todo:explode:x", "nope", "todo:done:", "todo:done:a:b"]) {
      await h.handler.handle(button(data));
    }
    expect(h.sent).toEqual([]);
    expect(h.acks.map((a) => a.note)).toEqual(Array(4).fill("Unknown action"));
    expect(h.store.audit.list().filter((e) => e.event === "operator.unknown_button")).toHaveLength(4);
  });

  it("ignores buttons for unknown todos", async () => {
    const h = setup();
    await h.handler.handle(button("todo:done:missing"));
    expect(h.acks[0]?.note).toMatch(/not found/i);
  });
});
