import { command } from '../src/commands.js';

const { DISCORD_TOKEN, DISCORD_APP_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !DISCORD_APP_ID) throw new Error('Set DISCORD_TOKEN and DISCORD_APP_ID (see .env.example)');

const path = GUILD_ID
  ? `/applications/${DISCORD_APP_ID}/guilds/${GUILD_ID}/commands`
  : `/applications/${DISCORD_APP_ID}/commands`;

const res = await fetch(`https://discord.com/api/v10${path}`, {
  method: 'PUT',
  headers: { Authorization: `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify([command]),
});
if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
console.log(`Registered /quest ${GUILD_ID ? `to guild ${GUILD_ID}` : 'globally'}`);
