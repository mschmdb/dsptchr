import { describe, expect, it } from "vitest";
import { createPlausibleSource, WatcherError } from "../src/index.ts";

const KEY = "fake";

function fakeApi(responses: Record<string, unknown>, status = 200) {
  const bodies: Record<string, unknown>[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    expect(String(input)).toBe("https://stats.example.com/api/v2/query");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const key = (body["metrics"] as string[]).length === 2 ? "series" : "previous";
    return new Response(JSON.stringify(responses[key]), { status });
  };
  return { fetch, bodies };
}

const source = (fetch: typeof globalThis.fetch) =>
  createPlausibleSource({ baseUrl: "https://stats.example.com", apiKey: { reveal: () => KEY }, fetch });

describe("plausible source", () => {
  it("returns yesterday, the last 30 days and the 30 days before", async () => {
    const { fetch, bodies } = fakeApi({
      series: {
        results: [
          { dimensions: ["2026-10-01"], metrics: [10, 20] },
          { dimensions: ["2026-10-26"], metrics: [24, 90] },
        ],
      },
      previous: { results: [{ dimensions: ["2026-09-01"], metrics: [7] }, { dimensions: ["2026-09-02"], metrics: [10] }] },
    });
    const stats = await source(fetch).siteStats("site-a.example.com", "2026-10-27");
    expect(stats).toEqual({ site: "site-a.example.com", yesterday: { visitors: 24, pageviews: 90 }, last30: 34, previous30: 17 });
    expect(bodies).toEqual([
      { site_id: "site-a.example.com", metrics: ["visitors", "pageviews"], date_range: ["2026-09-27", "2026-10-26"], dimensions: ["time:day"] },
      { site_id: "site-a.example.com", metrics: ["visitors"], date_range: ["2026-08-28", "2026-09-26"], dimensions: ["time:day"] },
    ]);
  });

  it("counts a day without visits as zero", async () => {
    const { fetch } = fakeApi({
      series: { results: [{ dimensions: ["2026-10-20"], metrics: [5, 6] }] },
      previous: { results: [] },
    });
    const stats = await source(fetch).siteStats("site-a.example.com", "2026-10-27");
    expect(stats.yesterday).toEqual({ visitors: 0, pageviews: 0 });
  });

  it("rejects non-https base URLs and malformed site IDs", () => {
    expect(() => createPlausibleSource({ baseUrl: "http://stats.example.com", apiKey: { reveal: () => KEY } })).toThrow(WatcherError);
    return expect(source(fakeApi({}).fetch).siteStats("bad site", "2026-10-27")).rejects.toThrow(WatcherError);
  });

  it("reports HTTP errors without the key", async () => {
    const error = await source(fakeApi({ series: {} }, 401).fetch).siteStats("site-a.example.com", "2026-10-27").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WatcherError);
    expect(String(error)).toContain("401");
    expect(String(error)).not.toContain(KEY);
  });

  it("rejects unexpected responses", async () => {
    await expect(source(fakeApi({ series: { nope: 1 } }).fetch).siteStats("site-a.example.com", "2026-10-27")).rejects.toThrow(/unexpected/);
  });
});
