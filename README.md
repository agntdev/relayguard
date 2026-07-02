# RelayGuard

Telegram bot that triages user reports, forwards AI-flagged reports to a single moderator group, and relays moderator replies back to reporters.

Spec: [`docs/blueprint.md`](docs/blueprint.md).

Built on [agnt-gm.ai](https://agnt-gm.ai). The whole bot is built and refined here as pull requests across successive build passes.

## Deployment

### Owner ID

The `/attach` command requires the bot to know its owner's Telegram user ID.
The build process now injects this automatically from deployment platform
metadata. Resolution order:

1. `OWNER_ID` environment variable (explicit override)
2. `BUILD_METADATA` JSON environment variable with `OWNER_TELEGRAM_ID` field
3. `.owner-id` file in the project root (created by deploy step)
4. Owner unavailable — `/attach` is disabled and a clear error is shown

To override the auto-detected owner ID, set the `OWNER_ID` environment variable
to the Telegram user ID of the bot owner:

```bash
OWNER_ID=123456789 npm start
```

If no owner ID can be discovered, the bot logs a warning indicating how to set
`OWNER_ID` and `/attach` remains unavailable until one is configured.
