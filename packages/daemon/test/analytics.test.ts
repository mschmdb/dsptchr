import type { SiteStats } from "@dsptchr/watchers";
import { describe, expect, it } from "vitest";
import { createAnalyticsMonitor } from "../src/analytics.ts";
import { harness, TZ } from "./support/harness.ts";

const stats = (site: string, visitors: number, pageviews: number, last30: number, previous30: number): SiteStats => ({
  site,
  yesterday: { visitors, pageviews },
  last30,
  previous30,
});

function setup(data: Record<string, SiteStats>) {
  const h = harness();
  const calls: [string, string][] = [];
  const monitor = createAnalyticsMonitor({
    store: h.store,
    sites: Object.keys(data),
    fetchStats: async (site, today) => {
      calls.push([site, today]);
      const s = data[site];
      if (s === undefined) throw new Error("unknown");
      return s;
    },
    now: () => h.clock.now,
    timeZone: TZ,
  });
  return { ...h, monitor, calls };
}

describe("analytics monitor", () => {
  it("fetches once per local day after 05:00 and renders a briefing line per site", async () => {
    const h = setup({ "a.example.com": stats("a.example.com", 24, 90, 512, 457), "b.example.com": stats("b.example.com", 0, 0, 3, 0) });
    h.clock.now = Date.parse("2026-10-27T03:00:00Z"); // 04:00 local
    expect(await h.monitor.tick()).toBe(false);
    h.clock.now = Date.parse("2026-10-27T05:00:00Z"); // 06:00 local
    expect(await h.monitor.tick()).toBe(true);
    expect(await h.monitor.tick()).toBe(false);
    expect(h.calls).toEqual([
      ["a.example.com", "2026-10-27"],
      ["b.example.com", "2026-10-27"],
    ]);
    expect(h.monitor.briefing()).toEqual([
      "Plausible yesterday:",
      "- a.example.com: 24 visitors, 90 pageviews · 30 days 512 (+12% vs. previous 30)",
      "- b.example.com: 0 visitors, 0 pageviews · 30 days 3 (new)",
    ]);
  });

  it("shows nothing before the first fetch and keeps the last numbers on errors", async () => {
    const h = setup({ "a.example.com": stats("a.example.com", 1, 2, 10, 20) });
    expect(h.monitor.briefing()).toEqual([]);
    h.clock.now = Date.parse("2026-10-27T05:00:00Z");
    await h.monitor.tick();
    expect(h.monitor.forModel()).toEqual([
      { site: "a.example.com", yesterday_visitors: 1, yesterday_pageviews: 2, visitors_30d: 10, visitors_previous_30d: 20, trend_percent: -50 },
    ]);
  });
});
