# vocal-stim-bot

A Discord bot that listens to messages and reacts when a configured trigger phrase is said. Stims can send text, images/GIFs, links, and rich embeds. **Manage them entirely from Discord with `/stim` slash commands** — no code edits needed.

## Setup

1. Create a bot at the [Discord Developer Portal](https://discord.com/developers/applications):
   - **Bot** tab → copy the token.
   - **Bot** tab → enable **Message Content Intent** (required — the bot reads message text).
   - **OAuth2 → URL Generator**: scopes `bot` **and** `applications.commands`; permissions `Send Messages`, `Embed Links`, `Attach Files`, `Read Message History`. Open the generated URL to invite it to your server.
2. Install and run:

   ```sh
   npm install
   cp .env.example .env   # paste your bot token into .env
   npm start
   ```

   Slash commands register automatically on startup for each server the bot is in. If the commands don't show up, make sure you invited the bot with the `applications.commands` scope and restart it.

## Slash commands

**Any member of the server can create, edit, or delete stims.** All command replies are ephemeral (only visible to the person running the command); the *stim itself* posts normally when triggered by a chat message.

| Command | What it does |
|---|---|
| `/stim add` | Create a new stim with a unique `name`, `match_type`, and `pattern`. Add `content` (text), `image` (file upload), `image_url` (remote image/GIF), `embed_title`, `embed_description`, and/or `embed_url`. |
| `/stim edit` | Edit a stim by `name`. Only the options you include change. Works on the four built-in examples too (as a server-local override). |
| `/stim delete` | Delete a stim by `name`. Built-in examples are hidden in this server, not deleted for other servers. |
| `/stim list` | List stims in this server (first 25). |
| `/stim show` | Show a stim's trigger and response details. |
| `/stim test` | Preview a stim's response privately using a sample `message`. |

Names autocomplete on `/stim edit`, `/stim delete`, `/stim show`, and `/stim test`.

### Examples

Create a plain-text stim:

```text
/stim add name:banana match_type:contains pattern:banana content:🍌 BANANA!
```

Reply with a GIF when someone says `9 + 10` (upload the GIF from your computer via `image`, or paste its direct URL as `image_url`):

```text
/stim add name:twenty-one match_type:regex pattern:9\s*\+\s*10 content:21 image_url:https://media1.tenor.com/m/MD9-2basfzAAAAAC/whats-nine-plus-ten-21.gif
```

Send a clickable rich link:

```text
/stim add name:docs match_type:contains pattern:where are the docs embed_title:Discord Developer Docs embed_description:Right here. embed_url:https://discord.com/developers/docs
```

Then try `/stim test name:banana message:banana`, `/stim show name:banana`, or `/stim edit name:banana content:🍌🍌🍌`.

### Match types

| type | behavior |
|---|---|
| `exact` | whole message equals `pattern` |
| `contains` | message contains `pattern` |
| `startsWith` / `endsWith` | message starts/ends with `pattern` |
| `regex` | `pattern` is a JavaScript regex (case-insensitive by default) |

### Response options

- `content` is text. Placeholders: `{user}` (mention), `{username}`, `{channel}`, `{server}`, `{message}`.
- `image` accepts an uploaded image/GIF (up to 8 MB). The bot saves it under `media/<guild-id>/` so it remains available even after Discord's attachment URLs expire. **Back up `media/` along with `config/triggers.json`.**
- `image_url` accepts a direct `https://` link to an image/GIF. If the link disappears, the bot can no longer display it.
- `embed_title`, `embed_description`, and `embed_url` create a rich embed; the title is clickable if you provide the URL. You can include an image in the same embed.
- `reply` defaults to true (the bot replies to the triggering message). Set it to false to post a standalone message.
- `cooldown_seconds` overrides the default 3-second per-trigger, per-channel cooldown.

## Advanced: editing the JSON file

Stims live in `config/triggers.json`. The bot hot-reloads hand-edits within a second, and malformed edits do **not** wipe the last-good configuration. An old top-level `triggers` array remains supported as built-in defaults; on the first slash-command mutation, it is migrated into the new shape. The built-in defaults are visible in every server until edited/hidden locally.

New schema after a `/stim add`:

```json
{
  "cooldownSeconds": 3,
  "defaults": [
    { "name": "9 plus 10", "match": { "type": "regex", "pattern": "\\b9\\s*\\+\\s*10\\b" }, "responses": [{ "content": "21", "image": "https://.../meme.gif" }] }
  ],
  "guilds": {
    "123456789012345678": {
      "triggers": [
        { "name": "banana", "match": { "type": "contains", "pattern": "banana" }, "responses": [{ "content": "🍌 BANANA!" }] }
      ],
      "hidden": []
    }
  }
}
```

For advanced hand-edited responses, you can use `embed` (full title/description/url/color/image/thumbnail/footer/author/fields), `embeds` (array), `files` (paths or URLs), and multiple `responses` (random pick, or `"pick": "all"` on the trigger to send all). Slash-command `/stim edit` manages the first response; use JSON to manage additional responses.

## Notes

- The bot fires at most one stim per message (first match) and ignores other bots' messages.
- Stims are per-server; built-in defaults fire in every server unless edited or deleted locally.
- Files in `media/` are **not** automatically deleted when a stim is edited or deleted. You can clean up unused files manually.
