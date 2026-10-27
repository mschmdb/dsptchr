import type { Store } from "@dsptchr/store";
import { sanitizeUntrusted, type GithubItem, type RepoSnapshot } from "@dsptchr/watchers";
import { claimRun, failureStreak, sendAlertLines, type AlertLine } from "./alerts.ts";
import type { Dispatcher } from "./dispatch.ts";

export const GITHUB_SOURCE = "github";
const SOURCE = GITHUB_SOURCE;
const MAX_TITLE = 100;
const RED = new Set(["failure", "timed_out", "startup_failure"]);
const GITHUB_URL = /^https:\/\/github\.com\/[^\s]+$/;

export interface GithubMonitorDeps {
  store: Store;
  dispatcher: Dispatcher;
  repos: readonly string[];
  fetchRepo(repo: string): Promise<RepoSnapshot>;
  intervalMs: number;
  now: () => number;
  timeZone: string;
  failureThreshold?: number;
}

interface ItemData {
  repo: string;
  kind: "pr" | "issue";
  number: number;
  author: GithubItem["author"];
  title: string;
  url: string;
}

interface CiData {
  repo: string;
  kind: "ci";
  workflow: string;
  url: string;
}

// Observe-level GitHub monitoring. Titles are untrusted (anyone can open an issue): they are
// sanitized and only ever sent to the operator, never to a model (D-45).
export function createGithubMonitor(deps: GithubMonitorDeps) {
  const { store, dispatcher, now } = deps;
  const streak = failureStreak({
    store,
    dispatcher,
    source: SOURCE,
    label: "GitHub watcher",
    now,
    timeZone: deps.timeZone,
    threshold: deps.failureThreshold ?? 3,
  });

  const short = (repo: string): string => repo.split("/")[1] ?? repo;
  const safeUrl = (url: string): string | undefined => (GITHUB_URL.test(url) ? url : undefined);
  const withLink = (text: string, url: string | undefined): string => (url === undefined ? text : `${text}\n  ${url}`);

  // Keys use the configured repository name, never the one inside the response.
  function diffRepo(repo: string, snapshot: RepoSnapshot): AlertLine[] {
    const lines: AlertLine[] = [];
    const seen = new Set<string>();

    const items: [ItemData["kind"], GithubItem][] = [
      ...snapshot.pulls.map((p): [ItemData["kind"], GithubItem] => ["pr", p]),
      ...snapshot.issues.map((i): [ItemData["kind"], GithubItem] => ["issue", i]),
    ];
    for (const [kind, item] of items) {
      const externalId = `${repo}#${kind}${item.number}`;
      seen.add(externalId);
      const data: ItemData = {
        repo: repo,
        kind,
        number: item.number,
        author: item.author,
        title: sanitizeUntrusted(item.title, MAX_TITLE),
        url: safeUrl(item.url) ?? "",
      };
      const observe = (): void => {
        store.observations.observe({ source: SOURCE, externalId, version: "open", data });
      };
      const existing = store.observations.get(SOURCE, externalId);
      if ((existing === undefined || existing.state === "resolved") && item.author === "other") {
        const label = kind === "pr" ? "New PR" : "New issue";
        lines.push({
          text: withLink(`- ${label} ${short(repo)}#${item.number}: ${data.title}`, safeUrl(item.url)),
          apply: observe,
        });
      } else {
        observe();
      }
    }

    for (const run of snapshot.ci) {
      const externalId = `${repo}:ci:${run.workflowId}`;
      seen.add(externalId);
      const version = RED.has(run.conclusion) ? "red" : "green";
      const data: CiData = {
        repo: repo,
        kind: "ci",
        workflow: sanitizeUntrusted(run.name, 40),
        url: safeUrl(run.url) ?? "",
      };
      const observe = (): void => {
        store.observations.observe({ source: SOURCE, externalId, version, data });
      };
      const existing = store.observations.get(SOURCE, externalId);
      const was = existing === undefined || existing.state === "resolved" ? undefined : existing.version;
      if (version === "red" && was !== "red") {
        lines.push({ text: withLink(`- CI red: ${short(repo)} ${data.workflow}`, safeUrl(run.url)), apply: observe });
      } else if (version === "green" && was === "red") {
        lines.push({ text: `- CI green again: ${short(repo)} ${data.workflow}`, apply: observe });
      } else {
        observe();
      }
    }

    // Closed or merged items leave silently.
    for (const open of store.observations.listOpen(SOURCE)) {
      if ((open.data as { repo?: unknown }).repo === repo && !seen.has(open.externalId)) {
        store.observations.resolve(SOURCE, open.externalId);
      }
    }
    return lines;
  }

  return {
    // Returns true when a check ran.
    async tick(): Promise<boolean> {
      if (!claimRun(store, SOURCE, deps.intervalMs, now())) return false;
      const lines: AlertLine[] = [];
      let lastError: unknown;
      let succeeded = 0;
      for (const repo of deps.repos) {
        try {
          lines.push(...diffRepo(repo, await deps.fetchRepo(repo)));
          succeeded++;
        } catch (error) {
          lastError = error;
        }
      }
      if (succeeded === 0 && deps.repos.length > 0) {
        await streak.failed(lastError);
        return true;
      }
      streak.succeeded();
      await sendAlertLines(dispatcher, store, { title: "GitHub", lines, keyBase: `${SOURCE}:${now()}` });
      return true;
    },

    // One line for briefings, or nothing when all is quiet.
    summary(): string[] {
      const open = store.observations.listOpen(SOURCE);
      const items = open.map((o) => o.data as ItemData | CiData).filter((d): d is ItemData => d.kind !== "ci");
      const count = (kind: ItemData["kind"], author: ItemData["author"]): number =>
        items.filter((d) => d.kind === kind && d.author === author).length;
      const red = open
        .filter((o) => o.version === "red")
        .map((o) => {
          const data = o.data as CiData;
          return `${short(data.repo)} ${data.workflow}`;
        });
      const parts = [
        plural(count("pr", "bot"), "bot PR"),
        plural(count("pr", "other"), "PR by others", "PRs by others"),
        plural(count("issue", "other"), "issue by others", "issues by others"),
      ].filter((p) => p !== "");
      if (parts.length === 0 && red.length === 0) return [];
      const head = parts.length === 0 ? "GitHub: nothing new." : `GitHub: ${parts.join(", ")}.`;
      return [red.length === 0 ? head : `${head} CI red: ${red.join(", ")}.`];
    },
  };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 0 ? "" : `${n} ${n === 1 ? one : many}`;
}
