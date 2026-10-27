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
}

interface GithubDeps {
  token: { reveal(): string };
  fetch?: typeof globalThis.fetch;
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
      name: z.string().nullable(),
      status: z.string().nullable(),
      conclusion: z.string().nullable(),
      html_url: z.string(),
    }),
  ),
});

async function get<S extends z.ZodType>(deps: GithubDeps, path: string, schema: S): Promise<z.output<S>> {
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
  return parsed.data;
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

  const pulls = await get(deps, `${base}/pulls?state=open&per_page=50`, z.array(itemSchema));
  const issues = await get(deps, `${base}/issues?state=open&per_page=50`, z.array(itemSchema));
  const runs = await get(deps, `${base}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=20`, runsSchema);

  // Runs come newest first; keep the latest completed run per workflow.
  const ci = new Map<number, GithubCiStatus>();
  for (const run of runs.workflow_runs) {
    if (run.status !== "completed" || run.conclusion === null || ci.has(run.workflow_id)) continue;
    ci.set(run.workflow_id, { workflowId: run.workflow_id, name: run.name ?? "workflow", conclusion: run.conclusion, url: run.html_url });
  }

  return {
    repo,
    pulls: pulls.map(toItem),
    issues: issues.filter((i) => i.pull_request === undefined).map(toItem),
    ci: [...ci.values()],
  };
}
