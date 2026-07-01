import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { getAttachedGroup, getReplyMapping, getReport, getProcessingStatus, saveProcessingStatus } from "../store.js";

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

/** Identifies the media type in a moderator reply for forwarding. */
type MediaPayload =
  | { type: "photo"; fileId: string }
  | { type: "document"; fileId: string }
  | { type: "video"; fileId: string }
  | { type: "voice"; fileId: string }
  | null;

/** Extract text content and media info from a message for relaying. */
function extractReplyContent(ctx: Ctx): { text: string; media: MediaPayload } | null {
  const msg = ctx.message;
  if (!msg) return null;

  // Text-only message
  if (msg.text?.trim()) {
    return { text: msg.text.trim(), media: null };
  }

  // Media with caption or bare media
  const caption = msg.caption?.trim() ?? "";

  if (msg.photo) {
    return { text: caption, media: { type: "photo", fileId: msg.photo[msg.photo.length - 1].file_id } };
  }
  if (msg.document) {
    return { text: caption, media: { type: "document", fileId: msg.document.file_id } };
  }
  if (msg.video) {
    return { text: caption, media: { type: "video", fileId: msg.video.file_id } };
  }
  if (msg.voice) {
    return { text: caption, media: { type: "voice", fileId: msg.voice.file_id } };
  }

  return null;
}

/** Send the reply to the original user — forwards media when present. */
async function sendReplyToUser(
  ctx: Ctx,
  userId: number,
  reportId: string,
  content: { text: string; media: MediaPayload },
): Promise<void> {
  const prefix = `📬 Reply from moderation team regarding report #${reportId}`;
  const caption = content.text ? `${prefix}:\n\n${content.text}` : prefix;

  if (!content.media) {
    // Pure text reply
    await ctx.api.sendMessage(userId, caption);
    return;
  }

  // Forward the actual media with the caption
  switch (content.media.type) {
    case "photo":
      await ctx.api.sendPhoto(userId, content.media.fileId, { caption });
      break;
    case "document":
      await ctx.api.sendDocument(userId, content.media.fileId, { caption });
      break;
    case "video":
      await ctx.api.sendVideo(userId, content.media.fileId, { caption });
      break;
    case "voice":
      await ctx.api.sendVoice(userId, content.media.fileId, { caption });
      break;
  }
}

/**
 * Handle a moderator reply to a specific report: extract content, send to user,
 * update processing status, and acknowledge in the group.
 */
async function handleModeratorReply(ctx: Ctx, userId: number, reportId: string): Promise<void> {
  // Extract reply content (text, caption, or media)
  const content = extractReplyContent(ctx);
  if (!content) {
    // Unsupported message type — notify the group
    await ctx.reply(
      "⚠️ Unsupported message type. Please reply with text, a photo with caption, a document, video, or a voice message.",
    );
    return;
  }

  // Relay to original user
  try {
    await sendReplyToUser(ctx, userId, reportId, content);

    // Mark as responded only after delivery confirmation
    const status = await getProcessingStatus(reportId);
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

  // Try to capture reply-to-message interactions first (standard Telegram reply)
  const replyTo = ctx.message?.reply_to_message;
  if (replyTo && replyTo.from?.is_bot) {
    // Reply to a bot message — look up reply mapping
    const groupMsgId = replyTo.message_id;
    const mapping = await getReplyMapping(groupMsgId);
    if (mapping) {
      await handleModeratorReply(ctx, mapping.originalUserId, mapping.originalReportId);
      return;
    }
    // Reply to a bot message that isn't a forwarded report — pass through
    await next();
    return;
  }

  // Edge case: moderator replied WITHOUT using Telegram's reply feature,
  // but included a report ID reference like #R000001 or R000001 in the text.
  //
  // This handles: "Re: R000001 — please try clearing your cache"
  //              "For report R000001, we're working on it"
  //              "R000001: Thanks, we'll fix that."
  if (replyTo || ctx.message?.text || ctx.message?.caption) {
    const text = ctx.message?.text ?? "";
    const caption = ctx.message?.caption ?? "";
    const fullText = text || caption;
    const reportRef = fullText.match(/#?(R\d{6})\b/);
    if (reportRef) {
      const referencedReportId = reportRef[1];
      const report = await getReport(referencedReportId);
      if (report) {
        // If there IS a reply_to_message but it's not to the bot (replyTo exists
        // but replyTo.from.is_bot was false), we still try the reference match.
        // If the moderators are replying to a human message that references a
        // report, route it as a moderator reply to that report.
        if (!replyTo || !replyTo.from?.is_bot) {
          await handleModeratorReply(ctx, report.telegramUserId, referencedReportId);
          return;
        }
      }
    }
  }

  // Message in the moderation group that isn't a reply — pass through
  await next();
});

export default composer;