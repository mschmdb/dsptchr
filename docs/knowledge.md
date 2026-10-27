# Knowledge adapter

dsptchr can search, read and change a knowledge base of notes. The knowledge base itself is yours: dsptchr talks to it through an adapter module that lives in your instance directory, not in this repository.

## Contract

The module exports one function:

```ts
export function createKnowledgeAdapter(options: { root: string; scope: string }): {
  context(query: string): Promise<string>; // search; return JSON text for the model
  read(path: string, section?: string): Promise<string>; // one note or section; JSON text
  write(request: {
    path: string;
    content: string;
    expected: string; // "new" for a new note, otherwise the revision the change is based on
    append: boolean;
    message: string; // one-line change description
  }): Promise<string>; // JSON text, ideally with the new "revision"
};
```

Throw an error whose `name` is `"KnowledgeError"` for input the model can fix (unknown path, stale revision, path outside the scope). Other errors count as failures.

## Rules for adapters

- Enforce the scope you receive. Never release paths you consider sensitive.
- Validate paths: relative, no `..`, no leading `-`, only the file types you store.
- Check `expected` before changing an existing note, so concurrent edits are not lost.
- Make every change reversible, for example as a commit in a Git repository.
- Return bounded output; dsptchr passes it to the model.

## Configuration

```yaml
# sources.yaml in the instance directory
knowledge:
  adapter: /path/to/knowledge-adapter.ts
  root: /path/to/notes
  scope: private
```

The orchestrator uses `search_knowledge`, `read_knowledge` and `write_knowledge`. Writes become the executor action `knowledge.write`, which passes the gate like every other action (see `examples/private/policy.yaml`).
