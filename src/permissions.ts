/**
 * Permission checks — injectable so the test harness can verify admin-only
 * command behavior without a real group.
 *
 * The real implementation calls ctx.api.getChatMember(). The test harness
 * stubs the API, so setCheckIsAdmin lets specs control the result.
 */

import type { Ctx } from "./bot.js";

/** Check whether the sender is a group admin or creator. */
export type CheckIsAdmin = (ctx: Ctx) => Promise<boolean>;

let _checkIsAdmin: CheckIsAdmin | undefined;

/** Default: calls Telegram API to verify admin status. */
async function defaultCheckIsAdmin(ctx: Ctx): Promise<boolean> {
  const chat = ctx.chat;
  if (!chat) return false;
  const member = await ctx.api.getChatMember(chat.id, ctx.from!.id);
  return member.status === "administrator" || member.status === "creator";
}

/** Check if the sender is an admin. Uses injected fn or real API. */
export async function isAdmin(ctx: Ctx): Promise<boolean> {
  const fn = _checkIsAdmin ?? defaultCheckIsAdmin;
  return fn(ctx);
}

/** Override the admin check (for tests). Pass undefined to restore default. */
export function setCheckIsAdmin(fn: CheckIsAdmin | undefined): void {
  _checkIsAdmin = fn;
}
