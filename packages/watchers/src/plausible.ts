import { z } from "zod";
import { WatcherError } from "./server-health/server-health.ts";

export interface SiteStats {
  site: string;
  yesterday: { visitors: number; pageviews: number };
  last30: number;
  previous30: number;
}

const SITE = /^[a-z0-9.-]{1,253}$/i;
const DAY_MS = 86_400_000;
const resultsSchema = z.object({
  results: z.array(z.object({ dimensions: z.array(z.string()), metrics: z.array(z.number()) })),
});

// Plausible Stats API v2 with a read-only key.
export function createPlausibleSource(options: {
  baseUrl: string;
  apiKey: { reveal(): string };
  fetch?: typeof globalThis.fetch;
}) {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:") throw new WatcherError("plausible: base URL must use https");
  const fetch = options.fetch ?? globalThis.fetch;

  async function query(body: Record<string, unknown>): Promise<z.infer<typeof resultsSchema>["results"]> {
    let response: Response;
    try {
      response = await fetch(new URL("/api/v2/query", base).toString(), {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey.reveal()}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new WatcherError("plausible: request failed");
    }
    if (!response.ok) throw new WatcherError(`plausible: HTTP ${response.status}`);
    const parsed = resultsSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new WatcherError("plausible: unexpected response format");
    return parsed.data.results;
  }

  // `today` is the site's local date (YYYY-MM-DD); "yesterday" and the windows end the day before.
  const shift = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

  return {
    async siteStats(site: string, today: string): Promise<SiteStats> {
      if (!SITE.test(site)) throw new WatcherError("plausible: invalid site");
      const yesterday = shift(today, -1);
      const series = await query({
        site_id: site,
        metrics: ["visitors", "pageviews"],
        date_range: [shift(today, -30), yesterday],
        dimensions: ["time:day"],
      });
      // Both windows sum daily visitors, so they compare like with like.
      const previous = await query({
        site_id: site,
        metrics: ["visitors"],
        date_range: [shift(today, -60), shift(today, -31)],
        dimensions: ["time:day"],
      });
      const last = series.find((r) => r.dimensions[0] === yesterday);
      return {
        site,
        yesterday: { visitors: last?.metrics[0] ?? 0, pageviews: last?.metrics[1] ?? 0 },
        last30: series.reduce((sum, r) => sum + (r.metrics[0] ?? 0), 0),
        previous30: previous.reduce((sum, r) => sum + (r.metrics[0] ?? 0), 0),
      };
    },
  };
}
