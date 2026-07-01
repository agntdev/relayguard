import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { now } from "../clock.js";
import {
  saveAttachedGroup,
  getAttachedGroup,
  clearAttachedGroup,
  lockAttachmentWithRetry,
  unlockAttachment,
} from "../store.js";
import { isAdmin } from "../permissions.js";

// ---------------------------------------------------------------------------
// Group attachment / detachment — admin-only commands
// ---------------------------------------------------------------------------

const composer = new Composer<Ctx>();

// --- /attach ---
composer.command("attach", async (ctx) => {
  const chat = ctx.chat;
  if (!chat || chat.type === "private") {
    await ctx.reply("⚠️ /attach must be used in a group where you're an admin.");
    return;
  }

  if (!(await isAdmin(ctx))) {
    await ctx.reply("⚠️ Only group admins can attach the moderation group.");
    return;
  }

  // Acquire distributed lock to prevent TOCTOU race when multiple admins
  // try to attach different groups simultaneously.
  const ownerId = `admin:${ctx.from!.id}:${chat.id}`;
  const gotLock = await lockAttachmentWithRetry(ownerId);
  if (!gotLock) {
    await ctx.reply("⚠️ Another attach/detach operation is in progress. Try again shortly.");
    return;
  }

  try {
    const existing = await getAttachedGroup();
    if (existing && existing.groupId !== chat.id) {
      await ctx.reply(
        "⚠️ Another group is already attached as the moderation group. Detach it first with /detach.",
      );
      return;
    }

    await saveAttachedGroup({
      groupId: chat.id,
      lastAttachedTimestamp: now(),
    });

    await ctx.reply("✓ This group is now set as the moderation group. Reports will be forwarded here.");
  } finally {
    await unlockAttachment();
  }
});

// --- /detach ---
composer.command("detach", async (ctx) => {
  const chat = ctx.chat;
  if (!chat || chat.type === "private") {
    await ctx.reply("⚠️ /detach must be used in the moderation group.");
    return;
  }

  if (!(await isAdmin(ctx))) {
    await ctx.reply("⚠️ Only group admins can detach the moderation group.");
    return;
  }

  // Acquire distributed lock for consistency with /attach
  const ownerId = `admin:${ctx.from!.id}:${chat.id}`;
  const gotLock = await lockAttachmentWithRetry(ownerId);
  if (!gotLock) {
    await ctx.reply("⚠️ Another attach/detach operation is in progress. Try again shortly.");
    return;
  }

  try {
    const existing = await getAttachedGroup();
    if (!existing || existing.groupId !== chat.id) {
      await ctx.reply("⚠️ This group is not currently set as the moderation group.");
      return;
    }

    await clearAttachedGroup();
    await ctx.reply("✓ This group has been detached. Reports will no longer be forwarded here.");
  } finally {
    await unlockAttachment();
  }
});

export default composer;