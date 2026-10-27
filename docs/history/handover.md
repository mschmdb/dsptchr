# Handover to the build session

## Read first

1. `AGENTS.md`
2. `docs/brief.md` (Phase 1 is your scope)
3. `docs/architecture.md`, `docs/security.md`, `docs/decisions.md`
4. The operator's private notes. The session prompt gives the path. They hold instance details (hosts, accounts, paths) that must not enter this repo.

## How to work

- TDD. Start with `core` and `store`, then `gate` and `executor` (deterministic, no model), then `scheduler` and todos, then channels, then watchers, then agents.
- Make the deterministic skeleton work end to end with a stubbed model first. Add real model calls last.
- Small commits, one logical change each, imperative mood. Don't push; there is no remote yet.
- Verify the current Claude Agent SDK API against the official docs before using it (`https://code.claude.com/docs/en/agent-sdk/overview`). Don't rely on memory.
- If a decision isn't covered by the docs, pick the simplest option, log it in `docs/decisions.md` and continue.

## First task: leak protection

Before any feature code:

1. Pre-commit hook running gitleaks on staged changes.
2. Pre-commit hook that rejects staged content and commit messages matching any line of `~/.config/dsptchr/denylist.txt` (case-insensitive). The hook passes with a warning if the file is missing. The denylist itself never enters the repo.
3. Same checks as a CI job later, once a remote exists (denylist then via a CI secret).
4. Instance loader that reads `~/.config/dsptchr/<instance>/` and resolves secrets from the macOS Keychain. Tests use a temp directory and a fake keychain.

## Suggested first milestone

A daemon that:

1. accepts a todo via Telegram from the allowlisted user,
2. stores it with a due date,
3. sends a reminder with buttons at the due time,
4. marks it done when the button is pressed,
5. writes every step to the audit log.

This exercises store, gate, executor, scheduler and a channel without any untrusted input.

## What the operator must provide

Track these as a checklist in the first PR description. Don't block on them; use fakes until they exist.

- [ ] Console workspace for the instance with spend limit, API key
- [ ] Telegram: two bots via BotFather, a forum group, operator user ID, group ID, privacy mode off
- [ ] Uptime Kuma push monitor URL for the heartbeat
- [ ] Fine-grained GitHub token (contents, pull requests) and the repository allowlist with levels
- [ ] `proton-cli` installed and pinned; decision on a dedicated bot account
- [ ] Path to the existing server-health script and its JSON output format
- [ ] Knowledge CLI path and allowed scope
- [ ] `~/.config/dsptchr/denylist.txt` with private terms (hosts, domains, names, accounts)

## Open questions

- Does a free Proton account receive a shared calendar, and does the paid plan allow auto-forwarding to it?
- Todo store: own table (default) or an external todo app as backend.
