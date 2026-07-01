import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { getAttachedGroup, getReplyMapping, getProcessingStatus, saveProcessingStatus } from "../store.js";

// ---------------------------------------------------------------------------
// Moderator reply relay
//
// When a moderator replies to a forwarded report in the group, the bot
// captures the reply, maps it to the original user via the stored mapping,
// and forwards the reply to the original user in private.
//
// Handles text, photo (+caption), document (+caption), video (+caption),
// and voice messages from moderators.
// ---------------------------------------------------------------------------

const composer = new Composer<Ctx>();

/** Extract text content and media info from a message for relaying. */
function extractReplyContent(
  ctx: Ctx,
): { text: string; hasMedia: boolean } | null {
  if (ctx.message?.text?.trim()) {
    return { text: ctx.message.text.trim(), hasMedia: false };
  }
  if (ctx.message?.caption?.trim()) {
    return { text: ctx.message.caption.trim(), hasMedia: true };
  }
  // Non-text, non-caption message — check media type
  if (ctx.message?.photo || ctx.message?.document || ctx.message?.video || ctx.message?.voice) {
    return { text: "", hasMedia: true };
  }
  return null;
}

/** Send the reply to the original user, handling text + media combinations. */
async function sendReplyToUser(
  ctx: Ctx,
  userId: number,
  reportId: string,
  content: { text: string; hasMedia: boolean },
): Promise<void> {
  const prefix = `📬 Reply from moderation team regarding report #${reportId}`;
  const fullText = content.text
    ? `${prefix}:\n\n${content.text}`
    : prefix;

  await ctx.api.sendMessage(userId, fullText);
}

// Register on "message" to catch all message types — text, photo, document,
// video, voice, etc. Gate based on chat type + reply conditions inside.
composer.on("message", async (ctx, next) => {
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

  // Extract reply content (text, caption, or media)
  const content = extractReplyContent(ctx);
  if (!content) {
    // Unsupported message type — notify the group
    await ctx.reply(
      "⚠️ Unsupported message type. Please reply with text, a photo with caption, a document, video, or a voice message.",
    );
    return;
  }

  // Update processing status ONLY after a successful send
  // Relay to original user
  try {
    await sendReplyToUser(ctx, mapping.originalUserId, mapping.originalReportId, content);

    // Mark as responded only after delivery confirmation
    const status = await getProcessingStatus(mapping.originalReportId);
    if (status) {
      await saveProcessingStatus({
        ...status,
        status: "responded",
      });
    }

    // Acknowledge in the group
    await ctx.reply("✓ Reply forwarded to the user.");
  } catch {
    // User may have blocked the bot or never started it — notify the group.
    // The processing status stays as-is (not "responded") since delivery failed.
    await ctx.reply(
      "⚠️ Could not forward your reply — the user may have blocked the bot or not started it yet.",
    );
  }
});

export default composer;