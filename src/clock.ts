/**
 * Injectable clock — the ONE seam for every "current time" decision.
 * All schedule, cutoff, "today", expiry, and late/on-time decisions
 * route through `now()` instead of calling `new Date()` / `Date.now()`
 * inline. Override via `setNow()` in tests.
 *
 *   import { now } from "./clock.js";
 *   if (elapsed(ts) > 3600_000) ...   // 1 hour
 *   const cutoff = new Date(now() - 86_400_000);  // 24 h ago
 */

let _now: (() => number) | undefined;

/** Returns the current time as Unix-milliseconds. */
export function now(): number {
  return _now ? _now() : Date.now();
}

/**
 * Override the clock in tests. Call `setNow(() => 1_700_000_000_000)`
 * to freeze time, or `setNow(undefined)` to restore Date.now().
 */
export function setNow(fn: (() => number) | undefined): void {
  _now = fn;
}

/** Seconds elapsed since `ts` (also accepts ms). Always returns >= 0. */
export function elapsed(ts: number): number {
  return Math.max(0, now() - ts) / 1000;
}
