# Architecture

One codebase, one daemon per machine, instances configured outside the repo.

## Flow

```
Watcher ──► Reader ──► Orchestrator ──► Gate ──────────► Executor
(code)      (model,    (model,          (policy,          (code)
             no tools)  proposal tools)  classifier,
                                         operator button)
   │                         ▲                               │
   └──── Store ◄─────────────┴──────── Audit log ◄───────────┘
           ▲
   Operator input: Telegram, todo mail
```

## Binding rules

- **AR-1** The orchestrator agent has no shell, file system or network tools. Its only tools are in-process tools that write proposals to the store or read state.
- **AR-2** Readers are single tool-less model calls with schema-validated output. Free text derived from untrusted input carries the label `untrusted` and is never copied into arguments of external actions.
- **AR-3** Only the updater is a full agent. It runs sandboxed in a git worktree, with a network allowlist, a token limited to contents and pull requests, and no push to the default branch. It refuses this repository as a target.
- **AR-4** Every external effect goes through gate → executor. The executor is deterministic code with one narrow function per action type. Sole exception: the content-free heartbeat (D-39).
- **AR-5** Deduplication, scheduling, reminders and rate limits are code, never model judgment.
- **AR-6** Rules change only through operator approval. Feedback is stored as events; a nightly run proposes rule changes.
- **AR-7** Instance data (config, rules, state, secrets) never lives in the repo.
- **AR-8** Channels are adapters. No module outside `channels` knows a messenger.
- **AR-9** Model authentication is configurable per instance: API key (default, from a dedicated Console workspace with spend limit) or plan login. Switching is a config change.

## Operator input

Channel → inbox (SQLite) → operator handler → dispatcher. Free text goes through the orchestrator (D-43); `stop`/`start` and `/` commands stay deterministic. The channel confirms events only after the inbox stored them. Handlers run from the inbox with retries; events that keep failing end as `dead` and the operator is told.

## Packages (pnpm workspace)

| Package | Responsibility |
|---|---|
| `core` | Types, Zod schemas, state machines for items, actions, todos |
| `store` | SQLite access, migrations, append-only audit log |
| `watchers` | Source pollers with cursors; each emits normalized items |
| `agents` | Role prompts (Markdown) and output schemas: reader, orchestrator, updater, knowledge, dream |
| `gate` | Policy evaluation, rate limits, budget, classifier, draft-hash approvals (protected) |
| `executor` | Action implementations (protected) |
| `channels` | Telegram (long polling, buttons) |
| `mailbox` | Inter-instance mailbox service and client (Phase 4) |
| `daemon` | Scheduler, wake catch-up, heartbeat, budget stop, wiring |

## State machines

Item: `new → read → proposed → waiting → done | rejected | discarded | expired`

Action: `proposed → approved | needs_operator | denied → executed | failed`. Each action has an idempotency key and a retry counter.

Todo: `open → snoozed → open … → done | dropped`.

## Instance directory

```
~/.config/dsptchr/<instance>/
  instance.yaml  timezone, channel IDs
  role.md        role and tone
  sources.yaml   watchers, intervals, repository allowlist with levels
  policy.yaml    autonomy levels, rate limits, budget
  rules/         learned rules, changed only via approval
  state.db
  secrets.yaml   macOS Keychain references only, no secret values
```

Do not depend on a password-manager SSH or secret agent that locks with the screen; unattended runs fail when the machine is locked.

## Models

| Role | Model | Notes |
|---|---|---|
| Reader | Haiku | no tools, structured output |
| Classifier | Haiku | prompt differs from the orchestrator's |
| Orchestrator | Sonnet (Messages API, manual tool loop, D-42) | prompt caching for role and rules |
| Updater | Sonnet, Opus for hard cases | code runs never below Sonnet |
| Dream | Sonnet via Batch API | nightly, 50 % cheaper |

## Scheduling

- Watchers every 10–15 minutes (configurable per source).
- Orchestrator runs batched, at most hourly inside configured hours; urgent items trigger immediately.
- Briefings at configured times. Reminders fire from the scheduler without a model call.
- On wake, watchers catch up from their cursors; missed briefings run once.

## Inter-instance mailbox (Phase 4)

HTTP service on the always-on machine, reached over a private network. Each instance has its own token. Message types: `request`, `response`, `hint` (with expiry). Fields: `id, context_id, from, to, type, status, payload_json, artifact_refs, expires_at, created_at, trace_id`. The service validates schema, direction and length and rejects URLs and mail addresses. Hints are context, never commands.
