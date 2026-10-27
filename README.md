# dsptchr

**dsptchr** (say "dispatcher") is a self-hosted, proactive personal orchestrator. It watches your sources (mail, calendar, repositories, servers, todos), tells you only what is new and relevant, handles routine work itself and asks before anything sensitive.

Built on the Claude Agent SDK. Designed around one rule set:

1. Whoever reads untrusted content can't act.
2. Whoever decides can't execute.
3. Deterministic rules check every action.

> Personal project. No support, no roadmap promises.

Status: in development. See `docs/brief.md`.

## Development

Requirements: Node 24, pnpm, gitleaks (`brew install gitleaks`).

```sh
pnpm install   # also sets core.hooksPath to .githooks
pnpm test
pnpm check
```

The pre-commit hooks run gitleaks and a denylist of private terms. The denylist lives outside the repo at `~/.config/dsptchr/denylist.txt` (override with `DSPTCHR_DENYLIST`). Without it, the hook warns and passes.

## Running an instance

1. Copy `examples/private/` to `~/.config/dsptchr/private/` and fill in the placeholders.
2. Store secrets in the macOS Keychain, for example `security add-generic-password -s dsptchr.private -a telegram-bot -w`.
3. Run `node packages/daemon/src/main.ts --instance private`, or install `examples/launchd/` as a LaunchAgent.

Send a message to the bot to create a todo. Add a due date after ` @ `: `Water plants @ morgen 9:00`. Send `stop` to pause all actions and `start` to resume.
