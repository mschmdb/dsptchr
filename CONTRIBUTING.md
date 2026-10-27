# Contributing

dsptchr is a personal project built for one operator. Issues with bugs, security findings and ideas are welcome. For pull requests, open an issue first, so we can agree on the change before you spend time on it.

## Setup

Requirements: macOS or Linux, Node 24, pnpm, [gitleaks](https://github.com/gitleaks/gitleaks).

```sh
pnpm install   # also sets core.hooksPath to .githooks
pnpm test
pnpm check
```

## How we work

- **Test first.** Write the failing test, then the code. Cover edge cases, not only the happy path.
- **Small pull requests.** One logical change each; commit messages in the imperative ("Add …", "Fix …").
- **Explicit over clever.** Strict TypeScript, files under 500 lines, few and light dependencies. Justify every new dependency in the pull request.
- **Decisions are logged.** Architecture changes get an entry in [`docs/decisions.md`](docs/decisions.md) (append-only) and an update to [`docs/architecture.md`](docs/architecture.md).
- **Read the rules first:** [`AGENTS.md`](AGENTS.md), [`docs/security.md`](docs/security.md).

## Protected paths

Changes to `packages/gate/`, `packages/executor/` and policy files widen what the orchestrator may do. They need an explicit maintainer review and a security rationale in the pull request.

## Security rules for every change

- The orchestrator gets no shell, file system or network tools. Its tools only read state or write proposals.
- Untrusted text (mail, issue titles, server output, web pages) never reaches the orchestrator unlabeled and never lands in arguments of external actions.
- Every external effect goes through gate and executor.
- No personal data, secrets, hostnames or instance configuration in code, tests, fixtures or commit messages. Use placeholders like `example.com` and `host-a`.

The pre-commit hook runs gitleaks and, if you keep one, a private-terms denylist at `~/.config/dsptchr/denylist.txt` (one term per line, never committed).

## Reporting security issues

Please don't open a public issue. See [`SECURITY.md`](SECURITY.md).
