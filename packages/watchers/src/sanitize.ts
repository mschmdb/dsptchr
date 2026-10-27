// Control characters, bidi overrides and zero-width characters.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;

// Makes untrusted source text safe to show to the operator: no hidden characters,
// one line, bounded length. It does not make the text trustworthy for a model.
export function sanitizeUntrusted(text: string, maxLength: number): string {
  if (typeof text !== "string") return "";
  const clean = text.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength - 1)}…`;
}
