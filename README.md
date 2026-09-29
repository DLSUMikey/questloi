# dndbot

Discord bot for West Marches quest coordination.

## How it works

1. A player runs `/quest create title:"Ruins of Karn" max:5`.
2. A quest card appears on the board with **Join / Ready / Leave** buttons.
3. Once the party is full (`max`) **and everyone is Ready**, the bot auto-creates a private
   category with a text and voice channel visible only to the party (and the GM role).
   The host can also force-launch early.
4. Late joiners (if there's room) are added to the channels automatically.
5. The host or a GM runs `/quest close` in the quest channel to delete everything.

Admins run `/quest setup board:#quest-board gm_role:@GM` once.

## Setup

1. Create an app at https://discord.com/developers/applications, add a Bot, copy its token.
2. Invite it with scopes `bot` + `applications.commands` and permissions
   **Manage Channels, Manage Roles, View Channels, Send Messages, Embed Links, Connect**.
3. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` (and `GUILD_ID` for instant command registration).
4. `npm install`, then `npm start`.

State lives in `data/db.json`.
