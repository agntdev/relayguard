/**
 * Report triage — determines if a user report needs human moderator review.
 *
 * The spec says "AI triage implementation details are not specified", so this
 * module provides an injectable `triage()` function. The default implementation
 * uses simple keyword heuristics as a stand-in for an AI classifier; a real
 * deployment swaps in an LLM call or ML model by calling `setTriage(fn)`.
 *
 * Import:
 *   import { triage } from "./triage.js";
 *   const result = await triage(content, mediaCount);
 *   // → "needs_review" | "auto_close"
 */

export type TriageResult = "needs_review" | "auto_close";

/** The triage function signature — injectable via setTriage(). */
export type TriageFn = (content: string, mediaCount: number) => Promise<TriageResult>;

let _triage: TriageFn | undefined;

const URGENT_KEYWORDS = [
  "urgent", "emergency", "help", "critical", "bug", "broken",
  "issue", "problem", "error", "not working", "crash", "failed",
  "blocked", "cannot", "unable to", "down", "outage",
];

/**
 * Default triage: content with urgency keywords or media triggers review.
 * Otherwise auto-closes. This is a stand-in for a real AI classifier.
 */
export async function defaultTriage(content: string, mediaCount: number): Promise<TriageResult> {
  const lower = content.toLowerCase();
  const hasUrgent = URGENT_KEYWORDS.some((kw) => lower.includes(kw));
  if (hasUrgent || mediaCount > 0) return "needs_review";
  // Short messages without explicit keywords are auto-closed with a reply
  return "auto_close";
}

/** Call this to triage a report. Uses the injected function, or default. */
export async function triage(content: string, mediaCount: number): Promise<TriageResult> {
  const fn = _triage ?? defaultTriage;
  return fn(content, mediaCount);
}

/** Override the triage function (for tests). Pass undefined to restore default. */
export function setTriage(fn: TriageFn | undefined): void {
  _triage = fn;
}
