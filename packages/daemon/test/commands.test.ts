import { describe, expect, it } from "vitest";
import { createOperatorHandler } from "../src/operator.ts";
import { button, harness, T0, text, TZ } from "./support/harness.ts";

function setup() {
  const h = harness();
  const handler = createOperatorHandler({ store: h.store, dispatcher: h.dispatcher, timeZone: TZ, now: () => h.clock.now });
  return { ...h, handler };
}

describe("/todos", () => {
  it("lists open todos with done and drop buttons", async () => {
    const h = setup();
    const a = h.store.todos.create({ text: "Water plants", dueAt: T0 + 3_600_000, actor: "operator" });
    const b = h.store.todos.create({ text: "Someday", actor: "operator" });

    await h.handler.handle(text("/todos"));

    expect(h.sent).toEqual([
      {
        text: "Open todos:\n1. Water plants (due Tue 27.10. 12:00)\n2. Someday",
        conversation: "-1002",
        buttons: [
          [
            { label: "1 Done", data: `todo:done:${a.id}` },
            { label: "1 Drop", data: `todo:drop:${a.id}` },
          ],
          [
            { label: "2 Done", data: `todo:done:${b.id}` },
            { label: "2 Drop", data: `todo:drop:${b.id}` },
          ],
        ],
      },
    ]);
    expect(h.store.todos.listActive()).toHaveLength(2);
  });

  it("says so when nothing is open", async () => {
    const h = setup();
    await h.handler.handle(text("/todos"));
    expect(h.sent[0]?.text).toBe("No open todos.");
  });

  it("shows buttons for at most eight todos", async () => {
    const h = setup();
    for (let i = 0; i < 10; i++) h.store.todos.create({ text: `t${i}`, actor: "operator" });
    await h.handler.handle(text("/todos"));
    expect(h.sent[0]?.buttons).toHaveLength(8);
    expect(h.sent[0]?.text.split("\n")).toHaveLength(11);
  });

  it("keeps the list within one Telegram message", async () => {
    const h = setup();
    for (let i = 0; i < 60; i++) h.store.todos.create({ text: `${"x".repeat(480)} ${i}`, actor: "operator" });
    await h.handler.handle(text("/todos"));
    expect(h.sent[0]?.text.length).toBeLessThanOrEqual(4096);
    expect(h.sent[0]?.text).toMatch(/and \d+ more/);
  });

  it("accepts the bot-suffixed form Telegram sends in groups", async () => {
    const h = setup();
    await h.handler.handle(text("/todos@some_bot"));
    expect(h.sent[0]?.text).toBe("No open todos.");
  });
});

describe("drop button", () => {
  it("drops a todo", async () => {
    const h = setup();
    const a = h.store.todos.create({ text: "Mistake", actor: "operator" });
    await h.handler.handle(button(`todo:drop:${a.id}`));
    expect(h.store.todos.get(a.id)?.state).toBe("dropped");
    expect(h.acks[0]?.note).toBe("Dropped: Mistake");
  });
});

describe("/health", () => {
  it("lists open findings and the last check time", async () => {
    const h = setup();
    h.store.observations.observe({
      source: "server-health",
      externalId: "host-a:disk",
      version: "crit",
      data: { host: "host-a", text: "Disk 95% full" },
    });
    h.store.cursors.set("server-health:last_success", String(T0));

    await h.handler.handle(text("/health"));

    expect(h.sent[0]?.text).toBe("Server health (last check Tue 27.10. 11:00)\n- CRIT host-a: Disk 95% full");
  });

  it("keeps the health list within one Telegram message", async () => {
    const h = setup();
    h.store.cursors.set("server-health:last_success", String(T0));
    for (let i = 0; i < 80; i++) {
      h.store.observations.observe({
        source: "server-health",
        externalId: `host-a:c${i}`,
        version: "warn",
        data: { host: "host-a", text: "y".repeat(160) },
      });
    }
    await h.handler.handle(text("/health"));
    expect(h.sent[0]?.text.length).toBeLessThanOrEqual(4096);
  });

  it("reports all clear", async () => {
    const h = setup();
    h.store.cursors.set("server-health:last_success", String(T0));
    await h.handler.handle(text("/health"));
    expect(h.sent[0]?.text).toBe("Server health (last check Tue 27.10. 11:00)\nAll clear.");
  });

  it("reports when no check has run yet", async () => {
    const h = setup();
    await h.handler.handle(text("/health"));
    expect(h.sent[0]?.text).toBe("Server health: no successful check yet.");
  });
});

describe("/github", () => {
  it("lists open items by others and bots and red CI with links", async () => {
    const h = setup();
    const observe = (externalId: string, version: string, data: Record<string, unknown>) =>
      h.store.observations.observe({ source: "github", externalId, version, data });
    observe("owner-a/repo-a#pr7", "open", { repo: "owner-a/repo-a", kind: "pr", number: 7, author: "other", title: "Fix login", url: "https://github.com/a/7" });
    observe("owner-a/repo-a#pr8", "open", { repo: "owner-a/repo-a", kind: "pr", number: 8, author: "bot", title: "Bump vite", url: "https://github.com/a/8" });
    observe("owner-a/repo-a#issue4", "open", { repo: "owner-a/repo-a", kind: "issue", number: 4, author: "self", title: "Mine", url: "" });
    observe("owner-a/repo-a:ci:1", "red", { repo: "owner-a/repo-a", kind: "ci", workflow: "CI", url: "https://github.com/a/r/1" });

    await h.handler.handle(text("/github"));

    expect(h.sent[0]?.text).toBe(
      [
        "GitHub",
        "- PR repo-a#7: Fix login",
        "  https://github.com/a/7",
        "- bot PR repo-a#8: Bump vite",
        "  https://github.com/a/8",
        "- CI red: repo-a CI",
        "  https://github.com/a/r/1",
        "Own open items: 1.",
      ].join("\n"),
    );
  });

  it("says when nothing is open", async () => {
    const h = setup();
    await h.handler.handle(text("/github"));
    expect(h.sent[0]?.text).toBe("GitHub: nothing open.");
  });
});

describe("/calendar", () => {
  it("lists today and tomorrow from the calendar monitor", async () => {
    const h = harness();
    const handler = createOperatorHandler({
      store: h.store,
      dispatcher: h.dispatcher,
      timeZone: TZ,
      now: () => h.clock.now,
      sources: { calendar: { lines: (offset: number) => (offset === 0 ? ["- 15:00–16:00 Dentist"] : []) } as never },
    });
    await handler.handle(text("/calendar"));
    expect(h.sent[0]?.text).toBe("Today:\n- 15:00–16:00 Dentist\nTomorrow:\n- nothing");
  });

  it("says when no calendar is configured", async () => {
    const h = setup();
    await h.handler.handle(text("/calendar"));
    expect(h.sent[0]?.text).toBe("No calendar configured.");
  });
});

describe("/status", () => {
  it("summarizes the daemon state", async () => {
    const h = setup();
    h.store.todos.create({ text: "a", actor: "operator" });
    h.store.cursors.set("server-health:last_success", String(T0));
    await h.handler.handle(text("/status"));
    expect(h.sent[0]?.text).toBe("Running. 1 open todo. 0 open health findings. Last health check Tue 27.10. 11:00.");
  });
});

describe("unknown commands", () => {
  it("lists the available commands instead of creating a todo", async () => {
    const h = setup();
    await h.handler.handle(text("/nope"));
    expect(h.store.todos.listActive()).toEqual([]);
    expect(h.sent[0]?.text).toContain("/todos");
  });
});
