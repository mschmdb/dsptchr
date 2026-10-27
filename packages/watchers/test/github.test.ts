import { describe, expect, it } from "vitest";
import { fetchGithubLogin, fetchRepoSnapshot, WatcherError } from "../src/index.ts";

const TOKEN = "github_pat_TEST_TOKEN_123";

type Routes = Record<string, unknown>;

function fakeFetch(routes: Routes, status: Record<string, number> = {}) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("authorization") });
    const path = url.replace("https://api.github.com", "");
    const code = status[path] ?? 200;
    if (!(path in routes)) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(routes[path]), { status: code });
  };
  return { fetch, calls };
}

const REPO = "owner-a/repo-a";
const base = `/repos/${REPO}`;

const routes: Routes = {
  [base]: { default_branch: "main" },
  [`${base}/pulls?state=open&per_page=50`]: [
    { number: 7, title: "Fix login", draft: false, html_url: "https://github.com/x/7", user: { login: "someone", type: "User" }, updated_at: "2026-10-27T10:00:00Z" },
    { number: 8, title: "Bump vite", draft: false, html_url: "https://github.com/x/8", user: { login: "dependabot[bot]", type: "Bot" }, updated_at: "2026-10-27T11:00:00Z" },
  ],
  [`${base}/issues?state=open&per_page=50`]: [
    { number: 3, title: "Crash on start", html_url: "https://github.com/x/3", user: { login: "someone", type: "User" }, updated_at: "2026-10-27T09:00:00Z" },
    { number: 7, title: "Fix login", html_url: "https://github.com/x/7", user: { login: "someone", type: "User" }, updated_at: "2026-10-27T10:00:00Z", pull_request: {} },
  ],
  [`${base}/actions/workflows?per_page=100`]: {
    workflows: [
      { id: 1, name: "CI", state: "active", path: ".github/workflows/ci.yml" },
      { id: 2, name: "Deploy", state: "active", path: ".github/workflows/deploy.yml" },
      { id: 3, name: "Old", state: "disabled_manually", path: ".github/workflows/old.yml" },
      { id: 4, name: "Never ran", state: "active", path: ".github/workflows/never.yml" },
      { id: 5, name: "Dependabot Updates", state: "active", path: "dynamic/dependabot/dependabot-updates" },
    ],
  },
  [`${base}/actions/workflows/1/runs?branch=main&status=completed&per_page=1`]: {
    workflow_runs: [{ workflow_id: 1, name: "Run title from commit", status: "completed", conclusion: "failure", html_url: "https://github.com/x/r/2" }],
  },
  [`${base}/actions/workflows/2/runs?branch=main&status=completed&per_page=1`]: {
    workflow_runs: [{ workflow_id: 2, name: "Deploy", status: "completed", conclusion: "success", html_url: "https://github.com/x/r/4" }],
  },
  [`${base}/actions/workflows/4/runs?branch=main&status=completed&per_page=1`]: { workflow_runs: [] },
};

describe("fetchRepoSnapshot", () => {
  it("collects open PRs, issues without PRs and the latest completed run per workflow", async () => {
    const { fetch } = fakeFetch(routes);
    const snapshot = await fetchRepoSnapshot(REPO, { token: { reveal: () => TOKEN }, self: "owner-a", fetch });

    expect(snapshot.pulls).toEqual([
      { number: 7, title: "Fix login", url: "https://github.com/x/7", author: "other", draft: false, updatedAt: "2026-10-27T10:00:00Z" },
      { number: 8, title: "Bump vite", url: "https://github.com/x/8", author: "bot", draft: false, updatedAt: "2026-10-27T11:00:00Z" },
    ]);
    expect(snapshot.issues.map((i) => i.number)).toEqual([3]);
    expect(snapshot.ci).toEqual([
      { workflowId: 1, name: "CI", conclusion: "failure", url: "https://github.com/x/r/2" },
      { workflowId: 2, name: "Deploy", conclusion: "success", url: "https://github.com/x/r/4" },
    ]);
  });

  it("marks the operator's own items as self", async () => {
    const { fetch } = fakeFetch(routes);
    const snapshot = await fetchRepoSnapshot(REPO, { token: { reveal: () => TOKEN }, self: "someone", fetch });
    expect(snapshot.pulls[0]?.author).toBe("self");
  });

  it("sends the token only in the authorization header", async () => {
    const { fetch, calls } = fakeFetch(routes);
    await fetchRepoSnapshot(REPO, { token: { reveal: () => TOKEN }, self: "x", fetch });
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}` && !c.url.includes(TOKEN))).toBe(true);
  });

  it("rejects repository names outside owner/name", async () => {
    const { fetch, calls } = fakeFetch(routes);
    for (const name of ["../x", "a/b/c", "a", "a/b?x=1"]) {
      await expect(fetchRepoSnapshot(name, { token: { reveal: () => TOKEN }, self: "x", fetch })).rejects.toThrow(WatcherError);
    }
    expect(calls).toEqual([]);
  });

  it("fails with the status code but without the token", async () => {
    const { fetch } = fakeFetch(routes, { [base]: 401 });
    const error = await fetchRepoSnapshot(REPO, { token: { reveal: () => TOKEN }, self: "x", fetch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WatcherError);
    expect(String(error)).toContain("401");
    expect(String(error)).not.toContain(TOKEN);
  });

  it("rejects malformed responses", async () => {
    const { fetch } = fakeFetch({ ...routes, [`${base}/pulls?state=open&per_page=50`]: { nope: true } });
    await expect(fetchRepoSnapshot(REPO, { token: { reveal: () => TOKEN }, self: "x", fetch })).rejects.toThrow(/unexpected/);
  });

  it("wraps network errors", async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new TypeError(`fetch failed ${TOKEN}`);
    };
    const error = await fetchRepoSnapshot(REPO, { token: { reveal: () => TOKEN }, self: "x", fetch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WatcherError);
    expect(String(error)).not.toContain(TOKEN);
  });
});

describe("pagination", () => {
  it("follows next links and reports a complete snapshot", async () => {
    const page2 = `${base}/pulls?state=open&per_page=50&page=2`;
    const pr = (n: number) => ({ number: n, title: `t${n}`, draft: false, html_url: `https://github.com/x/${n}`, user: { login: "u", type: "User" }, updated_at: "2026-10-27T10:00:00Z" });
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      const path = String(input).replace("https://api.github.com", "");
      calls.push(path);
      if (path === `${base}/pulls?state=open&per_page=50`) {
        return new Response(JSON.stringify([pr(1)]), { headers: { link: `<https://api.github.com${page2}>; rel="next"` } });
      }
      if (path === page2) return new Response(JSON.stringify([pr(2)]));
      return new Response(JSON.stringify(routes[path] ?? {}), { status: path in routes ? 200 : 404 });
    };
    const snapshot = await fetchRepoSnapshot(REPO, { token: { reveal: () => TOKEN }, self: "x", fetch });
    expect(snapshot.pulls.map((p) => p.number)).toEqual([1, 2]);
    expect(snapshot.complete).toBe(true);
  });

  it("marks the snapshot incomplete when the page limit is reached", async () => {
    let n = 0;
    const fetch: typeof globalThis.fetch = async (input) => {
      const path = String(input).replace("https://api.github.com", "");
      if (path.includes("/pulls")) {
        n++;
        return new Response(JSON.stringify([]), { headers: { link: `<https://api.github.com${base}/pulls?state=open&per_page=50&page=${n + 1}>; rel="next"` } });
      }
      return new Response(JSON.stringify(routes[path] ?? {}), { status: path in routes ? 200 : 404 });
    };
    const snapshot = await fetchRepoSnapshot(REPO, { token: { reveal: () => TOKEN }, self: "x", fetch, maxPages: 3 });
    expect(n).toBe(3);
    expect(snapshot.complete).toBe(false);
  });

  it("refuses next links to other hosts", async () => {
    const fetch: typeof globalThis.fetch = async (input) => {
      const path = String(input).replace("https://api.github.com", "");
      if (path.includes("/pulls")) {
        return new Response(JSON.stringify([]), { headers: { link: `<https://evil.example.com/x>; rel="next"` } });
      }
      return new Response(JSON.stringify(routes[path] ?? {}), { status: path in routes ? 200 : 404 });
    };
    await expect(fetchRepoSnapshot(REPO, { token: { reveal: () => TOKEN }, self: "x", fetch })).rejects.toThrow(WatcherError);
  });
});

describe("fetchGithubLogin", () => {
  it("returns the token owner's login", async () => {
    const { fetch } = fakeFetch({ "/user": { login: "owner-a" } });
    expect(await fetchGithubLogin({ token: { reveal: () => TOKEN }, fetch })).toBe("owner-a");
  });
});
