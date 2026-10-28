import type { Button, InboundEvent } from "@dsptchr/channels";
import { MAX_SHOPPING_NAME, parseShoppingInput, type ShoppingEvent, type ShoppingItem } from "@dsptchr/core";
import type { Store } from "@dsptchr/store";
import { ensureNotFailed, type Dispatcher } from "./dispatch.ts";

export interface ShoppingView {
  text: string;
  buttons?: Button[][];
}

// German and English name for the same command, so the operator can use either.
const COMMAND = /^\/(?:einkauf|shopping)(?:@\w+)?(?:\s+([\s\S]*))?$/i;
const BUTTON = /^shop:(?:(t|n):([^:]{1,64})|(done|stock|list))$/;
const MAX_ITEMS_PER_MESSAGE = 20;
const PER_ROW = 3;
// Telegram allows eight rows; one stays free for the control buttons.
const MAX_ITEM_BUTTONS = 7 * PER_ROW;
const MAX_LINES = 60;
const MAX_SHOWN = 30;

// "/einkauf Milch, Eier" -> "Milch, Eier"; "/einkauf" -> ""; anything else -> undefined.
export function parseShoppingCommand(text: string): string | undefined {
  const match = COMMAND.exec(text.trim());
  return match === null ? undefined : (match[1] ?? "").trim();
}

const display = (name: string, quantity: string | undefined): string => (quantity === undefined ? name : `${name} (${quantity})`);
const onList = (item: ShoppingItem): boolean => item.state !== "stocked";
const shorten = (text: string): string => (text.length <= MAX_SHOWN ? text : `${text.slice(0, MAX_SHOWN - 1)}…`);

function rows(buttons: Button[]): Button[][] {
  const result: Button[][] = [];
  for (let i = 0; i < buttons.length; i += PER_ROW) result.push(buttons.slice(i, i + PER_ROW));
  return result;
}

function capped(lines: string[]): string[] {
  return lines.length <= MAX_LINES ? lines : [...lines.slice(0, MAX_LINES), `… and ${lines.length - MAX_LINES} more`];
}

export function renderShoppingList(items: readonly ShoppingItem[]): ShoppingView {
  const shown = items.filter(onList);
  const hasStock = items.some((i) => i.state === "stocked");
  const stockButton: Button = { label: "Check stock", data: "shop:stock" };
  if (shown.length === 0) {
    return hasStock ? { text: "Shopping list is empty.", buttons: [[stockButton]] } : { text: "Shopping list is empty." };
  }
  const open = shown.filter((i) => i.state === "needed").length;
  const inCart = shown.length - open;
  const header = `Shopping list (${open} open${inCart === 0 ? "" : `, ${inCart} in cart`})`;
  const lines = shown.map((i) => `${i.state === "checked" ? "✅" : "☐"} ${display(i.name, i.quantity)}`);
  const overflow = shown.length - MAX_ITEM_BUTTONS;
  const itemButtons = shown
    .slice(0, MAX_ITEM_BUTTONS)
    .map((i) => ({ label: `${i.state === "checked" ? "✅ " : ""}${i.name}`, data: `shop:t:${i.id}` }));
  const controls: Button[] = [
    ...(inCart > 0 ? [{ label: "Done shopping", data: "shop:done" }] : []),
    ...(hasStock ? [stockButton] : []),
  ];
  return {
    text: [header, ...capped(lines), ...(overflow > 0 ? [`${overflow} more without a button.`] : [])].join("\n"),
    buttons: [...rows(itemButtons), ...(controls.length === 0 ? [] : [controls])],
  };
}

export function renderStockCheck(items: readonly ShoppingItem[]): ShoppingView {
  const stocked = items.filter((i) => i.state === "stocked");
  const back: Button[] = [{ label: "Back to list", data: "shop:list" }];
  if (stocked.length === 0) return { text: "Nothing in stock to check.", buttons: [back] };
  const itemButtons = stocked.slice(0, MAX_ITEM_BUTTONS).map((i) => ({ label: i.name, data: `shop:n:${i.id}` }));
  return {
    text: ["Tap what has run out. It goes back on the list.", ...capped(stocked.map((i) => `- ${i.name}`))].join("\n"),
    buttons: [...rows(itemButtons), back],
  };
}

export interface ShoppingHandlerDeps {
  store: Store;
  dispatcher: Dispatcher;
  actor: string;
}

type ButtonEvent = Extract<InboundEvent, { kind: "button" }>;
type TextEvent = Extract<InboundEvent, { kind: "text" }>;

// Operator commands and buttons for the shopping list. Every change goes through the dispatcher.
export function createShoppingHandler({ store, dispatcher, actor }: ShoppingHandlerDeps) {
  const send = async (event: TextEvent, view: ShoppingView) =>
    ensureNotFailed(
      await dispatcher.dispatch({
        type: "message.send",
        payload: { text: view.text, conversation: event.conversation, ...(view.buttons === undefined ? {} : { buttons: view.buttons }) },
        idempotencyKey: `${event.id}:reply`,
        actor,
      }),
    );

  const acknowledge = async (event: ButtonEvent, note: string, view: ShoppingView) =>
    ensureNotFailed(
      await dispatcher.dispatch({
        type: "message.ack",
        payload: {
          conversation: event.conversation,
          messageRef: event.messageRef,
          callbackRef: event.callbackRef,
          note: shorten(note),
          replacement: view,
        },
        idempotencyKey: `${event.id}:ack`,
        actor,
      }),
    );

  const update = async (event: ButtonEvent, itemId: string, change: ShoppingEvent) =>
    ensureNotFailed(
      await dispatcher.dispatch({
        type: "shopping.update",
        payload: { itemId, event: change },
        idempotencyKey: `${event.id}:shopping.update`,
        actor,
      }),
    );

  async function add(event: TextEvent, args: string): Promise<void> {
    const { items, rejected } = parseShoppingInput(args);
    const added: string[] = [];
    for (const [index, item] of items.slice(0, MAX_ITEMS_PER_MESSAGE).entries()) {
      const action = ensureNotFailed(
        await dispatcher.dispatch({
          type: "shopping.add",
          payload: item.quantity === undefined ? { name: item.name } : { name: item.name, quantity: item.quantity },
          idempotencyKey: `${event.id}:shopping.add:${index}`,
          actor,
        }),
      );
      if (action.state === "executed") added.push(display(item.name, item.quantity));
    }
    const lines = [
      added.length === 0 ? "Nothing added." : `On the list: ${added.join(", ")}`,
      ...(rejected.length === 0 ? [] : [`Too long (max ${MAX_SHOPPING_NAME} characters): ${rejected.map(shorten).join(", ")}`]),
      ...(items.length > MAX_ITEMS_PER_MESSAGE ? [`Only the first ${MAX_ITEMS_PER_MESSAGE} items were added.`] : []),
    ];
    await send(event, { text: lines.join("\n") });
  }

  return {
    async command(event: TextEvent, args: string): Promise<void> {
      if (args === "") {
        await send(event, renderShoppingList(store.shopping.list()));
        return;
      }
      await add(event, args);
    },

    async button(event: ButtonEvent): Promise<void> {
      const match = BUTTON.exec(event.data);
      if (match === null) {
        store.audit.append({ actor, event: "operator.unknown_button" });
        await acknowledge(event, "Unknown action", renderShoppingList(store.shopping.list()));
        return;
      }
      const [, kind, itemId = "", control] = match;
      if (control !== undefined) return controlButton(event, control);

      const item = store.shopping.get(itemId);
      if (item === undefined) {
        await acknowledge(event, "No longer on the list", renderShoppingList(store.shopping.list()));
        return;
      }
      if (kind === "n") {
        if (item.state === "stocked") await update(event, item.id, "need");
        await acknowledge(event, `${item.name} is on the list`, renderStockCheck(store.shopping.list()));
        return;
      }
      const checking = item.state !== "checked";
      if (item.state !== "stocked") await update(event, item.id, checking ? "check" : "uncheck");
      await acknowledge(event, checking ? `${item.name} ✓` : `${item.name} back on the list`, renderShoppingList(store.shopping.list()));
    },
  };

  async function controlButton(event: ButtonEvent, control: string): Promise<void> {
    if (control === "stock") {
      await acknowledge(event, "Stock check", renderStockCheck(store.shopping.list()));
      return;
    }
    if (control === "list") {
      await acknowledge(event, "Shopping list", renderShoppingList(store.shopping.list()));
      return;
    }
    const action = ensureNotFailed(
      await dispatcher.dispatch({ type: "shopping.finish", payload: {}, idempotencyKey: `${event.id}:shopping.finish`, actor }),
    );
    const result = action.result as { bought?: number; open?: number } | undefined;
    const text =
      action.state === "executed"
        ? `Shopping done: ${result?.bought ?? 0} bought, ${result?.open ?? 0} still on the list.`
        : "Shopping not finished: action not allowed right now.";
    await acknowledge(event, "Shopping done", { text });
  }
}
