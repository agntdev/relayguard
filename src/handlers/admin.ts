import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { now } from "../clock.js";
import { saveAttachedGroup, getAttachedGroup, clearAttachedGroup } from "../store.js";
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

  // Check if a different group is already attached
  const existing = await getAttachedGroup();
  if (existing && existing.groupId !== chat.id) {
    await ctx.reply("⚠️ Another group is already attached as the moderation group. Detach it first with /detach.");
    return;
  }

  await saveAttachedGroup({
    groupId: chat.id,
    lastAttachedTimestamp: now(),
  });

  await ctx.reply("✓ This group is now set as the moderation group. Reports will be forwarded here.");
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

  const existing = await getAttachedGroup();
  if (!existing || existing.groupId !== chat.id) {
    await ctx.reply("⚠️ This group is not currently set as the moderation group.");
    return;
  }

  await clearAttachedGroup();
  await ctx.reply("✓ This group has been detached. Reports will no longer be forwarded here.");
});

export default composer;