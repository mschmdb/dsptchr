import { createHash } from "node:crypto";
import type { Button, InboundEvent } from "@dsptchr/channels";
import { MAX_SHOPPING_NAME, MAX_SHOPPING_QUANTITY, parseShoppingInput, type ShoppingEvent, type ShoppingItem } from "@dsptchr/core";
import type { Store } from "@dsptchr/store";
import { ensureNotFailed, type Dispatcher } from "./dispatch.ts";

export interface ShoppingView {
  text: string;
  buttons?: Button[][];
}

// German and English name for the same command, so the operator can use either.
const COMMAND = /^\/(?:einkauf|shopping)(?:@\w+)?(?:\s+([\s\S]*))?$/i;
// t: toggle item, n: staple needed again (both carry the page to redraw),
// l: list page, s: stock check page, done: finish the trip.
const BUTTON = /^shop:(?:(t|n):([^:]{1,40}):(\d{1,3})|(l|s):(\d{1,3})|(done))$/;
const MAX_ITEMS_PER_MESSAGE = 20;
const PER_ROW = 3;
// Telegram allows eight rows; one stays free for the control buttons. With names of at most
// 60 and quantities of at most 20 characters, one page stays far below 4,096 characters.
const PAGE_SIZE = 7 * PER_ROW;
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

// One page of items plus the navigation buttons for it; the page is clamped to what exists.
function paginate<T>(all: readonly T[], requested: number, data: (page: number) => string) {
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const page = Math.min(Math.max(0, requested), pages - 1);
  const nav: Button[] = [
    ...(page > 0 ? [{ label: "‹ Back", data: data(page - 1) }] : []),
    ...(page < pages - 1 ? [{ label: "More ›", data: data(page + 1) }] : []),
  ];
  return { slice: all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), page, suffix: pages > 1 ? `, page ${page + 1}/${pages}` : "", nav };
}

export function renderShoppingList(items: readonly ShoppingItem[], requestedPage = 0): ShoppingView {
  const shown = items.filter(onList);
  const hasStock = items.some((i) => i.state === "stocked");
  const stockButton: Button = { label: "Check stock", data: "shop:s:0" };
  if (shown.length === 0) {
    return hasStock ? { text: "Shopping list is empty.", buttons: [[stockButton]] } : { text: "Shopping list is empty." };
  }
  const open = shown.filter((i) => i.state === "needed").length;
  const inCart = shown.length - open;
  const { slice, page, suffix, nav } = paginate(shown, requestedPage, (p) => `shop:l:${p}`);
  const header = `Shopping list (${open} open${inCart === 0 ? "" : `, ${inCart} in cart`}${suffix})`;
  const lines = slice.map((i) => `${i.state === "checked" ? "✅" : "☐"} ${display(i.name, i.quantity)}`);
  const itemButtons = slice.map((i) => ({ label: `${i.state === "checked" ? "✅ " : ""}${i.name}`, data: `shop:t:${i.id}:${page}` }));
  const controls: Button[] = [
    ...nav,
    ...(inCart > 0 ? [{ label: "Done shopping", data: "shop:done" }] : []),
    ...(hasStock ? [stockButton] : []),
  ];
  return {
    text: [header, ...lines].join("\n"),
    buttons: [...rows(itemButtons), ...(controls.length === 0 ? [] : [controls])],
  };
}

export function renderStockCheck(items: readonly ShoppingItem[], requestedPage = 0): ShoppingView {
  const stocked = items.filter((i) => i.state === "stocked");
  const back: Button = { label: "Back to list", data: "shop:l:0" };
  if (stocked.length === 0) return { text: "Nothing in stock to check.", buttons: [[back]] };
  const { slice, page, suffix, nav } = paginate(stocked, requestedPage, (p) => `shop:s:${p}`);
  const itemButtons = slice.map((i) => ({ label: i.name, data: `shop:n:${i.id}:${page}` }));
  return {
    text: [`Tap what has run out. It goes back on the list.${suffix === "" ? "" : ` (${suffix.slice(2)})`}`, ...slice.map((i) => `- ${i.name}`)].join("\n"),
    buttons: [...rows(itemButtons), [...nav, back]],
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
        // A retry after a failed ack redraws the current list; keying by content keeps a
        // stale view from an earlier attempt from being sent again.
        idempotencyKey: `${event.id}:ack:${createHash("sha256").update(JSON.stringify([note, view])).digest("hex").slice(0, 16)}`,
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
      ...(rejected.length === 0 ? [] : [`Too long (name max ${MAX_SHOPPING_NAME}, amount max ${MAX_SHOPPING_QUANTITY} characters): ${rejected.map(shorten).join(", ")}`]),
      ...(items.length > MAX_ITEMS_PER_MESSAGE ? [`Only the first ${MAX_ITEMS_PER_MESSAGE} items were processed.`] : []),
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
      const [, kind, itemId = "", itemPage, view, viewPage, done] = match;
      if (done !== undefined) return finish(event);
      if (view !== undefined) {
        const page = Number(viewPage);
        await (view === "s"
          ? acknowledge(event, "Stock check", renderStockCheck(store.shopping.list(), page))
          : acknowledge(event, "Shopping list", renderShoppingList(store.shopping.list(), page)));
        return;
      }

      const page = Number(itemPage);
      const redraw = (): ShoppingView =>
        kind === "n" ? renderStockCheck(store.shopping.list(), page) : renderShoppingList(store.shopping.list(), page);
      const item = store.shopping.get(itemId);
      const change: ShoppingEvent | undefined =
        item === undefined ? undefined
        : kind === "n" ? (item.state === "stocked" ? "need" : undefined)
        : item.state === "needed" ? "check"
        : item.state === "checked" ? "uncheck"
        : undefined;
      if (item === undefined || change === undefined) {
        await acknowledge(event, kind === "n" && item !== undefined ? `${item.name} is on the list` : "No longer on the list", redraw());
        return;
      }
      const action = await update(event, item.id, change);
      // On a retry the stored action holds the change that really ran, not the one derived from today's state.
      const ran = (action.payload as { event?: ShoppingEvent }).event;
      const note =
        action.state !== "executed" ? "Not allowed right now"
        : ran === "check" ? `${item.name} ✓`
        : ran === "uncheck" ? `${item.name} back on the list`
        : `${item.name} is on the list`;
      await acknowledge(event, note, redraw());
    },
  };

  async function finish(event: ButtonEvent): Promise<void> {
    const action = ensureNotFailed(
      await dispatcher.dispatch({ type: "shopping.finish", payload: {}, idempotencyKey: `${event.id}:shopping.finish`, actor }),
    );
    if (action.state !== "executed") {
      await acknowledge(event, "Not allowed right now", renderShoppingList(store.shopping.list()));
      return;
    }
    const result = action.result as { bought?: number; open?: number } | undefined;
    await acknowledge(event, "Shopping done", {
      text: `Shopping done: ${result?.bought ?? 0} bought, ${result?.open ?? 0} still on the list.`,
    });
  }
}
