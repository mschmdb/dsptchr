import { z } from "zod";
import { WatcherError } from "../server-health/server-health.ts";

const API = "https://api.github.com";
const REPO_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export type AuthorType = "self" | "bot" | "other";

export interface GithubItem {
  number: number;
  // Untrusted: anyone may open an issue or PR. Never give it to a model.
  title: string;
  url: string;
  author: AuthorType;
  draft: boolean;
  updatedAt: string;
}

export interface GithubCiStatus {
  workflowId: number;
  name: string;
  conclusion: string;
  url: string;
}

export interface RepoSnapshot {
  repo: string;
  pulls: GithubItem[];
  issues: GithubItem[];
  ci: GithubCiStatus[];
  // False when a page limit cut the lists short; callers must not resolve from it.
  complete: boolean;
}

interface GithubDeps {
  token: { reveal(): string };
  fetch?: typeof globalThis.fetch;
  maxPages?: number;
}

const userSchema = z.object({ login: z.string(), type: z.string().optional() });
const itemSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  html_url: z.string(),
  user: userSchema.nullable(),
  draft: z.boolean().optional(),
  updated_at: z.string(),
  pull_request: z.unknown().optional(),
});
const runsSchema = z.object({
  workflow_runs: z.array(
    z.object({
      workflow_id: z.number().int(),
      status: z.string().nullable(),
      conclusion: z.string().nullable(),
      html_url: z.string(),
    }),
  ),
});
const workflowsSchema = z.object({
  total_count: z.number().int().optional(),
  workflows: z.array(z.object({ id: z.number().int(), name: z.string(), state: z.string(), path: z.string() })),
});

async function get<S extends z.ZodType>(deps: GithubDeps, path: string, schema: S): Promise<z.output<S>> {
  return (await request(deps, path, schema)).data;
}

// Follows rel="next" links on api.github.com only, up to maxPages.
async function getAll<S extends z.ZodType>(
  deps: GithubDeps,
  path: string,
  schema: S,
): Promise<{ items: z.output<S>[]; complete: boolean }> {
  const maxPages = deps.maxPages ?? 10;
  const items: z.output<S>[] = [];
  let next: string | undefined = path;
  for (let page = 0; page < maxPages && next !== undefined; page++) {
    const result: { data: z.output<S>[]; next: string | undefined } = await request(deps, next, z.array(schema));
    items.push(...result.data);
    next = result.next;
  }
  return { items, complete: next === undefined };
}

function nextPath(link: string | null): string | undefined {
  const match = link?.match(/<([^>]+)>;\s*rel="next"/);
  if (match?.[1] === undefined) return undefined;
  if (!match[1].startsWith(`${API}/`)) throw new WatcherError("github: unexpected pagination link");
  return match[1].slice(API.length);
}

async function request<S extends z.ZodType>(
  deps: GithubDeps,
  path: string,
  schema: S,
): Promise<{ data: z.output<S>; next: string | undefined }> {
  const fetch = deps.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      headers: {
        authorization: `Bearer ${deps.token.reveal()}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new WatcherError("github: request failed");
  }
  if (!response.ok) {
    throw new WatcherError(`github: HTTP ${response.status}`);
  }
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    throw new WatcherError("github: unexpected response format");
  }
  return { data: parsed.data, next: nextPath(response.headers.get("link")) };
}

export async function fetchGithubLogin(deps: GithubDeps): Promise<string> {
  return (await get(deps, "/user", userSchema)).login;
}

// Read-only snapshot of one repository (observe level).
export async function fetchRepoSnapshot(repo: string, deps: GithubDeps & { self: string }): Promise<RepoSnapshot> {
  if (!REPO_NAME.test(repo)) {
    throw new WatcherError("github: invalid repository name");
  }
  const base = `/repos/${repo}`;
  const { default_branch: branch } = await get(deps, base, z.object({ default_branch: z.string() }));
  const authorOf = (user: z.infer<typeof userSchema> | null): AuthorType => {
    if (user === null) return "other";
    if (user.login === deps.self) return "self";
    return user.type === "Bot" || user.login.endsWith("[bot]") ? "bot" : "other";
  };
  const toItem = (i: z.infer<typeof itemSchema>): GithubItem => ({
    number: i.number,
    title: i.title,
    url: i.html_url,
    author: authorOf(i.user),
    draft: i.draft ?? false,
    updatedAt: i.updated_at,
  });

  const pulls = await getAll(deps, `${base}/pulls?state=open&per_page=50`, itemSchema);
  const issues = await getAll(deps, `${base}/issues?state=open&per_page=50`, itemSchema);

  // Only workflows defined in the repository; GitHub's dynamic ones (Dependabot updates,
  // default code scanning) are not the operator's CI. Names come from the workflow, not
  // from run titles, which repeat commit messages.
  const workflows = await get(deps, `${base}/actions/workflows?per_page=100`, workflowsSchema);
  const ci: GithubCiStatus[] = [];
  for (const workflow of workflows.workflows) {
    if (workflow.state !== "active" || !workflow.path.startsWith(".github/workflows/")) continue;
    const runs = await get(
      deps,
      `${base}/actions/workflows/${workflow.id}/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=1`,
      runsSchema,
    );
    const latest = runs.workflow_runs[0];
    if (latest === undefined || latest.conclusion === null) continue;
    ci.push({ workflowId: workflow.id, name: workflow.name, conclusion: latest.conclusion, url: latest.html_url });
  }
  const workflowsComplete = (workflows.total_count ?? workflows.workflows.length) <= workflows.workflows.length;

  return {
    repo,
    pulls: pulls.items.map(toItem),
    issues: issues.items.filter((i) => i.pull_request === undefined).map(toItem),
    ci,
    complete: pulls.complete && issues.complete && workflowsComplete,
  };
}
