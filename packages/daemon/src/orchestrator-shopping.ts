import { ToolInputError, type OrchestratorTools } from "@dsptchr/agents";
import { MAX_SHOPPING_NAME, nextShoppingState, shoppingKey, ShoppingTransitionError } from "@dsptchr/core";
import type { Store, StoredAction } from "@dsptchr/store";

export interface ShoppingToolDeps {
  store: Store;
  limitReached(): boolean;
  // Dispatches without counting; each tool call records one write for its whole batch.
  dispatch(type: string, payload: unknown): Promise<StoredAction>;
  record(summary: string): void;
}

type Change = Parameters<OrchestratorTools["update_shopping_items"]>[0]["changes"][number];

// Shopping items only touch the local list and are easy to undo, so one call counts as one
// change of the per-message limit, however many items it covers.
export function shoppingTools({ store, limitReached, dispatch, record }: ShoppingToolDeps) {
  const checkLimit = (): void => {
    if (limitReached()) throw new ToolInputError("limit of changes per message reached");
  };

  // Runs the dispatches in order and records a receipt for what completed, even on failure.
  async function run(
    steps: { payload: unknown; done: string }[],
    type: string,
    receipt: (done: string[]) => string,
  ): Promise<{ done: string[]; complete: boolean }> {
    const done: string[] = [];
    try {
      for (const step of steps) {
        const action = await dispatch(type, step.payload);
        if (action.state !== "executed") return { done, complete: false };
        done.push(step.done);
      }
      return { done, complete: true };
    } finally {
      if (done.length > 0) record(receipt(done));
    }
  }

  return {
    async add_to_shopping_list({ items }: Parameters<OrchestratorTools["add_to_shopping_list"]>[0]): Promise<string> {
      checkLimit();
      const steps = items.map((item) => {
        const quantity = item.quantity ?? undefined;
        return {
          payload: {
            name: item.name,
            ...(quantity === undefined ? {} : { quantity }),
            ...(item.kind === null || item.kind === undefined ? {} : { kind: item.kind }),
          },
          done: quantity === undefined ? item.name : `${item.name} (${quantity})`,
        };
      });
      const { done, complete } = await run(steps, "shopping.add", (d) => `Added to the shopping list: ${d.join(", ")}.`);
      if (done.length === 0) return "Not allowed right now.";
      return complete ? "Added." : `Added ${done.length} of ${items.length}; the rest was not allowed right now.`;
    },

    async update_shopping_items({ changes }: Parameters<OrchestratorTools["update_shopping_items"]>[0]): Promise<string> {
      checkLimit();
      // Removals first, so a rename onto the name of a removed item never clashes.
      const steps = validate(store, changes).sort((a, b) => Number(b.remove) - Number(a.remove));
      const { done, complete } = await run(steps, "shopping.update", (d) => `Shopping list: ${d.join("; ")}.`);
      if (done.length === 0) return "Not allowed right now.";
      return complete ? "Done." : `Done ${done.length} of ${changes.length}; the rest was not allowed right now.`;
    },
  };
}

// Checks the whole batch before anything changes, so an invalid entry never leaves half a cleanup.
function validate(store: Store, changes: Change[]): { payload: unknown; done: string; remove: boolean }[] {
  const seen = new Set<string>();
  const removed = new Set(changes.filter((c) => c.action === "remove").map((c) => c.item_id));
  const newKeys = new Map<string, string>();
  return changes.map((change) => {
    const item = store.shopping.get(change.item_id);
    if (item === undefined) throw new ToolInputError(`shopping item ${change.item_id} not found`);
    if (seen.has(item.id)) throw new ToolInputError(`item ${item.id} appears twice; change each item at most once per call`);
    seen.add(item.id);

    if (change.action === "edit") {
      const name = change.name ?? undefined;
      const quantity = change.quantity === undefined || change.quantity === null ? undefined : change.quantity === "" ? null : change.quantity;
      if (name === undefined && quantity === undefined) throw new ToolInputError(`edit of ${item.id} needs name or quantity`);
      if (name !== undefined) {
        if (name.normalize("NFC").trim().length > MAX_SHOPPING_NAME) throw new ToolInputError(`name of ${item.id} is too long`);
        const key = shoppingKey(name);
        const clash = store.shopping.list().find((other) => other.id !== item.id && shoppingKey(other.name) === key && !removed.has(other.id));
        if (clash !== undefined || (newKeys.has(key) && newKeys.get(key) !== item.id)) {
          throw new ToolInputError(`another item is already named ${name}; remove one of them in this call or pick another name`);
        }
        newKeys.set(key, item.id);
      }
      const shown = name ?? item.name;
      return {
        payload: { itemId: item.id, event: "edit", ...(name === undefined ? {} : { name }), ...(quantity === undefined ? {} : { quantity }) },
        remove: false,
        done: `"${item.name}" is now "${quantity === null || (quantity === undefined && item.quantity === undefined) ? shown : `${shown} (${quantity ?? item.quantity})`}"`,
      };
    }
    if ((change.name ?? null) !== null || (change.quantity ?? null) !== null) {
      throw new ToolInputError("name and quantity are only allowed with edit");
    }
    if (change.action !== "remove") {
      if (change.action === "stock" && item.kind === "once") {
        throw new ToolInputError("a one-off item cannot be in stock; remove it instead");
      }
      try {
        nextShoppingState(item.kind, item.state, change.action);
      } catch (error) {
        if (error instanceof ShoppingTransitionError) throw new ToolInputError(error.message);
        throw error;
      }
    }
    const done = {
      check: `checked "${item.name}"`,
      uncheck: `"${item.name}" back on the list`,
      need: `"${item.name}" on the list`,
      stock: `"${item.name}" in stock`,
      remove: `removed "${item.name}"`,
    }[change.action];
    return { payload: { itemId: item.id, event: change.action }, done, remove: change.action === "remove" };
  });
}
