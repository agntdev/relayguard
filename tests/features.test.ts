import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildBot, type Ctx } from "../src/bot.js";
import { runSpecs, parseBotSpec } from "../src/toolkit/index.js";
import { setCheckIsAdmin } from "../src/permissions.js";
import { _resetStore, _setKv } from "../src/store.js";
import { setNow } from "../src/clock.js";
import { setTriage } from "../src/triage.js";

/** A fake KV store for testing. */
class TestKv {
  private m = new Map<string, string>();
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.m.get(key) ?? null);
  }
  set(key: string, value: string): Promise<void> {
    this.m.set(key, value);
    return Promise.resolve();
  }
  del(key: string): Promise<void> {
    this.m.delete(key);
    return Promise.resolve();
  }
  setnx(key: string, value: string): Promise<boolean> {
    if (this.m.has(key)) return Promise.resolve(false);
    this.m.set(key, value);
    return Promise.resolve(true);
  }
  /** Reset all stored data. */
  clear(): void {
    this.m.clear();
  }
}

function makeBot() {
  const bot = buildBot("test-token");
  return bot as unknown as ReturnType<typeof buildBot>;
}

async function bot(...args: Parameters<typeof buildBot>) {
  return buildBot(...args);
}

describe("report submission flow", () => {
  let kv: TestKv;

  beforeEach(() => {
    kv = new TestKv();
    _setKv(kv);
    setNow(() => 1_700_000_000_000);
    setTriage(async (_content, _mediaCount) => "auto_close");
    setCheckIsAdmin(async (_ctx: Ctx) => true);
  });

  afterEach(() => {
    _resetStore();
    setNow(undefined);
    setTriage(undefined);
    setCheckIsAdmin(undefined);
    kv.clear();
  });

  it("Submit Report button shows prompt when no group attached", async () => {
    const suite = await runSpecs(() => buildBot("test"), [
      parseBotSpec({
        name: "no group configured",
        steps: [
          {
            send: { callback: "submit_report:start" },
            expect: [
              { method: "answerCallbackQuery" },
              { method: "editMessageText", payload: { text: "⚠️ Report submission isn't available yet — no moderation group is configured." } },
            ],
          },
        ],
      }),
    ]);
    expect(suite.failed).toBe(0);
  });

  it("Submit Report flow works when group is attached", async () => {
    // Pre-setup: attach a group
    await kv.set("group_attachment", JSON.stringify({ groupId: -100123, lastAttachedTimestamp: 1_700_000_000_000 }));

    const suite = await runSpecs(() => buildBot("test"), [
      parseBotSpec({
        name: "start report flow with group attached",
        steps: [
          {
            send: { callback: "submit_report:start" },
            expect: [
              { method: "answerCallbackQuery" },
              {
                method: "editMessageText",
                payload: { text: "📝 Please describe your issue or feedback below." },
              },
            ],
          },
        ],
      }),
    ]);
    expect(suite.failed).toBe(0);
  });

  it("user message during report flow is acknowledged and auto-closed", async () => {
    await kv.set("group_attachment", JSON.stringify({ groupId: -100123, lastAttachedTimestamp: 1_700_000_000_000 }));
    setTriage(async (_content: string, _mediaCount: number) => "auto_close");

    const suite = await runSpecs(() => buildBot("test"), [
      parseBotSpec({
        name: "report text auto-closes",
        steps: [
          // First start the flow
          {
            send: { callback: "submit_report:start" },
            expect: [
              { method: "answerCallbackQuery" },
              { method: "editMessageText" },
            ],
          },
          // Then send the report text
          {
            send: { text: "I noticed a typo on your site." },
            expect: [
              { method: "sendMessage", payload: { text: "✓ Thanks! Your report has been received. We've reviewed it and no further action is needed." } },
            ],
          },
        ],
      }),
    ]);
    expect(suite.failed).toBe(0);
  });

  it("user message during report flow forwards to group when triage needs review", async () => {
    await kv.set("group_attachment", JSON.stringify({ groupId: -100123, lastAttachedTimestamp: 1_700_000_000_000 }));
    setTriage(async (_content: string, _mediaCount: number) => "needs_review");

    const suite = await runSpecs(() => buildBot("test"), [
      parseBotSpec({
        name: "report text forwards to group",
        steps: [
          {
            send: { callback: "submit_report:start" },
            expect: [
              { method: "answerCallbackQuery" },
              { method: "editMessageText" },
            ],
          },
          {
            send: { text: "The payment system is broken and I can't check out!" },
            expect: [
              { method: "sendMessage", payload: { text: "✓ Thanks! Your report has been received and forwarded to our moderation team. We'll get back to you." } },
            ],
          },
        ],
      }),
    ]);
    expect(suite.failed).toBe(0);
  });
});

describe("admin commands", () => {
  let kv: TestKv;

  beforeEach(() => {
    kv = new TestKv();
    _setKv(kv);
    setCheckIsAdmin(async (_ctx: Ctx) => true);
  });

  afterEach(() => {
    _resetStore();
    setCheckIsAdmin(undefined);
    kv.clear();
  });

  it("/attach fails in private chat", async () => {
    const suite = await runSpecs(() => buildBot("test"), [
      parseBotSpec({
        name: "attach in private",
        steps: [
          {
            send: { text: "/attach" },
            expect: [
              { method: "sendMessage", payload: { text: "⚠️ /attach must be used in a group where you're an admin." } },
            ],
          },
        ],
      }),
    ]);
    expect(suite.failed).toBe(0);
  });

  it("/detach fails in private chat", async () => {
    const suite = await runSpecs(() => buildBot("test"), [
      parseBotSpec({
        name: "detach in private",
        steps: [
          {
            send: { text: "/detach" },
            expect: [
              { method: "sendMessage", payload: { text: "⚠️ /detach must be used in the moderation group." } },
            ],
          },
        ],
      }),
    ]);
    expect(suite.failed).toBe(0);
  });

  it("/detach with no attached group notifies user", async () => {
    const suite = await runSpecs(() => buildBot("test"), [
      parseBotSpec({
        name: "detach with no group",
        steps: [
          // Send /detach from a group chat (raw update)
          {
            send: {
              update: {
                update_id: 1,
                message: {
                  message_id: 1,
                  date: 0,
                  chat: { id: -100123, type: "group", title: "Test Group" },
                  from: { id: 99, is_bot: false, first_name: "Admin" },
                  text: "/detach",
                  entities: [{ type: "bot_command" as const, offset: 0, length: 7 }],
                },
              },
            },
            expect: [
              { method: "sendMessage", payload: { text: "⚠️ This group is not currently set as the moderation group." } },
            ],
          },
        ],
      }),
    ]);
    expect(suite.failed).toBe(0);
  });

  it("non-admin cannot attach group", async () => {
    // Override checkIsAdmin to return false for this test
    setCheckIsAdmin(async () => false);

    const suite = await runSpecs(() => buildBot("test"), [
      parseBotSpec({
        name: "non-admin attach",
        steps: [
          {
            send: {
              update: {
                update_id: 1,
                message: {
                  message_id: 1,
                  date: 0,
                  chat: { id: -100123, type: "group", title: "Test Group" },
                  from: { id: 99, is_bot: false, first_name: "User" },
                  text: "/attach",
                  entities: [{ type: "bot_command" as const, offset: 0, length: 7 }],
                },
              },
            },
            expect: [
              { method: "sendMessage", payload: { text: "⚠️ Only group admins can attach the moderation group." } },
            ],
          },
        ],
      }),
    ]);
    expect(suite.failed).toBe(0);
  });

  it("/attach works from a group when no group is currently attached", async () => {
    const suite = await runSpecs(() => buildBot("test"), [
      parseBotSpec({
        name: "attach group",
        steps: [
          {
            send: {
              update: {
                update_id: 1,
                message: {
                  message_id: 1,
                  date: 0,
                  chat: { id: -100123, type: "group", title: "Test Group" },
                  from: { id: 99, is_bot: false, first_name: "Admin" },
                  text: "/attach",
                  entities: [{ type: "bot_command" as const, offset: 0, length: 7 }],
                },
              },
            },
            expect: [
              { method: "sendMessage", payload: { text: "✓ This group is now set as the moderation group. Reports will be forwarded here." } },
            ],
          },
        ],
      }),
    ]);
    expect(suite.failed).toBe(0);
  });
});

describe("moderator reply flow", () => {
  let kv: TestKv;

  beforeEach(async () => {
    kv = new TestKv();
    _setKv(kv);
    setCheckIsAdmin(async (_ctx: Ctx) => true);
    setNow(() => 1_700_000_000_000);

    // Pre-setup: attach a group and store a reply mapping as if a report was forwarded
    await kv.set("group_attachment", JSON.stringify({ groupId: -100123, lastAttachedTimestamp: 1_700_000_000_000 }));
    await kv.set("reply_map:500", JSON.stringify({ groupMessageId: 500, originalReportId: "R000001", originalUserId: 123 }));
    await kv.set("report:R000001", JSON.stringify({
      id: "R000001",
      telegramUserId: 123,
      timestamp: 1_700_000_000_000,
      content: "Test report",
      mediaReferences: [] as string[],
    }));
    await kv.set("status:R000001", JSON.stringify({
      reportId: "R000001",
      status: "pending_review",
      triageResult: "needs_review" as const,
    }));
  });

  afterEach(() => {
    _resetStore();
    setCheckIsAdmin(undefined);
    setNow(undefined);
    kv.clear();
  });

  it("moderator reply to forwarded report is relayed to the user", async () => {
    const suite = await runSpecs(() => buildBot("test"), [
      parseBotSpec({
        name: "moderator reply",
        steps: [
          {
            send: {
              update: {
                update_id: 1,
                message: {
                  message_id: 501,
                  date: 0,
                  chat: { id: -100123, type: "group", title: "Mod Group" },
                  from: { id: 99, is_bot: false, first_name: "Mod" },
                  text: "Thanks for reporting, we'll fix it!",
                  reply_to_message: {
                    message_id: 500,
                    date: 0,
                    chat: { id: -100123, type: "group", title: "Mod Group" },
                    from: { id: 42, is_bot: true, first_name: "TestBot", username: "test_bot" },
                    text: "New report R000001 from user 123:\n\nTest report",
                  },
                },
              },
            },
            expect: [
              // Should send to the original user AND reply in group
              { method: "sendMessage", payload: { chat_id: 123 } },
              { method: "sendMessage", payload: { text: "✓ Reply forwarded to the user." } },
            ],
          },
        ],
      }),
    ]);
    expect(suite.failed).toBe(0);
  });
});
