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
}

/** In-memory fallback (dev / no Redis). */
class MemoryKv implements KvStore {
  private readonly m = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.m.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.m.set(key, value);
  }
  async del(key: string): Promise<void> {
    this.m.delete(key);
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
  const Redis = (ioredis.default ?? ioredis.Redis ?? ioredis) as new (...a: unknown[]) => { get: Function; set: Function; del: Function };
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