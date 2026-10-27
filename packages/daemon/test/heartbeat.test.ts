import { describe, expect, it } from "vitest";
import { createHeartbeat } from "../src/heartbeat.ts";

const URL_SECRET = "https://monitor.example.com/api/push/SECRET-TOKEN";
const T0 = Date.parse("2026-10-27T10:00:00Z");

function setup(respond: (url: string) => Promise<Response> = async () => new Response("{}", { status: 200 })) {
  const clock = { now: T0 };
  const urls: string[] = [];
  const heartbeat = createHeartbeat({
    url: { reveal: () => URL_SECRET },
    intervalMs: 5 * 60_000,
    now: () => clock.now,
    fetch: async (input) => {
      urls.push(String(input));
      return respond(String(input));
    },
  });
  return { heartbeat, clock, urls };
}

describe("heartbeat", () => {
  it("pushes status up with a short message", async () => {
    const { heartbeat, urls } = setup();
    expect(await heartbeat.beat("ok")).toEqual({ sent: true });
    expect(urls).toEqual([`${URL_SECRET}?status=up&msg=ok`]);
  });

  it("reports paused as up, so a deliberate pause does not alarm", async () => {
    const { heartbeat, urls } = setup();
    await heartbeat.beat("paused");
    expect(urls[0]).toContain("status=up&msg=paused");
  });

  it("pushes at most once per interval", async () => {
    const { heartbeat, clock, urls } = setup();
    await heartbeat.beat("ok");
    clock.now += 60_000;
    expect(await heartbeat.beat("ok")).toEqual({ sent: false });
    clock.now += 4 * 60_000;
    await heartbeat.beat("ok");
    expect(urls).toHaveLength(2);
  });

  it("retries on the next beat after a failure, without leaking the URL", async () => {
    const { heartbeat, urls } = setup(async () => new Response("nope", { status: 500 }));
    const result = await heartbeat.beat("ok");
    expect(result).toEqual({ sent: false, error: "HTTP 500" });
    await heartbeat.beat("ok");
    expect(urls).toHaveLength(2);
  });

  it("reports network errors without the URL", async () => {
    const { heartbeat } = setup(async () => {
      throw new TypeError(`fetch failed ${URL_SECRET}`);
    });
    const result = await heartbeat.beat("ok");
    expect(result).toEqual({ sent: false, error: "network error" });
  });

  it("keeps an existing query string intact", async () => {
    const urls: string[] = [];
    const heartbeat = createHeartbeat({
      url: { reveal: () => "https://monitor.example.com/push/x?token=abc" },
      intervalMs: 1,
      now: () => T0,
      fetch: async (input) => {
        urls.push(String(input));
        return new Response("{}");
      },
    });
    await heartbeat.beat("ok");
    expect(urls[0]).toBe("https://monitor.example.com/push/x?token=abc&status=up&msg=ok");
  });

  it("rejects non-http URLs", async () => {
    const heartbeat = createHeartbeat({
      url: { reveal: () => "file:///etc/passwd" },
      intervalMs: 1,
      now: () => T0,
      fetch: async () => new Response("{}"),
    });
    expect(await heartbeat.beat("ok")).toEqual({ sent: false, error: "invalid push URL" });
  });
});
