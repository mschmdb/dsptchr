import {
  afterTrip,
  MAX_SHOPPING_NAME,
  nextShoppingState,
  shoppingKey,
  type ShoppingEvent,
  type ShoppingItem,
  type ShoppingKind,
  type ShoppingState,
} from "@dsptchr/core";
import type { AuditLog } from "./audit.ts";
import type { Db, Row } from "./db.ts";

export interface AddShoppingItem {
  name: string;
  quantity?: string | undefined;
  // Only set when given, so adding a staple again never turns it into a one-off.
  kind?: ShoppingKind | undefined;
  actor: string;
}

// Item names are operator content; the audit log records only IDs, kinds and states.
export function shoppingRepo(db: Db, audit: AuditLog, now: () => number, newId: () => string) {
  const get = (id: string): ShoppingItem | undefined => {
    const row = db.get("SELECT * FROM shopping_items WHERE id = :id", { id });
    return row === undefined ? undefined : toItem(row);
  };

  const mustGet = (id: string): ShoppingItem => {
    const item = get(id);
    if (item === undefined) throw new Error(`shopping item ${id} not found`);
    return item;
  };

  return {
    get,

    add(input: AddShoppingItem): ShoppingItem {
      const name = cleanName(input.name);
      const key = shoppingKey(name);
      return db.transaction(() => {
        const at = now();
        const existing = db.get("SELECT id, state FROM shopping_items WHERE key = :key", { key });
        if (existing !== undefined) {
          const id = String(existing["id"]);
          // An item already in the cart stays checked.
          const state = existing["state"] === "checked" ? "checked" : "needed";
          db.run(
            `UPDATE shopping_items SET state = :state, quantity = COALESCE(:quantity, quantity),
             kind = COALESCE(:kind, kind), updated_at = :at WHERE id = :id`,
            { id, state, quantity: input.quantity, kind: input.kind, at },
          );
          audit.append({ actor: input.actor, event: "shopping.added", subject: id, data: { kind: input.kind ?? null, merged: true } });
          return mustGet(id);
        }
        const id = newId();
        db.run(
          `INSERT INTO shopping_items (id, key, name, quantity, kind, state, created_at, updated_at)
           VALUES (:id, :key, :name, :quantity, :kind, 'needed', :at, :at)`,
          { id, key, name, quantity: input.quantity, kind: input.kind ?? "once", at },
        );
        audit.append({ actor: input.actor, event: "shopping.added", subject: id, data: { kind: input.kind ?? "once", merged: false } });
        return mustGet(id);
      });
    },

    transition(id: string, event: ShoppingEvent, actor: string): ShoppingItem {
      return db.transaction(() => {
        const item = mustGet(id);
        const state = nextShoppingState(item.kind, item.state, event);
        db.run("UPDATE shopping_items SET state = :state, updated_at = :at WHERE id = :id", { id, state, at: now() });
        audit.append({ actor, event: `shopping.${event}`, subject: id, data: { from: item.state, to: state } });
        return mustGet(id);
      });
    },

    // Renames an item or changes its quantity; null clears the quantity.
    edit(id: string, changes: { name?: string | undefined; quantity?: string | null | undefined }, actor: string): ShoppingItem {
      return db.transaction(() => {
        const item = mustGet(id);
        const name = changes.name === undefined ? item.name : cleanName(changes.name);
        const key = shoppingKey(name);
        const clash = db.get("SELECT id FROM shopping_items WHERE key = :key AND id != :id", { key, id });
        if (clash !== undefined) throw new Error(`an item named ${name} is already on the list`);
        const quantity = changes.quantity === undefined ? item.quantity : (changes.quantity ?? undefined);
        db.run("UPDATE shopping_items SET name = :name, key = :key, quantity = :quantity, updated_at = :at WHERE id = :id", {
          id,
          name,
          key,
          quantity,
          at: now(),
        });
        audit.append({ actor, event: "shopping.edited", subject: id });
        return mustGet(id);
      });
    },

    remove(id: string, actor: string): void {
      db.transaction(() => {
        mustGet(id);
        db.run("DELETE FROM shopping_items WHERE id = :id", { id });
        audit.append({ actor, event: "shopping.removed", subject: id });
      });
    },

    // Applies the end of a shopping trip to every checked item in one transaction.
    finishTrip(actor: string): { bought: number; open: number } {
      return db.transaction(() => {
        const at = now();
        let bought = 0;
        for (const item of list()) {
          const next = afterTrip(item.kind, item.state);
          if (next === "keep") continue;
          if (item.state === "checked") bought++;
          if (next === "remove") db.run("DELETE FROM shopping_items WHERE id = :id", { id: item.id });
          else db.run("UPDATE shopping_items SET state = :next, updated_at = :at WHERE id = :id", { id: item.id, next, at });
        }
        const open = list().filter((i) => i.state === "needed").length;
        audit.append({ actor, event: "shopping.trip_finished", data: { bought, open } });
        return { bought, open };
      });
    },

    list,
  };

  function list(): ShoppingItem[] {
    return db.all("SELECT * FROM shopping_items ORDER BY created_at, rowid").map(toItem);
  }
}

function cleanName(raw: string): string {
  const name = raw.normalize("NFC").trim().replace(/\s+/g, " ");
  if (name === "" || name.length > MAX_SHOPPING_NAME) {
    throw new Error(`shopping item name must have 1 to ${MAX_SHOPPING_NAME} characters`);
  }
  return name;
}

export type ShoppingRepo = ReturnType<typeof shoppingRepo>;

function toItem(row: Row): ShoppingItem {
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    quantity: row["quantity"] === null ? undefined : String(row["quantity"]),
    kind: row["kind"] as ShoppingKind,
    state: row["state"] as ShoppingState,
    createdAt: Number(row["created_at"]),
    updatedAt: Number(row["updated_at"]),
  };
}
