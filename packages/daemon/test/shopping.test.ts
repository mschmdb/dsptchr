import { describe, expect, it } from "vitest";
import { createOperatorHandler } from "../src/operator.ts";
import { renderShoppingList, renderStockCheck } from "../src/shopping.ts";
import { button, harness, text, TZ } from "./support/harness.ts";

function setup() {
  const h = harness();
  const handler = createOperatorHandler({ store: h.store, dispatcher: h.dispatcher, timeZone: TZ, now: () => h.clock.now });
  return { ...h, handler };
}

const labels = (buttons: { label: string; data: string }[][] | undefined): string[] =>
  (buttons ?? []).flat().map((b) => b.label);

describe("/einkauf with items", () => {
  it.each(["/einkauf", "/shopping", "/Einkauf@dsptchr_bot"])("%s adds items and confirms them", async (command) => {
    const h = setup();
    await h.handler.handle(text(`${command} Milch, 2 Gurken`));
    expect(h.store.shopping.list()).toMatchObject([
      { name: "Milch", kind: "once", state: "needed" },
      { name: "Gurken", quantity: "2" },
    ]);
    expect(h.sent).toEqual([{ text: "On the list: Milch, Gurken (2)", conversation: "-1002" }]);
    expect(h.store.todos.listActive()).toEqual([]);
  });

  it("names items it could not add", async () => {
    const h = setup();
    await h.handler.handle(text(`/einkauf Milch, ${"x".repeat(61)}`));
    expect(h.store.shopping.list()).toHaveLength(1);
    expect(h.sent[0]?.text).toMatch(/^On the list: Milch\nToo long \(max 60 characters\): x{10}/);
  });

  it("caps one message at 20 items", async () => {
    const h = setup();
    const items = Array.from({ length: 25 }, (_, i) => `Item ${i + 1}`).join(", ");
    await h.handler.handle(text(`/einkauf ${items}`));
    expect(h.store.shopping.list()).toHaveLength(20);
    expect(h.sent[0]?.text).toMatch(/Only the first 20 items were added\.$/);
  });

  it("does not add items twice when the event is redelivered", async () => {
    const h = setup();
    const event = text("/einkauf Milch, Eier");
    await h.handler.handle(event);
    await h.handler.handle(event);
    expect(h.store.shopping.list()).toHaveLength(2);
    expect(h.sent).toHaveLength(1);
  });
});

describe("/einkauf without items", () => {
  it("shows the list with one toggle button per item", async () => {
    const h = setup();
    h.store.shopping.add({ name: "Milch", actor: "test" });
    h.store.shopping.add({ name: "Gurken", quantity: "2", actor: "test" });
    await h.handler.handle(text("/einkauf"));
    expect(h.sent[0]?.text).toBe("Shopping list (2 open)\n☐ Milch\n☐ Gurken (2)");
    expect(labels(h.sent[0]?.buttons)).toEqual(["Milch", "Gurken"]);
  });

  it("says when the list is empty", async () => {
    const h = setup();
    await h.handler.handle(text("/einkauf"));
    expect(h.sent[0]?.text).toMatch(/empty/);
    expect(h.sent[0]?.buttons).toBeUndefined();
  });
});

describe("shopping buttons", () => {
  it("checks an item and redraws the list in place", async () => {
    const h = setup();
    const milk = h.store.shopping.add({ name: "Milch", actor: "test" });
    await h.handler.handle(button(`shop:t:${milk.id}`));
    expect(h.store.shopping.get(milk.id)?.state).toBe("checked");
    expect(h.acks[0]?.note).toBe("Milch ✓");
    expect(h.acks[0]?.replacement?.text).toBe("Shopping list (0 open, 1 in cart)\n✅ Milch");
    expect(labels(h.acks[0]?.replacement?.buttons)).toEqual(["✅ Milch", "Done shopping"]);
  });

  it("unchecks a checked item on a second tap", async () => {
    const h = setup();
    const milk = h.store.shopping.add({ name: "Milch", actor: "test" });
    await h.handler.handle(button(`shop:t:${milk.id}`));
    await h.handler.handle(button(`shop:t:${milk.id}`));
    expect(h.store.shopping.get(milk.id)?.state).toBe("needed");
  });

  it("redraws the list when the item is gone", async () => {
    const h = setup();
    await h.handler.handle(button("shop:t:missing"));
    expect(h.acks[0]).toMatchObject({ note: "No longer on the list", replacement: { text: "Shopping list is empty." } });
  });

  it("finishes the trip", async () => {
    const h = setup();
    const milk = h.store.shopping.add({ name: "Milch", actor: "test" });
    h.store.shopping.add({ name: "Brot", actor: "test" });
    h.store.shopping.transition(milk.id, "check", "test");
    await h.handler.handle(button("shop:done"));
    expect(h.store.shopping.list().map((i) => i.name)).toEqual(["Brot"]);
    expect(h.acks[0]?.replacement).toEqual({ text: "Shopping done: 1 bought, 1 still on the list." });
  });

  it("shows the stock check and puts a used-up staple back on the list", async () => {
    const h = setup();
    const capers = h.store.shopping.add({ name: "Kapern", kind: "empty", actor: "test" });
    h.store.shopping.transition(capers.id, "stock", "test");
    await h.handler.handle(button("shop:stock"));
    expect(h.acks[0]?.replacement?.text).toMatch(/run out/);
    expect(labels(h.acks[0]?.replacement?.buttons)).toEqual(["Kapern", "Back to list"]);

    await h.handler.handle(button(`shop:n:${capers.id}`));
    expect(h.store.shopping.get(capers.id)?.state).toBe("needed");
    expect(h.acks[1]?.note).toBe("Kapern is on the list");
    expect(labels(h.acks[1]?.replacement?.buttons)).toEqual(["Back to list"]);
  });

  it("goes back from the stock check to the list", async () => {
    const h = setup();
    h.store.shopping.add({ name: "Milch", actor: "test" });
    await h.handler.handle(button("shop:list"));
    expect(h.acks[0]?.replacement?.text).toMatch(/^Shopping list \(1 open\)/);
  });

  it("rejects unknown shopping buttons", async () => {
    const h = setup();
    await h.handler.handle(button("shop:x:1"));
    expect(h.acks[0]?.note).toBe("Unknown action");
  });
});

describe("renderShoppingList", () => {
  const item = (n: number, state: "needed" | "checked" | "stocked" = "needed") => ({
    id: `id-${n}`,
    name: `Item ${n}`,
    quantity: undefined,
    kind: "once" as const,
    state,
    createdAt: 0,
    updatedAt: 0,
  });

  it("puts three items per row and stays within Telegram's eight rows", () => {
    const view = renderShoppingList(Array.from({ length: 30 }, (_, i) => item(i + 1, i === 0 ? "checked" : "needed")));
    expect(view.buttons).toHaveLength(8);
    expect(view.buttons?.slice(0, 7).every((row) => row.length === 3)).toBe(true);
    expect(view.text).toMatch(/9 more without a button/);
  });

  it("hides stocked staples and offers the stock check", () => {
    const view = renderShoppingList([{ ...item(1, "stocked"), kind: "empty" }, item(2)]);
    expect(view.text).not.toContain("Item 1");
    expect(labels(view.buttons)).toEqual(["Item 2", "Check stock"]);
  });

  it("lists nothing in the stock check when every staple is needed", () => {
    expect(renderStockCheck([item(1)]).text).toMatch(/Nothing in stock/);
  });
});
