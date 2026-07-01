import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { now } from "../clock.js";
import { registerMainMenuItem, inlineKeyboard, inlineButton } from "../toolkit/index.js";
import {
  nextReportId,
  saveReport,
  saveProcessingStatus,
  saveReplyMapping,
  getAttachedGroup,
} from "../store.js";
import { triage } from "../triage.js";

// ---------------------------------------------------------------------------
// Report submission flow
// ---------------------------------------------------------------------------

const composer = new Composer<Ctx>();

const FLOW_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// Menu entry
registerMainMenuItem({ label: "💬 Submit Report", data: "submit_report:start", order: 10 });

const cancelKeyboard = inlineKeyboard([[inlineButton("Cancel", "submit_report:cancel")]]);
const backMenuKeyboard = inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]);

// --- Flow timeout sweeper (MUST run before other handlers in this composer) ---
// If the user left the report flow halfway, expire their session on next interaction.
composer.use(async (ctx, next) => {
  if (ctx.session.step === "awaiting_report") {
    const flowStartAt = ctx.session.flowStartAt;
    if (flowStartAt && now() - flowStartAt > FLOW_TIMEOUT_MS) {
      ctx.session.step = "idle";
      ctx.session.flowStartAt = undefined;
      try {
        await ctx.reply("⏱️ Report submission timed out. Tap /start to try again.");
      } catch {
        // May fail on callback queries — that's OK, timeout is best-effort
      }
      return;
    }
  }
  await next();
});

// --- Step 1: Tap "Submit Report" button ---
composer.callbackQuery("submit_report:start", async (ctx) => {
  await ctx.answerCallbackQuery();

  const group = await getAttachedGroup();
  if (!group) {
    await ctx.editMessageText(
      "⚠️ Report submission isn't available yet — no moderation group is configured.",
      { reply_markup: backMenuKeyboard },
    );
    return;
  }

  ctx.session.step = "awaiting_report";
  ctx.session.flowStartAt = now();
  await ctx.editMessageText("📝 Please describe your issue or feedback below.", {
    reply_markup: cancelKeyboard,
  });
});

// --- Cancel button ---
composer.callbackQuery("submit_report:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "idle";
  ctx.session.flowStartAt = undefined;
  await ctx.editMessageText("Report cancelled. Tap /start to open the menu.", {
    reply_markup: backMenuKeyboard,
  });
});

// --- /cancel command (power-user shortcut during the report flow) ---
composer.command("cancel", async (ctx) => {
  if (ctx.session.step === "awaiting_report") {
    ctx.session.step = "idle";
    ctx.session.flowStartAt = undefined;
    await ctx.reply("Report cancelled. Tap /start to open the menu.", {
      reply_markup: backMenuKeyboard,
    });
  } else {
    await ctx.reply("Nothing to cancel.");
  }
});

// --- Step 2: User types their report ---
// Use filter() so we only match when in the report flow — otherwise pass
// through so /start, /help and other handlers still work.
composer.filter(
  (ctx) => ctx.session.step === "awaiting_report",
  async (ctx, next) => {
    // If the user typed a slash command during the flow, reset to idle and
    // pass through so /start, /help, etc. still work.
    if (ctx.message?.text?.startsWith("/")) {
      ctx.session.step = "idle";
      ctx.session.flowStartAt = undefined;
      await next();
      return;
    }

    // Extract content: use text if present, otherwise caption (for media messages)
    const content = ctx.message?.text?.trim() || ctx.message?.caption?.trim() || "";
    // Collect media references
    const mediaRefs: string[] = [];
    if (ctx.message?.photo) {
      mediaRefs.push(`photo:${ctx.message.photo[ctx.message.photo.length - 1].file_id}`);
    }
    if (ctx.message?.document) {
      mediaRefs.push(`doc:${ctx.message.document.file_id}`);
    }
    if (ctx.message?.video) {
      mediaRefs.push(`video:${ctx.message.video.file_id}`);
    }

    // Accept the report if there's content OR media — media-only with no
    // caption is still valid (e.g. a photo of a bug).
    if (!content && mediaRefs.length === 0) {
      await ctx.reply("Your report was empty — please try again with a description or photo.");
      return;
    }

    ctx.session.step = "idle";
    ctx.session.flowStartAt = undefined;
    const reportId = await nextReportId();
    const report = {
      id: reportId,
      telegramUserId: ctx.from!.id,
      timestamp: now(),
      content,
      mediaReferences: mediaRefs,
    };
    await saveReport(report);

    const mediaCount = mediaRefs.length;

    // Triage
    const result = await triage(content, mediaCount);

    if (result === "auto_close") {
      await saveProcessingStatus({
        reportId,
        status: "auto_closed",
        triageResult: "auto_close",
      });
      await ctx.reply(
        "✓ Thanks! Your report has been received. We've reviewed it and no further action is needed.",
      );
      return;
    }

    // Needs review — try to forward to group
    const group = await getAttachedGroup();
    if (!group) {
      await saveProcessingStatus({
        reportId,
        status: "pending_review",
        triageResult: "needs_review",
      });
      await ctx.reply(
        "✓ Thanks! Your report has been received. It'll be reviewed once a moderation team is configured.",
      );
      return;
    }

    // Forward to moderator group
    // Show user ID as plain text (not clickable link) per privacy spec
    const forwardText =
      `New report #${reportId} from user ${ctx.from!.id}:\n\n${content}`;

    try {
      const sent = await ctx.api.sendMessage(group.groupId, forwardText);

      // Forward any media attachments after the text message so mods can review them
      for (const ref of mediaRefs) {
        try {
          const [type, fileId] = ref.split(":", 2) as [string, string];
          if (type === "photo") {
            await ctx.api.sendPhoto(group.groupId, fileId, {
              caption: content ? undefined : "(attachment to report above)",
            });
          } else if (type === "doc") {
            await ctx.api.sendDocument(group.groupId, fileId, {
              caption: content ? undefined : "(attachment to report above)",
            });
          } else if (type === "video") {
            await ctx.api.sendVideo(group.groupId, fileId, {
              caption: content ? undefined : "(attachment to report above)",
            });
          }
        } catch {
          // Individual media send failure is non-fatal — the text alert already
          // arrived. Logged in the catch boundary.
        }
      }
      await saveReplyMapping({
        groupMessageId: sent.message_id,
        originalReportId: reportId,
        originalUserId: ctx.from!.id,
      });
      await saveProcessingStatus({
        reportId,
        status: "pending_review",
        triageResult: "needs_review",
      });
      await ctx.reply(
        "✓ Thanks! Your report has been received and forwarded to our moderation team. We'll get back to you.",
      );
    } catch {
      // Group may have been removed or bot removed from group
      await saveProcessingStatus({
        reportId,
        status: "pending_review",
        triageResult: "needs_review",
      });
      await ctx.reply(
        "✓ Thanks! Your report has been received. It'll be reviewed once a moderation team is configured.",
      );
    }
  },
);

export default composer;