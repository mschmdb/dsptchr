import { describe, expect, it } from "vitest";
import { createProtonSource, type ProtonCommand } from "../src/index.ts";
import { WatcherError } from "../src/index.ts";

function source(responses: Record<string, unknown>) {
  const commands: ProtonCommand[] = [];
  const proton = createProtonSource({
    call: async (command) => {
      commands.push(command);
      const key = command.kind === "mail.get" ? `get:${command.id}` : command.kind;
      if (!(key in responses)) throw new Error(`unscripted ${key}`);
      return responses[key];
    },
  });
  return { proton, commands };
}

const T = (iso: string): number => Date.parse(iso) / 1000;

describe("proton source", () => {
  it("lists inbox mail newer than a point in time, oldest first", async () => {
    const { proton, commands } = source({
      "mail.list": {
        messages: [
          { id: "m2", subject: "Newer", from_name: "B", from_address: "b@example.com", time: T("2026-10-27T10:00:00Z"), unread: 1, labels: ["0"] },
          { id: "m1", subject: "Older", from_name: "A", from_address: "a@example.com", time: T("2026-10-27T09:00:00Z"), unread: 0, labels: [] },
          { id: "m0", subject: "Too old", from_name: "A", from_address: "a@example.com", time: T("2026-10-27T07:00:00Z"), unread: 0, labels: [] },
        ],
        has_more: false,
      },
    });
    const mails = await proton.newMail({ since: Date.parse("2026-10-27T08:00:00Z"), now: Date.parse("2026-10-27T10:30:00Z") });
    expect(mails.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(mails[0]).toEqual({ id: "m1", subject: "Older", fromName: "A", fromAddress: "a@example.com", time: Date.parse("2026-10-27T09:00:00Z") });
    expect(commands[0]).toEqual({ kind: "mail.list", folder: "inbox", newerThan: "3h", limit: 50 });
  });

  it("caps the look-back window to seven days", async () => {
    const { proton, commands } = source({ "mail.list": { messages: [], has_more: false } });
    await proton.newMail({ since: 0, now: Date.parse("2026-10-27T10:30:00Z") });
    expect(commands[0]).toMatchObject({ newerThan: "7d" });
  });

  it("reads one message with recipients and a text body", async () => {
    const { proton } = source({
      "get:m1": {
        id: "m1",
        subject: "Hi",
        from: { Address: "a@example.com", Name: "A" },
        to: [{ Address: "user+todo@example.com", Name: "" }],
        cc: [{ Address: "c@example.com", Name: "C" }],
        time: T("2026-10-27T09:00:00Z"),
        body: "Hello",
        mime_type: "text/plain",
      },
    });
    expect(await proton.readMail("m1")).toEqual({
      id: "m1",
      subject: "Hi",
      fromAddress: "a@example.com",
      recipients: ["user+todo@example.com", "c@example.com"],
      time: Date.parse("2026-10-27T09:00:00Z"),
      body: "Hello",
    });
  });

  it("lists calendar events in a range", async () => {
    const { proton, commands } = source({
      "calendar.list": {
        events: [
          {
            id: "e1",
            title: "Dentist",
            location: "",
            start: "2026-10-28T09:00:00+01:00",
            end: "2026-10-28T10:00:00+01:00",
            all_day: false,
            occurrence: "",
            organizer: "",
            status: "confirmed",
          },
        ],
        has_more: false,
      },
    });
    const events = await proton.events({ after: "2026-10-28", before: "2026-10-28" });
    expect(events).toEqual([
      {
        key: "e1",
        title: "Dentist",
        start: Date.parse("2026-10-28T08:00:00Z"),
        end: Date.parse("2026-10-28T09:00:00Z"),
        allDay: false,
        organizer: "",
        cancelled: false,
      },
    ]);
    expect(commands[0]).toEqual({ kind: "calendar.list", after: "2026-10-28", before: "2026-10-28" });
  });

  it("rejects unexpected shapes", async () => {
    const { proton } = source({ "mail.list": { nope: 1 } });
    await expect(proton.newMail({ since: 0, now: 1 })).rejects.toThrow(WatcherError);
  });
});
