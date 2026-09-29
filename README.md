# questloi

Discord bot for West Marches quest coordination, hosted on Cloudflare Workers.

## How it works

1. A player runs `/quest create title:"Ruins of Karn" max:5`.
2. A quest card appears on the board with **Join / Ready / Leave** buttons.
3. Once the party is full (`max`) **and everyone is Ready**, the bot auto-creates a private
   category with a text and voice channel visible only to the party (and the GM role).
   The host can also force-launch early.
4. Late joiners (if there's room) are added to the channels automatically.
5. The party gets a read-only schedule channel with an availability grid ([Crab Fit](https://crab.fit)).
   The panel shows the windows where **everyone** is free (default 4 hours, adjustable). The host or a GM
   confirms one, which posts a Google Calendar link and creates a Discord event.
6. When the quest is done, the host or a GM runs `/quest close` in the quest channel to delete everything.
7. Optional: if the players want to stay together for another quest, the host or a GM presses **New session**
   on the schedule panel instead. That clears the date and starts a fresh grid; the channels stay.
   Close them with `/quest close` whenever the party finally breaks up.

Admins run `/quest setup board:#quest-board gm_role:@GM` once.

## Architecture

There is no gateway connection. Discord POSTs every slash command and button click to the Worker
(an [interactions endpoint](https://discord.com/developers/docs/interactions/overview#configuring-an-interactions-endpoint-url)),
the Worker verifies the Ed25519 signature, and calls Discord's REST API for anything else
(posting the board card, creating/deleting channels, permission overwrites). State lives in KV (`QUEST_KV`).

| Key | Value |
|---|---|
| `config:<guildId>` | `{ boardChannelId, gmRoleId }` |
| `quest:<id>` | quest JSON |
| `channel:<textChannelId>` | quest id, while launched |
| `open:<guildId>:<hostId>:<createdAt>:<id>` | index so `/quest edit` finds the host's latest open quest |

## Setup

1. Create an app at https://discord.com/developers/applications and add a Bot.
   Note the **Application ID**, **Public Key** and the bot **token**.
2. Put the Application ID and Public Key into `wrangler.jsonc` (`DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`).
3. `npm install`, then `npx wrangler deploy`. The first deploy creates the `QUEST_KV` namespace;
   paste the printed id into `wrangler.jsonc` so it's pinned.
4. `npx wrangler secret put DISCORD_TOKEN`
5. In the developer portal set **Interactions Endpoint URL** to the Worker URL
   (`https://questloi.<subdomain>.workers.dev`). Discord pings it to verify.
6. Copy `.env.example` to `.env`, fill it in, and run `npm run register` to register `/quest`
   (set `GUILD_ID` for instant registration in one server).
7. Invite the bot with scopes `bot` + `applications.commands` and permissions
   **Manage Channels, Manage Roles, View Channels, Send Messages, Embed Links, Connect**.

## CI deploy

Pushing to `main` runs `.github/workflows/deploy.yml`, which needs the repo secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
