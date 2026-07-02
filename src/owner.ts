/**
 * Owner identification with deploy-time fallback.
 *
 * Priority order:
 *  1. process.env.OWNER_ID (explicit env var — highest priority)
 *  2. BUILD_METADATA.OWNER_TELEGRAM_ID (deployment platform metadata)
 *  3. .owner-id file in the working directory (created by deploy step)
 *  4. null — no owner configured
 *
 * Import:
 *   import { getOwnerId } from "./owner.js";
 *   const ownerId = getOwnerId();  // number | null
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_FILE = ".owner-id";

// ---------------------------------------------------------------------------
// Test override — set via setOwnerIdOverride() in tests.
// ---------------------------------------------------------------------------

let _override: (() => number | null) | undefined;

/**
 * Resolve the owner Telegram user ID.
 * Returns null when no owner can be discovered.
 */
export function getOwnerId(): number | null {
  if (_override) return _override();

  // 1. Explicit env var
  const raw = process.env.OWNER_ID;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    console.warn("[owner] OWNER_ID is not a valid number, ignoring");
  }

  // 2. BUILD_METADATA (JSON with OWNER_TELEGRAM_ID)
  const metaRaw = process.env.BUILD_METADATA;
  if (metaRaw) {
    try {
      const meta = JSON.parse(metaRaw) as Record<string, unknown>;
      const tid = meta.OWNER_TELEGRAM_ID;
      if (tid != null) {
        const n = Number(tid);
        if (Number.isFinite(n)) return n;
        console.warn("[owner] BUILD_METADATA.OWNER_TELEGRAM_ID is not a valid number, ignoring");
      }
    } catch {
      console.warn("[owner] BUILD_METADATA is not valid JSON, ignoring");
    }
  }

  // 3. .owner-id config file
  try {
    const configPath = join(process.cwd(), CONFIG_FILE);
    const content = readFileSync(configPath, "utf8").trim();
    if (content) {
      const n = Number(content);
      if (Number.isFinite(n)) return n;
      console.warn("[owner] .owner-id file does not contain a valid number, ignoring");
    }
  } catch {
    // File doesn't exist or can't be read — expected when not deployed.
  }

  // 4. Nothing found — log a single actionable warning.
  console.warn(
    "[owner] OWNER_ID is not set and no deploy-time owner metadata was found. " +
    "Set OWNER_ID=<telegram_user_id> in the environment to enable /attach.",
  );

  return null;
}

/**
 * Override the owner resolution for tests.
 * Pass `undefined` to restore the default resolution.
 *
 *   setOwnerIdOverride(() => 42);      // pretend owner is user 42
 *   setOwnerIdOverride(undefined);      // restore real resolution
 */
export function setOwnerIdOverride(fn: (() => number | null) | undefined): void {
  _override = fn;
}