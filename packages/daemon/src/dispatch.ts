import type { Executor } from "@dsptchr/executor";
import { draftHash, evaluate, type Policy } from "@dsptchr/gate";
import type { Store, StoredAction } from "@dsptchr/store";

export interface DispatchInput {
  type: string;
  payload: unknown;
  idempotencyKey: string;
  actor: string;
}

export interface Dispatcher {
  dispatch(input: DispatchInput): Promise<StoredAction>;
}

export interface DispatcherDeps {
  store: Store;
  executor: Executor;
  policy: Policy;
  now: () => number;
}

// The only path from a proposal to an external effect: store -> gate -> executor (AR-4).
export function createDispatcher({ store, executor, policy, now }: DispatcherDeps): Dispatcher {
  return {
    async dispatch(input) {
      const { action, created } = store.actions.propose({
        type: input.type,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
        draftHash: draftHash({ type: input.type, payload: input.payload }),
        actor: input.actor,
      });
      if (!created) {
        return action.state === "approved" ? executor.execute(action.id) : action;
      }

      const result = evaluate(
        { type: action.type, payload: action.payload },
        {
          policy,
          paused: store.flags.isPaused(),
          now: now(),
          countApprovedSince: (type, since) => store.actions.countApprovedSince(type, since),
        },
      );
      const event = result.decision === "approve" ? "approve" : result.decision === "deny" ? "deny" : "ask_operator";
      const gated = store.actions.transition(action.id, event, { actor: "gate", reason: result.reason });
      return gated.state === "approved" ? executor.execute(gated.id) : gated;
    },
  };
}
