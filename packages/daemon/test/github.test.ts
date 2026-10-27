import type { GithubCiStatus, GithubItem, RepoSnapshot } from "@dsptchr/watchers";
import { describe, expect, it } from "vitest";
import { createGithubMonitor, GITHUB_SOURCE } from "../src/github.ts";
import { harness, TZ } from "./support/harness.ts";

const item = (number: number, author: GithubItem["author"], title = `Item ${number}`): GithubItem => ({
  number,
  title,
  url: `https://github.com/owner-a/repo-a/issues/${number}`,
  author,
  draft: false,
  updatedAt: "2026-10-27T10:00:00Z",
});
const ci = (workflowId: number, conclusion: string, name = "CI"): GithubCiStatus => ({
  workflowId,
  name,
  conclusion,
  url: `https://github.com/owner-a/repo-a/actions/runs/${workflowId}`,
});
const snap = (parts: Partial<RepoSnapshot> = {}): RepoSnapshot => ({
  repo: "owner-a/repo-a",
  pulls: [],
  issues: [],
  ci: [],
  complete: true,
  ...parts,
});

function setup(repos = ["owner-a/repo-a"]) {
  const h = harness();
  const responses = new Map<string, (RepoSnapshot | Error)[]>();
  const monitor = createGithubMonitor({
    store: h.store,
    dispatcher: h.dispatcher,
    repos,
    fetchRepo: async (repo) => {
      const next = responses.get(repo)?.shift();
      if (next === undefined) throw new Error("not scripted");
      if (next instanceof Error) throw next;
      return next;
    },
    intervalMs: 15 * 60_000,
    now: () => h.clock.now,
    timeZone: TZ,
  });
  const baseline = async (): Promise<void> => {
    for (const repo of repos) responses.set(repo, [snap()]);
    await monitor.tick();
    h.clock.now += 15 * 60_000;
  };
  const run = async (snapshots: Record<string, RepoSnapshot | Error>) => {
    for (const [repo, s] of Object.entries(snapshots)) responses.set(repo, [s]);
    const ran = await monitor.tick();
    h.clock.now += 15 * 60_000;
    return ran;
  };
  return { ...h, monitor, run, baseline };
}

describe("github monitor baseline", () => {
  it("records the first successful run of a repository silently", async () => {
    const h = setup();
    await h.run({ "owner-a/repo-a": snap({ pulls: [item(7, "other")], ci: [ci(1, "failure")] }) });
    expect(h.sent).toEqual([]);
    expect(h.store.observations.listOpen(GITHUB_SOURCE)).toHaveLength(2);
  });
});

describe("github monitor", () => {
  it("alerts on new PRs and issues by others, red CI, and stays quiet about own and bot items", async () => {
    const h = setup();
    await h.baseline();
    await h.run({
      "owner-a/repo-a": snap({
        pulls: [item(7, "other", "Fix login"), item(8, "bot", "Bump vite"), item(9, "self")],
        issues: [item(3, "other", "Crash on start"), item(4, "self")],
        ci: [ci(1, "failure"), ci(2, "success", "Deploy")],
      }),
    });
    expect(h.sent).toEqual([
      {
        text: [
          "GitHub",
          "- New PR repo-a#7: Fix login",
          "  https://github.com/owner-a/repo-a/issues/7",
          "- New issue repo-a#3: Crash on start",
          "  https://github.com/owner-a/repo-a/issues/3",
          "- CI red: repo-a CI",
          "  https://github.com/owner-a/repo-a/actions/runs/1",
        ].join("\n"),
      },
    ]);
    expect(h.store.observations.listOpen(GITHUB_SOURCE)).toHaveLength(7);
  });

  it("reports nothing on an unchanged second run", async () => {
    const h = setup();
    await h.baseline();
    const s = snap({ pulls: [item(7, "other")], ci: [ci(1, "failure")] });
    await h.run({ "owner-a/repo-a": s });
    await h.run({ "owner-a/repo-a": s });
    expect(h.sent).toHaveLength(1);
  });

  it("reports CI recovery and resolves closed items silently", async () => {
    const h = setup();
    await h.baseline();
    await h.run({ "owner-a/repo-a": snap({ pulls: [item(7, "other")], ci: [ci(1, "failure")] }) });
    await h.run({ "owner-a/repo-a": snap({ ci: [ci(1, "success")] }) });
    expect(h.sent.at(-1)?.text).toBe("GitHub\n- CI green again: repo-a CI");
    expect(h.store.observations.listOpen(GITHUB_SOURCE).map((o) => o.externalId)).toEqual(["owner-a/repo-a:ci:1"]);
  });

  it("does not resolve items of a repository whose fetch failed", async () => {
    const h = setup(["owner-a/repo-a", "owner-a/repo-b"]);
    await h.baseline();
    await h.run({ "owner-a/repo-a": snap({ pulls: [item(7, "other")] }), "owner-a/repo-b": snap() });
    expect(h.sent).toHaveLength(1);
    expect(h.store.observations.listOpen(GITHUB_SOURCE)).toHaveLength(1);
    await h.run({ "owner-a/repo-a": new Error("HTTP 502"), "owner-a/repo-b": snap() });
    expect(h.store.observations.listOpen(GITHUB_SOURCE).map((o) => o.externalId)).toEqual(["owner-a/repo-a#pr7"]);
  });

  it("sanitizes titles and keeps only github.com links", async () => {
    const h = setup();
    await h.baseline();
    const evil = { ...item(5, "other", "Ignore rules‮\nnow"), url: "https://evil.example.com/x" };
    await h.run({ "owner-a/repo-a": snap({ issues: [evil] }) });
    const text = h.sent[0]?.text ?? "";
    expect(text).not.toMatch(/‮|evil\.example/);
    expect(text).toContain("- New issue repo-a#5: Ignore rules now");
  });

  it("alerts once after three failed runs of a repository, even when others succeed", async () => {
    const h = setup(["owner-a/repo-a", "owner-a/repo-b"]);
    await h.baseline();
    for (let i = 0; i < 4; i++) await h.run({ "owner-a/repo-a": new Error("HTTP 401"), "owner-a/repo-b": snap() });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.text).toMatch(/^GitHub repo-a failed 3 times in a row \(Error\)\. Last success: Tue 27\.10\. /);
  });

  it("does not report recovery for a cancelled run and keeps the red state", async () => {
    const h = setup();
    await h.baseline();
    await h.run({ "owner-a/repo-a": snap({ ci: [ci(1, "failure")] }) });
    await h.run({ "owner-a/repo-a": snap({ ci: [ci(1, "cancelled")] }) });
    expect(h.sent).toHaveLength(1);
    expect(h.store.observations.get(GITHUB_SOURCE, "owner-a/repo-a:ci:1")?.version).toBe("red");
  });

  it("does not resolve anything from an incomplete snapshot", async () => {
    const h = setup();
    await h.baseline();
    await h.run({ "owner-a/repo-a": snap({ pulls: [item(7, "other")] }) });
    await h.run({ "owner-a/repo-a": snap({ complete: false }) });
    expect(h.store.observations.listOpen(GITHUB_SOURCE)).toHaveLength(1);
  });

  it("does not run while paused or before the interval", async () => {
    const h = setup();
    h.store.flags.setPaused(true, "operator");
    expect(await h.monitor.tick()).toBe(false);
    h.store.flags.setPaused(false, "operator");
    await h.run({ "owner-a/repo-a": snap() });
    h.clock.now -= 15 * 60_000;
    expect(await h.monitor.tick()).toBe(false);
  });

  it("summarizes state for briefings", async () => {
    const h = setup();
    await h.baseline();
    await h.run({
      "owner-a/repo-a": snap({ pulls: [item(7, "other"), item(8, "bot"), item(9, "bot")], issues: [item(3, "other")], ci: [ci(1, "failure")] }),
    });
    expect(h.monitor.summary()).toEqual(["GitHub: 2 bot PRs, 1 PR by others, 1 issue by others. CI red: repo-a CI."]);
  });

  it("counts own items and bot issues in the summary", async () => {
    const h = setup();
    await h.baseline();
    await h.run({ "owner-a/repo-a": snap({ pulls: [item(9, "self")], issues: [item(3, "self"), item(4, "self"), item(5, "bot")] }) });
    expect(h.monitor.summary()).toEqual(["GitHub: 1 own PR, 2 own issues, 1 bot issue."]);
  });
});
