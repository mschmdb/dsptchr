export type HeartbeatStatus = "ok" | "paused";

export interface HeartbeatDeps {
  // Push URL of the external monitor; it carries a token, so it is a secret.
  url: { reveal(): string };
  intervalMs: number;
  now: () => number;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export type HeartbeatResult = { sent: true } | { sent: false; error?: string };

// Content-free liveness signal, outside gate and executor by design (D-39).
// Errors never include the URL.
export function createHeartbeat({ url, intervalMs, now, fetch = globalThis.fetch, timeoutMs = 10_000 }: HeartbeatDeps) {
  let lastSent: number | undefined;

  return {
    async beat(status: HeartbeatStatus): Promise<HeartbeatResult> {
      if (lastSent !== undefined && now() - lastSent < intervalMs) {
        return { sent: false };
      }
      let target: URL;
      try {
        target = new URL(url.reveal());
      } catch {
        return { sent: false, error: "invalid push URL" };
      }
      if (target.protocol !== "https:" && target.protocol !== "http:") {
        return { sent: false, error: "invalid push URL" };
      }
      target.searchParams.set("status", "up");
      target.searchParams.set("msg", status);

      let response: Response;
      try {
        response = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        return { sent: false, error: "network error" };
      }
      if (!response.ok) {
        return { sent: false, error: `HTTP ${response.status}` };
      }
      lastSent = now();
      return { sent: true };
    },
  };
}
