import { describe, expect, it } from "vitest";
import { sendAlertLines, type AlertLine } from "../src/alerts.ts";
import { createOperatorHandler } from "../src/operator.ts";
import { button, harness, TZ } from "./support/harness.ts";

function line(n: number, applied: string[], source = "mail", domain = `d${n}.example.com`): AlertLine {
  return {
    text: `- item ${n}`,
    apply: () => applied.push(`i${n}`),
    feedback: { source, externalId: `x${n}`, features: { source, domain }, label: `item ${n}` },
  };
}

describe("alerts with feedback", () => {
  it("numbers items and adds one feedback row per item", async () => {
    const h = harness();
    const applied: string[] = [];
    await sendAlertLines(h.dispatcher, h.store, { title: "Mail", lines: [line(1, applied), line(2, applied)], keyBase: "k" });
    const message = h.sent[0];
    expect(message?.text).toBe("Mail\n1. item 1\n2. item 2");
    expect(message?.buttons?.map((row) => row.map((b) => b.label))).toEqual([
      ["1 👍", "1 👎", "1 🔕"],
      ["2 👍", "2 👎", "2 🔕"],
    ]);
    expect(message?.buttons?.flat().every((b) => Buffer.byteLength(b.data) <= 64)).toBe(true);
    expect(applied).toEqual(["i1", "i2"]);
  });

  it("splits into messages of at most eight items", async () => {
    const h = harness();
    const lines = Array.from({ length: 10 }, (_, i) => line(i + 1, []));
    await sendAlertLines(h.dispatcher, h.store, { title: "Mail", lines, keyBase: "k" });
    expect(h.sent.map((m) => m.buttons?.length)).toEqual([8, 2]);
    expect(h.sent[1]?.text.split("\n")[1]).toBe("9. item 9");
  });

  it("drops muted items silently but still records them", async () => {
    const h = harness();
    const rule = h.store.rules.propose({ match: { source: "mail", domain: "d1.example.com" }, origin: "test" });
    h.store.rules.decide(rule.id, "active", "operator");
    const applied: string[] = [];
    await sendAlertLines(h.dispatcher, h.store, { title: "Mail", lines: [line(1, applied), line(2, applied)], keyBase: "k" });
    expect(h.sent[0]?.text).toBe("Mail\n1. item 2");
    expect(applied.sort()).toEqual(["i1", "i2"]);
  });

  it("keeps lines without feedback as before", async () => {
    const h = harness();
    await sendAlertLines(h.dispatcher, h.store, { title: "X", lines: [{ text: "- plain", apply: () => {} }], keyBase: "k" });
    expect(h.sent[0]).toEqual({ text: "X\n- plain" });
  });
});

describe("feedback buttons", () => {
  function setup() {
    const h = harness();
    const handler = createOperatorHandler({ store: h.store, dispatcher: h.dispatcher, timeZone: TZ, now: () => h.clock.now });
    const item = h.store.feedback.register({
      source: "mail",
      externalId: "m1",
      features: { source: "mail", category: "newsletter", domain: "example.com" },
      label: "Weekly deals",
    });
    return { ...h, handler, item };
  }

  it("records thumbs up and down with a short acknowledgement", async () => {
    const h = setup();
    await h.handler.handle(button(`fb:${h.item.ref}:r`));
    await h.handler.handle(button(`fb:${h.item.ref}:i`));
    expect(h.store.feedback.summary()).toEqual([{ features: h.item.features, relevant: 1, irrelevant: 1 }]);
    expect(h.acks.map((a) => a.note)).toEqual(["Noted: relevant", "Noted: not relevant"]);
  });

  it("proposes a mute rule and activates it only after confirmation", async () => {
    const h = setup();
    await h.handler.handle(button(`fb:${h.item.ref}:m`));
    const proposal = h.sent.at(-1);
    expect(proposal?.text).toBe("Never notify again: mail from example.com?");
    const activate = proposal?.buttons?.[0]?.[0]?.data ?? "";
    expect(h.store.rules.active()).toEqual([]);

    await h.handler.handle(button(activate));
    expect(h.store.rules.active()).toEqual([expect.objectContaining({ match: { source: "mail", domain: "example.com" } })]);
    expect(h.acks.at(-1)?.note).toBe("Rule active");
  });

  it("can reject a proposed rule", async () => {
    const h = setup();
    await h.handler.handle(button(`fb:${h.item.ref}:m`));
    const reject = h.sent.at(-1)?.buttons?.[0]?.[1]?.data ?? "";
    await h.handler.handle(button(reject));
    expect(h.store.rules.active()).toEqual([]);
    expect(h.acks.at(-1)?.note).toBe("Rule dropped");
  });

  it("answers unknown references gracefully", async () => {
    const h = setup();
    await h.handler.handle(button("fb:nope0000:r"));
    expect(h.acks.at(-1)?.note).toBe("Item no longer known");
  });
});
