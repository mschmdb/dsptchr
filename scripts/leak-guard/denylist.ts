export interface Hit {
  source: string;
  line: number;
  termIndex: number;
}

export interface ScanInput {
  source: string;
  text: string;
}

export function parseDenylist(content: string): string[] {
  const terms = content
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line !== "" && !line.startsWith("#"));
  return [...new Set(terms)];
}

export function findHits(content: string, terms: readonly string[], source: string): Hit[] {
  const hits: Hit[] = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    terms.forEach((term, termIndex) => {
      if (lower.includes(term)) {
        hits.push({ source, line: index + 1, termIndex });
      }
    });
  });
  return hits;
}

// Deliberately prints only the entry number: CI logs may be public, the terms are not.
export function formatHits(hits: readonly Hit[]): string {
  return hits
    .map((hit) => `  ${hit.source}:${hit.line} matches denylist entry #${hit.termIndex + 1}`)
    .join("\n");
}

// Parses `git diff --cached -U0` output. The file path is part of the scanned text,
// so a private term in a file name is caught as well.
export function addedLinesFromDiff(diff: string): ScanInput[] {
  const files: { source: string; lines: string[] }[] = [];
  let current: { source: string; lines: string[] } | undefined;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = undefined;
      inHunk = false;
    } else if (!inHunk && line.startsWith("+++ ")) {
      const path = line.slice(4);
      if (path !== "/dev/null") {
        current = { source: path.replace(/^b\//, ""), lines: [] };
        files.push(current);
      }
    } else if (line.startsWith("@@")) {
      inHunk = true;
    } else if (inHunk && current && line.startsWith("+")) {
      current.lines.push(line.slice(1));
    }
  }

  return files.map((file) => ({ source: file.source, text: [file.source, ...file.lines].join("\n") }));
}
