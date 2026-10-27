import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

export class KnowledgeError extends Error {
  override name = "KnowledgeError";
}

export interface WriteRequest {
  path: string;
  content: string;
  // "new" for a new note, otherwise the revision the change is based on.
  expected: string;
  append: boolean;
  message: string;
}

// Contract for the operator's knowledge base. Adapters live in the instance directory, outside
// this repository, and translate these calls to the operator's own tool. Adapters must enforce
// scope and validate paths themselves; they throw KnowledgeError for input the model can fix.
export interface KnowledgeAdapter {
  context(query: string): Promise<string>;
  read(path: string, section?: string): Promise<string>;
  write(request: WriteRequest): Promise<string>;
}

export interface KnowledgeAdapterOptions {
  root: string;
  scope: string;
}

const METHODS = ["context", "read", "write"] as const;

// Loads `createKnowledgeAdapter(options)` from an operator-provided module. The module is
// trusted operator code, like the instance config next to it.
export async function loadKnowledgeAdapter(modulePath: string, options: KnowledgeAdapterOptions): Promise<KnowledgeAdapter> {
  if (!isAbsolute(modulePath)) throw new KnowledgeError("knowledge: adapter path must be absolute");
  let module: { createKnowledgeAdapter?: unknown };
  try {
    module = (await import(pathToFileURL(modulePath).href)) as { createKnowledgeAdapter?: unknown };
  } catch {
    throw new KnowledgeError("knowledge: adapter module could not be loaded");
  }
  if (typeof module.createKnowledgeAdapter !== "function") {
    throw new KnowledgeError("knowledge: adapter module must export createKnowledgeAdapter");
  }
  const adapter = (module.createKnowledgeAdapter as (o: KnowledgeAdapterOptions) => unknown)(options) as Record<string, unknown>;
  const missing = METHODS.filter((m) => typeof adapter?.[m] !== "function");
  if (missing.length > 0) throw new KnowledgeError(`knowledge: adapter lacks ${missing.join(", ")}`);
  return adapter as unknown as KnowledgeAdapter;
}
