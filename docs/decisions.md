# Decisions

Append-only. Newest at the bottom. Format: ID, date, decision, reason.

- **D-1 (2026-10-27)** Two orchestrators (private, work) instead of one generic personal agent. A generic agent had too little to do.
- **D-2 (2026-10-27)** One codebase, instances configured outside the repo. Enables two instances and a possible public release.
- **D-3 (2026-10-27)** Claude Agent SDK in TypeScript as the engine. Gives the `canUseTool` callback, structured output and cost per run in-process.
- **D-4 (2026-10-27)** Authentication via API key from a dedicated Console workspace per instance (spend limit = hard budget). Plan login stays a config option.
- **D-5 (2026-10-27)** Private instance on an always-on desktop machine, work instance on the work laptop. Physical separation of work data; the laptop's sleep is acceptable, watchers catch up.
- **D-6 (2026-10-27)** Orchestrator has only proposal tools; readers are tool-less; only the updater is a full agent. Reason: a compromised orchestrator can only propose.
- **D-7 (2026-10-27)** Rules change only via operator approval. Self-modifying rules are an injection path.
- **D-8 (2026-10-27)** No workflow engine. SQLite with state machines, idempotency keys and backups suffices for one user.
- **D-9 (2026-10-27)** No agent-to-agent protocol. A small HTTP mailbox on the always-on machine, reached over Tailscale; a shared SQLite file across machines risks corruption.
- **D-10 (2026-10-27)** Telegram as typing channel (official bot API, inline buttons, long polling, 24 h buffering). Signal rejected: no bot API, unofficial client with frequent protocol breaks, no buttons. Threema rejected: public callback required, messages dropped after three retries, groups provisional, paid per message. Built as a replaceable adapter.
- **D-11 (2026-10-27)** No custom chat or web UI.
- **D-12 (2026-10-27)** Pushover for alarms only.
- **D-13 (2026-10-27)** `proton-cli` for mail and calendar, read-only via wrapper, called by watcher code only.
- **D-14 (2026-10-27)** One fine-grained GitHub token (contents and pull requests, no admin/delete) instead of per-repository tokens. Repository allowlist enforced in code. Accepted risk: a bug could open a branch or PR in a non-listed repository.
- **D-15 (2026-10-27)** Existing server-health script is reused as a watcher via subprocess, unchanged.
- **D-16 (2026-10-27)** The orchestrator never modifies its own repository. New features come from operator-driven development sessions.
- **D-17 (2026-10-27)** Instance data lives outside the repo instead of being gitignored; secrets in the macOS Keychain. Pre-commit runs gitleaks plus a denylist kept outside the repo. Reason: the repo may become public, and history is published with it.
- **D-18 (2026-10-27)** Product name `ssstnt` ("assistant" without vowels), in the style of the operator's knowledge tool. Free on npm, GitHub and common domains at decision time. "Orchestrator" stays the name of the deciding role inside the system.
- **D-19 (2026-10-27)** Product name changed to `dsptchr` ("dispatcher" without vowels), superseding D-18; the triple "s" in `ssstnt` read badly. No project uses the name; free on npm, PyPI, crates.io and Homebrew at decision time. Docs site planned on a subdomain of the operator's site, npm package optional.
- **D-20 (2026-10-27)** No build step. Node 24 runs the TypeScript sources directly (type stripping); packages export `src/index.ts`. TypeScript runs only as type checker with `erasableSyntaxOnly`. Reason: fewer moving parts, no dist drift.
- **D-21 (2026-10-27)** SQLite via the built-in `node:sqlite` instead of a native addon. Reason: no dependency, no native build.
- **D-22 (2026-10-27)** Instance settings that are not sources or policy (timezone, channel IDs) live in `instance.yaml`. Secrets resolve lazily through `secrets.yaml` keychain references and are wrapped in a `Secret` type that never prints its value.
- **D-23 (2026-10-27)** Leak guard prints only the denylist entry number for a hit, never the term. Reason: CI logs may become public; the terms must not.
- **D-24 (2026-10-27)** The audit log is hash-chained and protected against UPDATE/DELETE by triggers. It records IDs, states, times and gate reasons, never todo or message text.
- **D-25 (2026-10-27)** Telegram offsets are confirmed on the next poll (at-least-once). Handlers use the channel event ID as idempotency key, so redelivery after a crash creates no duplicates.
- **D-26 (2026-10-27)** Kill switch: "stop" sends its confirmation first, then pauses. While paused the gate denies every action, including replies. "start" resumes, then confirms.
- **D-27 (2026-10-27)** Button presses are answered with a reply via `telegram.send`, not with a callback acknowledgement. An acknowledgement would be a new executor action (protected path). Repeated presses answer "Already done".
- **D-28 (2026-10-27)** Until the reader model exists, due dates come from a deterministic parser with an explicit ` @ ` separator (`in 2h`, `18:00`, `morgen 9:00`, `2.11. 14:00`). Unreadable dates are refused, never guessed.
