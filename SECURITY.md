# Security policy

dsptchr acts on the operator's behalf, so security findings matter more than features.

## Reporting

Use GitHub's private vulnerability reporting: **Security → Report a vulnerability** in this repository. Please don't open a public issue.

Include what you found, how to reproduce it and what an attacker gains. Expect a first answer within a week; this is a personal project without an on-call team.

## In scope

- A way for untrusted content (mail, calendar invitations, issue titles, server output, knowledge base pages) to make the orchestrator propose or the executor run an action
- Bypassing the gate: policy, rate limits, kill switch, draft hash
- Secrets reaching logs, the audit log, model context or the repository
- Channel allowlist bypass (messages from or to someone other than the operator)
- Watchers sending anything other than read requests to a source

## Out of scope

- Findings that need control of the operator's machine, instance directory or Keychain
- Model output quality that does not lead to a forbidden action

## Supported versions

Only the latest commit on `main`.
