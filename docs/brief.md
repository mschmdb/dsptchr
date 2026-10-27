# Brief

## Problem

One person juggles mail, calendars, todos, code repositories, servers and work tools. The information is spread over many apps, most of it is noise, and routine work (dependency updates, triage, reminders) eats time.

## Goal

A proactive orchestrator per life context (for example "private" and "work") that:

- watches configured sources and reports only what is new or changed
- filters noise and learns from the operator's feedback
- handles routine work itself within explicit autonomy levels
- asks the operator before anything sensitive or irreversible
- delegates bigger tasks to sandboxed subagents
- exchanges results and "you should know" hints with the other instance

Instances run on different machines. A work instance may run on a laptop that sleeps; it catches up on wake.

## Users

One operator. No multi-user features.

## Interfaces

- **Typing channel:** Telegram (two bots in one forum group plus direct chats, inline buttons). Built as a replaceable adapter.
- **Alarms:** Telegram, same channel as everything else (see D-37).
- **Todo mail:** mail with a sub-address (for example `user+todo@example.com`) from the operator's own address.
- No web UI, no custom chat, no CLI beyond what development needs. Configuration lives in files.

## Phase 1 scope (one instance, "private")

Acceptance criteria are binding.

1. **Daemon** runs under launchd (`KeepAlive`), survives restarts and sleep, catches up via per-source cursors.
2. **Store** (SQLite): items with state machine, actions with idempotency key, todos, reminders, feedback events, rules, cursors, runs with cost, append-only audit log.
3. **Watchers:**
   - Server health: wraps an existing external check script that prints JSON findings (path configurable). The script stays as it is.
   - Mail and calendar via `proton-cli`, read-only wrapper with a command allowlist. Version pinned, update check off, polling every 10–15 minutes.
   - GitHub: only repositories listed in the instance config, levels `observe` and `maintain`.
4. **Readers:** tool-less model calls (Haiku) returning schema-validated JSON. No free text from untrusted input reaches the orchestrator unlabeled.
5. **Orchestrator run:** Sonnet, batched (at most hourly in configured hours, immediately for urgent items). Tools only write proposals: `propose_action`, `create_todo`, `ask_operator`, `send_hint`, `read_state`, `search_knowledge` (read-only).
6. **Gate:** policy table with autonomy levels (`auto`, `ask`, `never`), rate limits, daily budget. Approvals bound to a hash of the exact draft.
7. **Executor:** narrow functions per action type. Phase 1 actions: send and acknowledge messages, create/update todo, write a knowledge note via the configured knowledge CLI.
8. **Todos:** capture via Telegram and todo mail. Natural-language due dates extracted by the model, stored and fired deterministically. Reminders with buttons (done, +1 h, tomorrow), escalation by due date and priority, morning briefing, evening "still open".
9. **Briefings:** morning and evening, times configurable.
10. **Heartbeat** to an external push monitor (Uptime Kuma) after every run.
11. **Kill switch:** "stop" in Telegram pauses all actions.
12. **Tests:** unit tests for store, gate, executor and scheduler; contract tests for connectors; an injection test suite (see `docs/security.md`).

Done when the operator uses it for two weeks and it measurably saves time. If not, stop and reassess before Phase 2.

## Later phases

- **Phase 2:** classifier in the gate, approval buttons for all `ask` actions, updater subagent (sandbox, worktree, PRs for major dependency updates and failing update PRs), learning from feedback, nightly "dream" run proposing rules (Batch API).
- **Phase 3:** second instance on a laptop: Outlook (Microsoft Graph), Jira/Confluence, server health for a second server group.
- **Phase 4:** mailbox service between instances, mutual heartbeat.

## Out of scope

Web UI, own chat app, workflow engine, agent-to-agent protocols (A2A), multi-user, cloud hosting.
