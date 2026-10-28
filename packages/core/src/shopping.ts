// once: a one-off item, gone after the trip. every: a staple bought on every trip.
// empty: a staple bought only after the operator reports it as used up.
export const SHOPPING_KINDS = ["once", "every", "empty"] as const;
export type ShoppingKind = (typeof SHOPPING_KINDS)[number];

export const SHOPPING_STATES = ["needed", "checked", "stocked"] as const;
export type ShoppingState = (typeof SHOPPING_STATES)[number];

export type ShoppingEvent = "check" | "uncheck" | "need" | "stock";

export const MAX_SHOPPING_NAME = 60;
export const MAX_SHOPPING_QUANTITY = 20;

export interface ShoppingItem {
  id: string;
  name: string;
  quantity: string | undefined;
  kind: ShoppingKind;
  state: ShoppingState;
  createdAt: number;
  updatedAt: number;
}

export class ShoppingTransitionError extends Error {
  override name = "ShoppingTransitionError";
}

const TRANSITIONS: Record<ShoppingState, Partial<Record<ShoppingEvent, ShoppingState>>> = {
  needed: { check: "checked", need: "needed", stock: "stocked" },
  checked: { uncheck: "needed" },
  stocked: { need: "needed" },
};

export function nextShoppingState(kind: ShoppingKind, from: ShoppingState, event: ShoppingEvent): ShoppingState {
  const to = TRANSITIONS[from][event];
  // A one-off item has no stock to return to; it is removed instead.
  if (to === undefined || (kind === "once" && to === "stocked")) {
    throw new ShoppingTransitionError(`${kind} item cannot ${event} from ${from}`);
  }
  return to;
}

// What finishing a trip does to one item.
export function afterTrip(kind: ShoppingKind, state: ShoppingState): ShoppingState | "remove" | "keep" {
  // An every-trip staple marked as in stock skipped one trip only.
  if (kind === "every" && state === "stocked") return "needed";
  if (state !== "checked") return "keep";
  if (kind === "once") return "remove";
  return kind === "every" ? "needed" : "stocked";
}

export function shoppingKey(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

export interface ParsedShoppingItem {
  name: string;
  quantity?: string;
}

const QUANTITY = /^(\d+(?:[.,]\d+)?\s*(?:x|×|g|kg|ml|l|stk\.?|pck\.?)?)\s+(\S.*)$/i;

// "Milch, 2 Gurken, 1,5 l Saft" -> items. A comma between digits is a decimal comma.
// Overlong names and quantities are rejected, not cut.
export function parseShoppingInput(text: string): { items: ParsedShoppingItem[]; rejected: string[] } {
  const items: ParsedShoppingItem[] = [];
  const rejected: string[] = [];
  for (const part of text.split(/(?<!\d),|,(?!\d)|[;\n]/)) {
    const clean = part.trim().replace(/\s+/g, " ");
    if (clean === "") continue;
    const match = QUANTITY.exec(clean);
    const item: ParsedShoppingItem =
      match === null ? { name: clean } : { name: match[2] ?? clean, quantity: (match[1] ?? "").trim() };
    if (item.name.length > MAX_SHOPPING_NAME || (item.quantity?.length ?? 0) > MAX_SHOPPING_QUANTITY) rejected.push(clean);
    else items.push(item);
  }
  return { items, rejected };
}
