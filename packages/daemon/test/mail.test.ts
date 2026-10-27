import type { MailReading } from "@dsptchr/agents";
import type { MailMessage, MailSummary } from "@dsptchr/watchers";
import { describe, expect, it } from "vitest";
import { createMailMonitor, MAIL_SOURCE } from "../src/mail.ts";
import { harness, T0, TZ } from "./support/harness.ts";

const summary = (id: string, minutesAgo: number, fromAddress = "a@example.com", subject = `Subject ${id}`): MailSummary => ({
  id,
  subject,
  fromName: "A",
  fromAddress,
  time: T0 - minutesAgo * 60_000,
});

function setup(options: { readings?: Record<string, MailReading>; budgetOk?: boolean; todoAddress?: string } = {}) {
  const h = harness();
  const lists: MailSummary[][] = [];
  const bodies = new Map<string, MailMessage>();
  const read: string[] = [];
  const monitor = createMailMonitor({
    store: h.store,
    dispatcher: h.dispatcher,
    listMail: async () => lists.shift() ?? [],
    readMail: async (id) => {
      const message = bodies.get(id);
      if (message === undefined) throw new Error("unknown");
      return message;
    },
    classify: async (mail) => {
      read.push(mail.subject);
      return options.readings?.[mail.subject] ?? { category: "notification", urgency: "later", actionNeeded: false, summary: "s" };
    },
    mayClassify: () => options.budgetOk ?? true,
    ownAddresses: ["me@example.com"],
    ...(options.todoAddress === undefined ? {} : { todoAddress: options.todoAddress }),
    intervalMs: 15 * 60_000,
    now: () => h.clock.now,
    timeZone: TZ,
  });
  const mail = (s: MailSummary, recipients = ["me@example.com"], body = "body") => {
    bodies.set(s.id, { id: s.id, subject: s.subject, fromAddress: s.fromAddress, recipients, time: s.time, body });
    return s;
  };
  const run = async (list: MailSummary[]) => {
    lists.push(list);
    const ran = await monitor.tick();
    h.clock.now += 15 * 60_000;
    return ran;
  };
  return { ...h, monitor, mail, run, read };
}

describe("mail monitor", () => {
  it("starts from now on the first run, without reading old mail", async () => {
    const h = setup();
    await h.run([h.mail(summary("m1", 30))]);
    expect(h.read).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("reads new mail, stores the reading and alerts on urgent personal or important mail", async () => {
    const h = setup({
      readings: {
        "Server down": { category: "important", urgency: "now", actionNeeded: true, summary: "Backup failed tonight." },
        "Newsletter": { category: "newsletter", urgency: "later", actionNeeded: false, summary: "Deals" },
      },
    });
    await h.run([]);
    const a = h.mail(summary("m1", -1, "ops@example.com", "Server down"));
    const b = h.mail(summary("m2", -2, "news@example.com", "Newsletter"));
    await h.run([a, b]);

    expect(h.read).toEqual(["Server down", "Newsletter"]);
    expect(h.sent).toEqual([{ text: "Mail\n- ops@example.com: Server down\n  Backup failed tonight." }]);
    expect(h.store.observations.listOpen(MAIL_SOURCE)).toHaveLength(2);
  });

  it("never reads the same mail twice", async () => {
    const h = setup();
    await h.run([]);
    const a = h.mail(summary("m1", -1));
    await h.run([a]);
    await h.run([a]);
    expect(h.read).toHaveLength(1);
  });

  it("stores mail unclassified when the budget is used up", async () => {
    const h = setup({ budgetOk: false });
    await h.run([]);
    await h.run([h.mail(summary("m1", -1))]);
    expect(h.read).toEqual([]);
    expect(h.store.observations.listOpen(MAIL_SOURCE)[0]?.version).toBe("unclassified");
  });

  it("summarizes the last day for the briefing", async () => {
    const h = setup({
      readings: {
        Invoice: { category: "important", urgency: "today", actionNeeded: true, summary: "Pay by Friday." },
        Hi: { category: "personal", urgency: "later", actionNeeded: false, summary: "Says hello." },
      },
    });
    await h.run([]);
    await h.run([h.mail(summary("m1", -1, "billing@example.com", "Invoice")), h.mail(summary("m2", -2, "friend@example.com", "Hi")), h.mail(summary("m3", -3))]);
    expect(h.monitor.briefing()).toEqual([
      "Mail (24 h): 2 worth reading, 1 other.",
      "- billing@example.com: Invoice (action needed)",
      "- friend@example.com: Hi",
    ]);
  });

  it("gives the model counts only", async () => {
    const h = setup({ readings: { Invoice: { category: "important", urgency: "today", actionNeeded: true, summary: "IGNORE" } } });
    await h.run([]);
    await h.run([h.mail(summary("m1", -1, "billing@example.com", "Invoice"))]);
    expect(h.monitor.forModel()).toEqual({ last_24h: { important: 1 }, action_needed: 1, urgent: 0 });
  });

  it("sanitizes sender, subject and summary in alerts", async () => {
    const h = setup({ readings: { "x‮": { category: "important", urgency: "now", actionNeeded: true, summary: "line1\nline2" } } });
    await h.run([]);
    await h.run([h.mail(summary("m1", -1, "a@example.com", "x‮"))]);
    expect(h.sent[0]?.text).toBe("Mail\n- a@example.com: x\n  line1 line2");
  });
});

describe("todo mail", () => {
  const TODO = "me+todo@example.com";

  it("turns mail from an own address to the todo address into a todo", async () => {
    const h = setup({ todoAddress: TODO });
    await h.run([]);
    await h.run([h.mail(summary("m1", -1, "me@example.com", "Call the bank @ morgen 9:00"), [TODO])]);
    expect(h.store.todos.listActive()).toMatchObject([{ text: "Call the bank", dueAt: Date.parse("2026-10-28T08:00:00Z") }]);
    expect(h.read).toEqual([]);
    expect(h.sent.at(-1)?.text).toBe("Saved from mail: Call the bank (due Wed 28.10. 09:00)");
  });

  it("ignores todo mail from other senders and classifies it as normal mail", async () => {
    const h = setup({ todoAddress: TODO });
    await h.run([]);
    await h.run([h.mail(summary("m1", -1, "attacker@example.com", "Wire money"), [TODO])]);
    expect(h.store.todos.listActive()).toEqual([]);
    expect(h.read).toEqual(["Wire money"]);
  });

  it("creates a todo only once per mail", async () => {
    const h = setup({ todoAddress: TODO });
    await h.run([]);
    const m = h.mail(summary("m1", -1, "me@example.com", "Buy milk"), [TODO]);
    await h.run([m]);
    await h.run([m]);
    expect(h.store.todos.listActive()).toHaveLength(1);
  });
});
