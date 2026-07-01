/**
 * Persistent data store for domain entities.
 *
 * Durable data (reports, processing status, group attachment, reply mappings)
 * lives here — never in an in-memory Map or module-level variable (except
 * the in-memory fallback used when REDIS_URL is unset, which is dev/test only).
 *
 * Core rule: NEVER enumerate the keyspace to find records (no KEYS / SCAN /
 * readAll).  Maintain EXPLICIT INDEX records so lookups stay O(1) and don't
 * block Redis.
 *
 * Key naming:
 *   report:<id>                  — a user report
 *   idx:user:<uid>:reports       — report IDs for a user (JSON string[])
 *   report_id_counter            — auto-increment counter
 *   status:<reportId>            — processing status
 *   group_attachment             — the single attached group (JSON {groupId, lastAttachedTimestamp})
 *   reply_map:<groupMessageId>   — moderator reply mapping (JSON {originalReportId, originalUserId})
 *   idx:report:<rid>:reply_msg   — group message ID for a report (for reverse lookup)
 */

import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// Low-level KV abstraction (Redis or in-memory)
// ---------------------------------------------------------------------------

export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  /**
   * Atomic compare-and-set: set `key` to `value` only if the key does NOT
   * already exist. Returns true if the key was set, false if it already existed.
   * Used for distributed locking.
   */
  setnx(key: string, value: string): Promise<boolean>;
  /**
   * Set a TTL (in milliseconds) on an existing key. No-op if the key does not
   * exist. Used to auto-expire locks so a crash between acquire and release
   * doesn't leave a permanent stale lock.
   */
  expire(key: string, ttlMs: number): Promise<void>;
}

/** In-memory fallback (dev / no Redis). */
class MemoryKv implements KvStore {
  private readonly m = new Map<string, string>();
  /** Approximate per-key expiry (ms). Checked on get(). */
  private readonly exp = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    const ttl = this.exp.get(key);
    if (ttl !== undefined && Date.now() > ttl) {
      this.m.delete(key);
      this.exp.delete(key);
      return null;
    }
    return this.m.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.m.set(key, value);
  }
  async del(key: string): Promise<void> {
    this.m.delete(key);
    this.exp.delete(key);
  }
  async setnx(key: string, value: string): Promise<boolean> {
    if (this.m.has(key)) return false;
    this.m.set(key, value);
    return true;
  }
  async expire(key: string, ttlMs: number): Promise<void> {
    if (this.m.has(key)) {
      this.exp.set(key, Date.now() + ttlMs);
    }
  }
}

let _kv: KvStore | undefined;

function kv(): KvStore {
  if (!_kv) {
    const url = process.env.REDIS_URL;
    _kv = url ? createRedisKv(url) : new MemoryKv();
  }
  return _kv;
}

function createRedisKv(url: string): KvStore {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ioredis: any = require("ioredis");
  const Redis = (ioredis.default ?? ioredis.Redis ?? ioredis) as new (...a: unknown[]) => { get: Function; set: Function; del: Function; setnx: Function; pexpire: Function };
  const client = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
  return {
    async get(key: string): Promise<string | null> {
      const v = await client.get(key);
      return (v as string | null) ?? null;
    },
    async set(key: string, value: string): Promise<void> {
      await client.set(key, value);
    },
    async del(key: string): Promise<void> {
      await client.del(key);
    },
    async setnx(key: string, value: string): Promise<boolean> {
      const result = await client.setnx(key, value);
      return result === 1;
    },
    async expire(key: string, ttlMs: number): Promise<void> {
      await client.pexpire(key, ttlMs);
    },
  };
}

// ---------------------------------------------------------------------------
// Domain entity helpers (typed accessors with index management)
// ---------------------------------------------------------------------------

// --- User report ---

export interface UserReport {
  id: string;
  telegramUserId: number;
  timestamp: number;
  content: string;
  mediaReferences: string[];
}

/** Generate a monotonic report ID. */
export async function nextReportId(): Promise<string> {
  const k = "report_id_counter";
  const raw = await kv().get(k);
  const next = (raw ? Number(raw) : 0) + 1;
  await kv().set(k, String(next));
  return `R${String(next).padStart(6, "0")}`;
}

export async function saveReport(r: UserReport): Promise<void> {
  await kv().set(`report:${r.id}`, JSON.stringify(r));
  // Update per-user index
  const idxKey = `idx:user:${r.telegramUserId}:reports`;
  const raw = await kv().get(idxKey);
  const ids: string[] = raw ? JSON.parse(raw) : [];
  ids.push(r.id);
  await kv().set(idxKey, JSON.stringify(ids));
}

export async function getReport(id: string): Promise<UserReport | null> {
  const raw = await kv().get(`report:${id}`);
  return raw ? (JSON.parse(raw) as UserReport) : null;
}

// --- Processing status ---

export type ReportStatus = "pending_review" | "auto_closed" | "responded";

export interface ProcessingStatus {
  reportId: string;
  status: ReportStatus;
  triageResult: "needs_review" | "auto_close";
}

export async function saveProcessingStatus(ps: ProcessingStatus): Promise<void> {
  await kv().set(`status:${ps.reportId}`, JSON.stringify(ps));
}

export async function getProcessingStatus(reportId: string): Promise<ProcessingStatus | null> {
  const raw = await kv().get(`status:${reportId}`);
  return raw ? (JSON.parse(raw) as ProcessingStatus) : null;
}

// --- Attached group ---

export interface AttachedGroup {
  groupId: number;
  lastAttachedTimestamp: number;
}

const GROUP_ATTACHMENT_KEY = "group_attachment";

const ATTACHMENT_LOCK_KEY = "lock:group_attachment";
const LOCK_TTL_MS = 10_000; // 10 seconds — ample for a single KV write

/**
 * Try to acquire the group-attachment lock atomically with an expiry TTL.
 * If the bot crashes between acquire and release, the lock auto-expires
 * after LOCK_TTL_MS and subsequent /attach and /detach operations will work.
 * Returns true if acquired, false if held by another caller.
 */
export async function lockAttachment(ownerId: string): Promise<boolean> {
  const acquired = await kv().setnx(ATTACHMENT_LOCK_KEY, ownerId);
  if (acquired) {
    // Set TTL so a crash between acquire and release doesn't leave a
    // permanent stale lock. Best-effort: if expire fails, the lock lives
    // only for LOCK_TTL_MS from this moment.
    await kv().expire(ATTACHMENT_LOCK_KEY, LOCK_TTL_MS);
  }
  return acquired;
}

/** Release the group-attachment lock. */
export async function unlockAttachment(): Promise<void> {
  await kv().del(ATTACHMENT_LOCK_KEY);
}

/**
 * Try to acquire the lock with a retry loop (best-effort).
 * Returns true if acquired, false if contention persists after `retries` attempts.
 */
export async function lockAttachmentWithRetry(ownerId: string, retries = 5, delayMs = 200): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    if (await lockAttachment(ownerId)) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

export async function saveAttachedGroup(g: AttachedGroup): Promise<void> {
  await kv().set(GROUP_ATTACHMENT_KEY, JSON.stringify(g));
}

export async function getAttachedGroup(): Promise<AttachedGroup | null> {
  const raw = await kv().get(GROUP_ATTACHMENT_KEY);
  return raw ? (JSON.parse(raw) as AttachedGroup) : null;
}

export async function clearAttachedGroup(): Promise<void> {
  await kv().del(GROUP_ATTACHMENT_KEY);
}

// --- Moderator reply mapping ---

export interface ModeratorReplyMapping {
  groupMessageId: number;
  originalReportId: string;
  originalUserId: number;
}

export async function saveReplyMapping(m: ModeratorReplyMapping): Promise<void> {
  await kv().set(`reply_map:${m.groupMessageId}`, JSON.stringify(m));
  // Reverse index: report ID → group message ID
  await kv().set(`idx:report:${m.originalReportId}:reply_msg`, String(m.groupMessageId));
}

export async function getReplyMapping(groupMessageId: number): Promise<ModeratorReplyMapping | null> {
  const raw = await kv().get(`reply_map:${groupMessageId}`);
  return raw ? (JSON.parse(raw) as ModeratorReplyMapping) : null;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Reset the KV store — test-only hook. */
export function _resetStore(): void {
  _kv = undefined;
}

/** Override the KV store — test-only hook. */
export function _setKv(k: KvStore): void {
  _kv = k;
}