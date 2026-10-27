import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeError, loadKnowledgeAdapter } from "../src/index.ts";

describe("loadKnowledgeAdapter", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsptchr-knowledge-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("loads an adapter module and passes root and scope", async () => {
    const file = join(dir, "adapter.ts");
    writeFileSync(
      file,
      `export function createKnowledgeAdapter(options) {
        return {
          context: async (q) => JSON.stringify({ q, ...options }),
          read: async (path) => path,
          write: async (request) => request.path,
        };
      }`,
    );
    const adapter = await loadKnowledgeAdapter(file, { root: "/brain", scope: "privat" });
    expect(JSON.parse(await adapter.context("x"))).toEqual({ q: "x", root: "/brain", scope: "privat" });
  });

  it("rejects modules without the factory or with incomplete adapters", async () => {
    const missing = join(dir, "missing.ts");
    writeFileSync(missing, "export const nothing = 1;");
    await expect(loadKnowledgeAdapter(missing, { root: "/b", scope: "s" })).rejects.toThrow(KnowledgeError);

    const partial = join(dir, "partial.ts");
    writeFileSync(partial, "export function createKnowledgeAdapter() { return { context: async () => '' }; }");
    await expect(loadKnowledgeAdapter(partial, { root: "/b", scope: "s" })).rejects.toThrow(/read, write/);
  });

  it("requires an absolute module path", async () => {
    await expect(loadKnowledgeAdapter("relative/adapter.ts", { root: "/b", scope: "s" })).rejects.toThrow(KnowledgeError);
  });
});
