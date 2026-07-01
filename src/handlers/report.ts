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
    const msgTs = ctx.message?.date;
    if (msgTs) {
      // ctx.message.date is Unix seconds; now() returns ms
      if (now() - msgTs * 1000 > FLOW_TIMEOUT_MS) {
        ctx.session.step = "idle";
        try {
          await ctx.reply("⏱️ Report submission timed out. Tap /start to try again.");
        } catch {
          // May fail on callback queries — that's OK, timeout is best-effort
        }
        return;
      }
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
  await ctx.editMessageText("📝 Please describe your issue or feedback below.", {
    reply_markup: cancelKeyboard,
  });
});

// --- Cancel button ---
composer.callbackQuery("submit_report:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "idle";
  await ctx.editMessageText("Report cancelled. Tap /start to open the menu.", {
    reply_markup: backMenuKeyboard,
  });
});

// --- Step 2: User types their report ---
// Use filter() so we only match when in the report flow — otherwise pass
// through so /start, /help and other handlers still work.
composer.filter(
  (ctx) => ctx.session.step === "awaiting_report",
  async (ctx) => {
    const content = ctx.message?.text?.trim();
    if (!content) {
      await ctx.reply("Your report was empty — please try again with a description.");
      return;
    }

    ctx.session.step = "idle";

    // Collect media references
    const mediaRefs: string[] = [];
    if (ctx.message?.photo) {
      // photo array: last element is the largest size
      mediaRefs.push(`photo:${ctx.message.photo[ctx.message.photo.length - 1].file_id}`);
    }
    if (ctx.message?.document) {
      mediaRefs.push(`doc:${ctx.message.document.file_id}`);
    }
    if (ctx.message?.video) {
      mediaRefs.push(`video:${ctx.message.video.file_id}`);
    }

    // Save the report
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
      `New report #${reportId} from user ${ctx.from!.id}:\n\n${content}` +
      (mediaCount > 0 ? "\n\n(Report includes media attachments)" : "");

    try {
      const sent = await ctx.api.sendMessage(group.groupId, forwardText);
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