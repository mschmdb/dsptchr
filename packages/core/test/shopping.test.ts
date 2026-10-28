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
  it("splits on commas, semicolons and line breaks", () => {
    expect(parseShoppingInput("Milch, Eier; Backpapier\nKapern").items.map((i) => i.name)).toEqual([
      "Milch",
      "Eier",
      "Backpapier",
      "Kapern",
    ]);
  });

  it("reads a leading quantity with an optional unit", () => {
    expect(parseShoppingInput("2 Gurken, 500 g Hack, 4x Skyr, 1,5 l Milch").items).toEqual([
      { name: "Gurken", quantity: "2" },
      { name: "Hack", quantity: "500 g" },
      { name: "Skyr", quantity: "4x" },
      { name: "Milch", quantity: "1,5 l" },
    ]);
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
});
