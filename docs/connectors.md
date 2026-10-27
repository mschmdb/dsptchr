# Adding a connector

A connector brings a new source (and optionally new actions) into the orchestrator. Every connector has the same parts.

## Parts

1. **Watcher** in `packages/watchers/<name>/`
   - Polls the source, keeps a cursor, emits normalized items with a stable ID and `updated_at`.
   - Reads credentials itself. Credentials never reach a model.
   - Read-only by default.
2. **Reader schema** in `packages/agents/readers/<name>.schema.ts`
   - Enums, IDs and numbers wherever possible. Any free text derived from the source is labeled `untrusted`.
3. **Config** entry documented in `examples/<instance>/sources.yaml` with placeholders.
4. **Executor actions** (optional, protected path)
   - One narrow function per action type, its own credential, an entry in the policy schema with a default autonomy level of `ask`.
   - Needs explicit operator approval in the session that adds it.
5. **Tests**
   - Unit tests for the watcher (cursor, dedupe, error handling, empty and malformed responses).
   - Contract tests (shared suite, must pass): read-only unless actions are declared, no credential in model input, output matches schema, injection fixtures don't produce forbidden actions.

## Steps

1. Write the contract and watcher tests first.
2. Implement the watcher and reader schema.
3. Add the example config.
4. If actions are needed, stop and ask the operator before touching `packages/executor` or policy files.
5. Run `pnpm test` and `pnpm check`. Open a PR.
