import type { HealthFinding, HealthReport } from "@dsptchr/watchers";
import { describe, expect, it } from "vitest";
import { createHealthMonitor } from "../src/health.ts";
import { harness } from "./support/harness.ts";

const crit = (key: string, host: string, text: string): HealthFinding => ({ key, severity: "crit", host, text });
const warn = (key: string, host: string, text: string): HealthFinding => ({ key, severity: "warn", host, text });
const info = (key: string, host: string, text: string): HealthFinding => ({ key, severity: "info", host, text });

function setup() {
  const h = harness();
  const reports: (HealthReport | Error)[] = [];
  let calls = 0;
  const monitor = createHealthMonitor({
    store: h.store,
    dispatcher: h.dispatcher,
    check: async () => {
      calls++;
      const next = reports.shift();
      if (next === undefined) throw new Error("no report scripted");
      if (next instanceof Error) throw next;
      return next;
    },
    intervalMs: 15 * 60_000,
    now: () => h.clock.now,
  });
  const run = async (report: HealthReport | Error) => {
    reports.push(report);
    return monitor.tick();
  };
  const later = () => {
    h.clock.now += 15 * 60_000;
  };
  return { ...h, monitor, run, later, calls: () => calls };
}

const hosts = ["host-a", "host-b"];

describe("health monitor", () => {
  it("reports new warn and crit findings in one message and ignores info", async () => {
    const h = setup();
    await h.run({
      findings: [crit("host-a:disk", "host-a", "Disk 95% full"), warn("host-b:mem", "host-b", "Memory 85%"), info("host-a:reboot", "host-a", "Reboot")],
      evaluatedHosts: hosts,
    });
    expect(h.sent[0]?.text).toBe("Server health\n1. CRIT host-a: Disk 95% full\n2. WARN host-b: Memory 85%");
    expect(h.sent[0]?.buttons).toHaveLength(2);
  });

  it("stays quiet when nothing changed", async () => {
    const h = setup();
    const report = { findings: [warn("host-b:mem", "host-b", "Memory 85%")], evaluatedHosts: hosts };
    await h.run(report);
    h.later();
    await h.run({ findings: [warn("host-b:mem", "host-b", "Memory 86%")], evaluatedHosts: hosts });
    expect(h.sent).toHaveLength(1);
  });

  it("reports an escalation and a resolution", async () => {
    const h = setup();
    await h.run({ findings: [warn("host-b:mem", "host-b", "Memory 85%"), warn("host-a:load", "host-a", "Load 9")], evaluatedHosts: hosts });
    h.later();
    await h.run({ findings: [crit("host-b:mem", "host-b", "Memory 96%")], evaluatedHosts: hosts });
    expect(h.sent.at(-1)?.text).toBe("Server health\n1. CRIT host-b: Memory 96% (was warn)\n2. resolved: host-a:load");
  });

  it("does not resolve findings of hosts the check skipped", async () => {
    const h = setup();
    await h.run({ findings: [warn("host-b:mem", "host-b", "Memory 85%")], evaluatedHosts: hosts });
    h.later();
    await h.run({ findings: [], evaluatedHosts: ["host-a"] });
    expect(h.sent).toHaveLength(1);
    expect(h.store.observations.listOpen("server-health").map((o) => o.externalId)).toEqual(["host-b:mem"]);
  });

  it("runs at most once per interval", async () => {
    const h = setup();
    await h.run({ findings: [], evaluatedHosts: hosts });
    expect(await h.monitor.tick()).toBe(false);
    expect(h.calls()).toBe(1);
  });

  it("does not run while paused", async () => {
    const h = setup();
    h.store.flags.setPaused(true, "operator");
    expect(await h.monitor.tick()).toBe(false);
    expect(h.calls()).toBe(0);
  });

  it("keeps changes unrecorded when the message could not be sent, so the next run reports them", async () => {
    const h = setup();
    h.failSends.value = true;
    await h.run({ findings: [crit("host-a:disk", "host-a", "Disk 95% full")], evaluatedHosts: hosts });
    expect(h.store.observations.listOpen("server-health")).toEqual([]);

    h.failSends.value = false;
    h.later();
    await h.run({ findings: [crit("host-a:disk", "host-a", "Disk 95% full")], evaluatedHosts: hosts });
    expect(h.sent).toHaveLength(1);
    expect(h.store.observations.listOpen("server-health")).toHaveLength(1);
  });

  it("sanitizes untrusted text before it reaches the message", async () => {
    const h = setup();
    await h.run({
      findings: [crit("host-a:ctr:x‮:state", "host-a", `Container x\u0000 restarting\n${"y".repeat(400)}`)],
      evaluatedHosts: hosts,
    });
    const text = h.sent[0]?.text ?? "";
    expect(text).not.toMatch(/[\u0000‮]/);
    expect(text.split("\n")).toHaveLength(2);
    expect(text.length).toBeLessThan(260);
  });

  it("retries the failure alert until it is delivered", async () => {
    const h = setup();
    h.failSends.value = true;
    for (let i = 0; i < 3; i++) {
      await h.run(new Error("exit code 255"));
      h.later();
    }
    expect(h.sent).toEqual([]);
    h.failSends.value = false;
    await h.run(new Error("exit code 255"));
    h.later();
    await h.run(new Error("exit code 255"));
    expect(h.sent).toHaveLength(1);
  });

  it("splits large incidents into messages within the size limit and records each delivered part", async () => {
    const h = setup();
    const findings = Array.from({ length: 60 }, (_, i) => crit(`host-a:check${i}`, "host-a", `${"z".repeat(140)} ${i}`));
    await h.run({ findings, evaluatedHosts: hosts });

    expect(h.sent.length).toBeGreaterThan(1);
    expect(h.sent.every((m) => m.text.length <= 4096)).toBe(true);
    expect(h.sent.flatMap((m) => m.text.split("\n").filter((l) => /^\d+\. /.test(l)))).toHaveLength(60);
    expect(h.store.observations.listOpen("server-health")).toHaveLength(60);
  });

  it("alerts once after three consecutive check failures and again after recovery", async () => {
    const h = setup();
    for (let i = 0; i < 4; i++) {
      await h.run(new Error("exit code 255"));
      h.later();
    }
    expect(h.sent.map((m) => m.text)).toEqual(["Server health check failed 3 times in a row (Error). Last success: never."]);

    await h.run({ findings: [], evaluatedHosts: hosts });
    h.later();
    for (let i = 0; i < 3; i++) {
      await h.run(new Error("exit code 255"));
      h.later();
    }
    expect(h.sent).toHaveLength(2);
  });
});
