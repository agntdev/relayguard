import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { getAttachedGroup, getReplyMapping, getProcessingStatus, saveProcessingStatus } from "../store.js";

// ---------------------------------------------------------------------------
// Moderator reply relay
//
// When a moderator replies to a forwarded report in the group, the bot
// captures the reply, maps it to the original user via the stored mapping,
// and forwards the reply to the original user in private.
// ---------------------------------------------------------------------------

const composer = new Composer<Ctx>();

// Register on "message" to catch all group messages; gate inside the handler
// to avoid running async checks on every message via filter().
composer.on("message:text", async (ctx, next) => {
  const chat = ctx.chat;
  // Only process in groups/supergroups — ignore private chats
  if (!chat || chat.type === "private") {
    await next();
    return;
  }

  // Only process in the attached moderation group
  const group = await getAttachedGroup();
  if (!group || chat.id !== group.groupId) {
    await next();
    return;
  }

  // Only process replies to bot messages (the forwarded report)
  const replyTo = ctx.message?.reply_to_message;
  if (!replyTo) {
    // Message in the moderation group that isn't a reply — pass through
    // to other handlers (which may be the global fallback). We do NOT
    // reply here to avoid noise in the group.
    await next();
    return;
  }
  if (!replyTo.from || !replyTo.from.is_bot) {
    // Reply to a human, not a bot message — pass through
    await next();
    return;
  }

  // Look up the reply mapping by the original forwarded message's ID
  const groupMsgId = replyTo.message_id;
  const mapping = await getReplyMapping(groupMsgId);
  if (!mapping) {
    // Reply to a bot message that isn't a forwarded report — pass through
    await next();
    return;
  }

  // Moderator's reply text
  const replyText = ctx.message?.text?.trim();
  if (!replyText) return;

  // Update processing status to "responded"
  const status = await getProcessingStatus(mapping.originalReportId);
  if (status) {
    await saveProcessingStatus({
      ...status,
      status: "responded",
    });
  }

  // Relay to original user
  try {
    await ctx.api.sendMessage(
      mapping.originalUserId,
      `📬 Reply from moderation team regarding report #${mapping.originalReportId}:\n\n${replyText}`,
    );
    // Acknowledge in the group
    await ctx.reply("✓ Reply forwarded to the user.");
  } catch {
    // User may have blocked the bot or never started it — notify the group
    await ctx.reply(
      "⚠️ Could not forward your reply — the user may have blocked the bot or not started it yet.",
    );
  }
});

export default composer;