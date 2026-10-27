import { wallClockOf } from "@dsptchr/core";
import type { Store } from "@dsptchr/store";
import type { SiteStats } from "@dsptchr/watchers";
import { cursorsFor } from "./alerts.ts";

export const ANALYTICS_SOURCE = "analytics";
const FETCH_FROM_HOUR = 5;
const pad = (n: number): string => String(n).padStart(2, "0");

export interface AnalyticsMonitorDeps {
  store: Store;
  sites: readonly string[];
  fetchStats(site: string, today: string): Promise<SiteStats>;
  now: () => number;
  timeZone: string;
}

// Web analytics of the operator's own sites, fetched once a day before the morning briefing.
export function createAnalyticsMonitor({ store, sites, fetchStats, now, timeZone }: AnalyticsMonitorDeps) {
  const cursors = cursorsFor(store, ANALYTICS_SOURCE);
  const latest = (): SiteStats[] => {
    const raw = cursors.get("latest");
    return raw === undefined ? [] : (JSON.parse(raw) as SiteStats[]);
  };
  const trend = (s: SiteStats): number | undefined =>
    s.previous30 === 0 ? undefined : Math.round(((s.last30 - s.previous30) / s.previous30) * 100);

  return {
    async tick(): Promise<boolean> {
      const w = wallClockOf(now(), timeZone);
      const today = `${w.year}-${pad(w.month)}-${pad(w.day)}`;
      if (w.hour < FETCH_FROM_HOUR || cursors.get("day") === today) return false;
      const results: SiteStats[] = [];
      for (const site of sites) results.push(await fetchStats(site, today));
      cursors.set("latest", JSON.stringify(results));
      cursors.set("day", today);
      return true;
    },

    briefing(): string[] {
      const all = latest();
      if (all.length === 0) return [];
      return [
        "Plausible yesterday:",
        ...all.map((s) => {
          const t = trend(s);
          const change = t === undefined ? "new" : `${t >= 0 ? "+" : ""}${t}% vs. previous 30`;
          return `- ${s.site}: ${s.yesterday.visitors} visitors, ${s.yesterday.pageviews} pageviews · 30 days ${s.last30} (${change})`;
        }),
      ];
    },

    forModel(): Record<string, unknown>[] {
      return latest().map((s) => ({
        site: s.site,
        yesterday_visitors: s.yesterday.visitors,
        yesterday_pageviews: s.yesterday.pageviews,
        visitors_30d: s.last30,
        visitors_previous_30d: s.previous30,
        ...(trend(s) === undefined ? {} : { trend_percent: trend(s) }),
      }));
    },
  };
}
