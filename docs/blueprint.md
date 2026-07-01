# Support Feedback Relay — Bot specification

**Archetype:** support

**Voice:** professional and concise — write every user-facing message, button label, error, and empty state in this voice.

A Telegram bot that accepts user reports/feedback and routes AI-selected messages to a moderator group. Moderators' replies are relayed back to the original user in private.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- end users submitting reports
- moderator group admins

## Success criteria

- Moderators receive only relevant reports for review
- Users receive private replies from moderators
- System maintains persistent group attachment and message routing

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open the main menu
- **/attach** (command, actor: group_admin, command: /attach) — Attach the current group as the persistent moderation group
- **/detach** (command, actor: group_admin, command: /detach) — Detach the current moderation group
- **Submit Report** (button, actor: user, callback: submit_report:start) — Initiate the report submission flow

## Flows

### report_submission
_Trigger:_ user message to bot

1. User sends message to bot
2. Bot acknowledges receipt
3. AI triage determines if human review needed
4. If needed, forward to moderator group with user ID
5. If not needed, optionally auto-close and respond

_Data touched:_ user_report, processing_status

### moderator_reply
_Trigger:_ group message reply to forwarded report

1. Moderator replies to forwarded report in group
2. Bot captures reply and maps to original user
3. Bot sends reply to user in private
4. Mark report as responded

_Data touched:_ moderator_reply_mapping, processing_status

### group_attachment
_Trigger:_ /attach command in group

1. Admin issues /attach command
2. Bot verifies admin status
3. Set current group as persistent attachment

_Data touched:_ attached_group

### group_detachment
_Trigger:_ /detach command in group

1. Admin issues /detach command
2. Bot verifies admin status
3. Clear current group attachment

_Data touched:_ attached_group

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

- **user_report** _(retention: persistent)_ — A report submitted by a user to the support bot
  - fields: telegram_user_id, timestamp, content, media_references
- **processing_status** _(retention: persistent)_ — The current status of a report in the system
  - fields: report_id, status, triage_result
- **attached_group** _(retention: persistent)_ — The persistent Telegram group chat for moderator reviews
  - fields: group_id, last_attached_timestamp
- **moderator_reply_mapping** _(retention: persistent)_ — Association between a group message and original user for reply routing
  - fields: group_message_id, original_report_id, original_user_id

## Integrations

- **Telegram** (required) — Bot API messaging and group management
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- /attach command to set group
- /detach command to remove group
- Configure AI triage sensitivity (not specified in brief)

## Notifications

- Delivery failure notifications to moderator group when user cannot receive replies
- Status updates to users when their report is responded to

## Permissions & privacy

- Only group admins can attach/detach groups
- User Telegram IDs are visible in group but not as clickable links
- Moderator replies are only visible to the original user and group context

## Edge cases

- User blocks bot after report submitted
- Moderator replies not as message replies
- Multiple admins attempt to attach different groups simultaneously

## Required tests

- Verify report submission and acknowledgment flow
- Test AI triage routing to group
- Validate moderator reply routing to original user
- Confirm group attachment/detachment commands work as admin-only

## Assumptions

- AI triage implementation details are not specified
- Moderator group will be set by admin command
- User reports will be text/media only
