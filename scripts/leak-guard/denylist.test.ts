import { describe, expect, it } from "vitest";
import { addedLinesFromDiff, findHits, formatHits, parseDenylist } from "./denylist.ts";

describe("parseDenylist", () => {
  it("returns trimmed, lowercased terms", () => {
    expect(parseDenylist("  Host-A \nACME\n")).toEqual(["host-a", "acme"]);
  });

  it("skips empty lines and comments", () => {
    expect(parseDenylist("# private\n\n   \nhost-a\n  # indented comment\n")).toEqual(["host-a"]);
  });

  it("handles CRLF line endings", () => {
    expect(parseDenylist("host-a\r\nhost-b\r\n")).toEqual(["host-a", "host-b"]);
  });

  it("returns an empty list for an empty file", () => {
    expect(parseDenylist("")).toEqual([]);
  });

  it("deduplicates terms", () => {
    expect(parseDenylist("host-a\nHOST-A\n")).toEqual(["host-a"]);
  });
});

describe("findHits", () => {
  const terms = ["host-a", "acme corp"];

  it("finds case-insensitive matches with line numbers", () => {
    const hits = findHits("line one\nconnect to HOST-A now\n", terms, "file.ts");
    expect(hits).toEqual([{ source: "file.ts", line: 2, termIndex: 0 }]);
  });

  it("finds multiple terms on one line", () => {
    const hits = findHits("Acme Corp runs host-a", terms, "msg");
    expect(hits).toHaveLength(2);
  });

  it("matches inside larger words", () => {
    expect(findHits("myhost-a1", terms, "x")).toHaveLength(1);
  });

  it("returns nothing for clean content", () => {
    expect(findHits("example.com and host-b", terms, "x")).toEqual([]);
  });

  it("returns nothing for an empty denylist", () => {
    expect(findHits("anything", [], "x")).toEqual([]);
  });
});

describe("formatHits", () => {
  it("never prints the denylisted term itself", () => {
    const output = formatHits([{ source: "a.ts", line: 3, termIndex: 1 }]);
    expect(output).toContain("a.ts:3");
    expect(output).toContain("entry #2");
    expect(output).not.toContain("acme");
  });
});

describe("addedLinesFromDiff", () => {
  it("collects added lines per file and the file paths", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,0 +2,2 @@",
      "+const host = 'host-a';",
      "+const ok = 1;",
      "-const removed = 'host-a';",
      "diff --git a/new-host-a.txt b/new-host-a.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new-host-a.txt",
      "@@ -0,0 +1 @@",
      "+hello",
    ].join("\n");

    expect(addedLinesFromDiff(diff)).toEqual([
      { source: "src/a.ts", text: "src/a.ts\nconst host = 'host-a';\nconst ok = 1;" },
      { source: "new-host-a.txt", text: "new-host-a.txt\nhello" },
    ]);
  });

  it("returns nothing for an empty diff", () => {
    expect(addedLinesFromDiff("")).toEqual([]);
  });

  it("keeps added lines that start with +++ inside content", () => {
    const diff = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "++++ plus"].join("\n");
    expect(addedLinesFromDiff(diff)).toEqual([{ source: "x", text: "x\n+++ plus" }]);
  });
});
