# dsptchr

dsptchr (say "dispatcher") is a self-hosted, proactive personal orchestrator built on the Claude Agent SDK. One codebase, one daemon per machine, any number of instances (for example "private" and "work"), each configured outside this repo.

Read before changing anything:

1. `docs/brief.md` – goal, scope, acceptance criteria
2. `docs/architecture.md` – modules, data flow, binding rules
3. `docs/security.md` – roles, gate, threat model
4. `docs/decisions.md` – decision log (append-only)

## Rules

- pnpm only. TypeScript, strict mode. Node 24.
- Test first (TDD). Every module gets unit tests, edge cases included. `pnpm test` and `pnpm check` must pass before every commit.
- Code, identifiers, docs and commit messages in English.
- **This repo may become public.** No personal data, employer, customer, colleague, host, IP, domain or internal system names anywhere, including tests, fixtures and commit messages. Use placeholders (`example.com`, `host-a`, `user@example.com`).
- **No instance data in the repo.** Instance config, rules, state and secrets live in the instance directory (default `~/.config/dsptchr/<instance>/`). The repo ships only `examples/` with placeholders.
- No secrets in code, logs or LLM context. Credentials are read by deterministic code only. Secrets live in the macOS Keychain; instance files hold only references.
- Git history becomes public if the repo does. Keep every commit clean from the start. Pre-commit runs gitleaks and a local denylist of private terms; the denylist lives outside the repo (`~/.config/dsptchr/denylist.txt`) and must never be committed.
- Keep dependencies few and light. Justify each new one in the PR.
- Files under 500 lines. Explicit over clever.
- Log every architecture decision in `docs/decisions.md` (append-only), then update `docs/architecture.md`.

## Protected paths

Changes to these paths widen what the orchestrator may do. Never change them without explicit approval from the operator in the current session:

- `packages/gate/**`
- `packages/executor/**`
- `examples/**/policy.yaml` and any policy schema

## Hard constraints (do not relax)

- The orchestrator agent has no shell, file system or network tools. Its tools only write proposals to the store.
- Readers are single tool-less model calls with schema-validated output.
- Only the updater role is a full agent: sandboxed, inside a worktree, network allowlist, no push to the default branch.
- Every external effect goes through gate → executor. The executor is deterministic code.
- The orchestrator never modifies this repository. Its updater must refuse this repo as a target.

## Adding a connector

Follow `docs/connectors.md`. A connector is a watcher, a reader schema, optional executor actions and contract tests. New executor actions are protected-path changes.
