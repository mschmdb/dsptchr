import { describe, expect, it } from "vitest";
import { sanitizeUntrusted } from "../src/sanitize.ts";

describe("sanitizeUntrusted", () => {
  it("keeps ordinary text", () => {
    expect(sanitizeUntrusted("Disk 93% voll, 4 GB frei", 200)).toBe("Disk 93% voll, 4 GB frei");
  });

  it("removes control and bidi override characters", () => {
    expect(sanitizeUntrusted("a\u0000b\u001bc‮d⁦e​f", 200)).toBe("abcdef");
  });

  it("collapses whitespace and newlines into single spaces", () => {
    expect(sanitizeUntrusted("  line1\n\n\tline2  ", 200)).toBe("line1 line2");
  });

  it("truncates with an ellipsis", () => {
    expect(sanitizeUntrusted("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("returns an empty string for non-strings", () => {
    expect(sanitizeUntrusted(undefined as never, 10)).toBe("");
  });
});
