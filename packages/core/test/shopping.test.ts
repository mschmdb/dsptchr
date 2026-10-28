import { describe, expect, it } from "vitest";
import {
  afterTrip,
  nextShoppingState,
  parseShoppingInput,
  shoppingKey,
  ShoppingTransitionError,
  type ShoppingEvent,
  type ShoppingKind,
  type ShoppingState,
} from "../src/shopping.ts";

describe("parseShoppingInput", () => {
  it("splits a single line on commas and semicolons", () => {
    expect(parseShoppingInput("Milch, Eier; Backpapier").items.map((i) => i.name)).toEqual(["Milch", "Eier", "Backpapier"]);
  });

  it("reads a leading quantity with an optional unit", () => {
    expect(parseShoppingInput("2 Gurken, 500 g Hack, 4x Skyr, 1,5 l Milch").items).toEqual([
      { name: "Gurken", quantity: "2" },
      { name: "Hack", quantity: "500 g" },
      { name: "Skyr", quantity: "4x" },
      { name: "Milch", quantity: "1,5 l" },
    ]);
  });

  it("splits multi-line input only at line breaks, so commas stay inside an item", () => {
    expect(parseShoppingInput("800 g Hähnchen\n\n- 2 Dosen weiße Bohnen, etwa 480 g\n- rotwein").items).toEqual([
      { name: "Hähnchen", quantity: "800 g" },
      { name: "weiße Bohnen, etwa 480 g", quantity: "2 Dosen" },
      { name: "rotwein" },
    ]);
  });

  it.each(["- Milch", "* Milch", "• Milch", "– Milch", "1. Milch", "2) Milch", "[ ] Milch", "- [x] Milch"])(
    "strips the list marker in %j",
    (line) => {
      expect(parseShoppingInput(`${line}\nEier`).items[0]).toEqual({ name: "Milch" });
    },
  );

  it("reads packaging words as part of the quantity", () => {
    expect(parseShoppingInput("1 Packung Asia-Gemüse, 2 Dosen Kokosmilch, 1 Bund Petersilie").items).toEqual([
      { name: "Asia-Gemüse", quantity: "1 Packung" },
      { name: "Kokosmilch", quantity: "2 Dosen" },
      { name: "Petersilie", quantity: "1 Bund" },
    ]);
  });

  it("splits a comma before a number when no digit precedes it", () => {
    expect(parseShoppingInput("Milch,2 Gurken").items).toEqual([{ name: "Milch" }, { name: "Gurken", quantity: "2" }]);
  });

  it("rejects quantities longer than 20 characters", () => {
    const text = `${"1".repeat(21)} Milch`;
    expect(parseShoppingInput(text)).toEqual({ items: [], rejected: [text] });
  });

  it("keeps a number that is part of the name when nothing follows it", () => {
    expect(parseShoppingInput("7up").items).toEqual([{ name: "7up" }]);
    expect(parseShoppingInput("42").items).toEqual([{ name: "42" }]);
  });

  it("drops empty parts and collapses whitespace", () => {
    expect(parseShoppingInput(" , Milch ,,  rote   Zwiebeln ,").items).toEqual([{ name: "Milch" }, { name: "rote Zwiebeln" }]);
  });

  it("rejects names longer than 60 characters instead of truncating them", () => {
    const long = "x".repeat(61);
    const result = parseShoppingInput(`Milch, ${long}`);
    expect(result.items).toEqual([{ name: "Milch" }]);
    expect(result.rejected).toEqual([long]);
  });

  it("returns nothing for empty input", () => {
    expect(parseShoppingInput("   ")).toEqual({ items: [], rejected: [] });
  });
});

describe("shoppingKey", () => {
  it("matches names regardless of case and spacing", () => {
    expect(shoppingKey("  Rote  Zwiebeln ")).toBe(shoppingKey("rote zwiebeln"));
  });

  it("normalizes Unicode so composed and decomposed umlauts match", () => {
    expect(shoppingKey("Möhren")).toBe(shoppingKey("Möhren"));
  });
});

describe("nextShoppingState", () => {
  const allowed: [ShoppingKind, ShoppingState, ShoppingEvent, ShoppingState][] = [
    ["once", "needed", "check", "checked"],
    ["once", "checked", "uncheck", "needed"],
    ["every", "needed", "check", "checked"],
    ["empty", "stocked", "need", "needed"],
    ["empty", "needed", "stock", "stocked"],
    ["every", "needed", "stock", "stocked"],
    ["every", "stocked", "need", "needed"],
    ["once", "needed", "need", "needed"],
  ];

  it.each(allowed)("%s: %s + %s -> %s", (kind, from, event, to) => {
    expect(nextShoppingState(kind, from, event)).toBe(to);
  });

  const forbidden: [ShoppingKind, ShoppingState, ShoppingEvent][] = [
    ["once", "needed", "stock"],
    ["once", "needed", "uncheck"],
    ["empty", "stocked", "check"],
    ["empty", "checked", "stock"],
  ];

  it.each(forbidden)("%s: %s + %s is rejected", (kind, from, event) => {
    expect(() => nextShoppingState(kind, from, event)).toThrow(ShoppingTransitionError);
  });
});

describe("afterTrip", () => {
  it("removes bought one-off items and returns staples to their rhythm", () => {
    expect(afterTrip("once", "checked")).toBe("remove");
    expect(afterTrip("every", "checked")).toBe("needed");
    expect(afterTrip("empty", "checked")).toBe("stocked");
  });

  it("leaves items that were not bought unchanged", () => {
    expect(afterTrip("once", "needed")).toBe("keep");
    expect(afterTrip("empty", "stocked")).toBe("keep");
    expect(afterTrip("every", "needed")).toBe("keep");
  });

  it("puts an every-trip staple skipped this time back on the list", () => {
    expect(afterTrip("every", "stocked")).toBe("needed");
  });
});
