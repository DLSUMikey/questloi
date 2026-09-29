import { api, hasPerm, P, verifyRequest } from './discord.js';
import * as quest from './quest.js';
import * as store from './store.js';
import { bestWindows, SESSION_HOURS } from './schedule.js';

const PING = 1, COMMAND = 2, COMPONENT = 3;
const PONG = 1, MESSAGE = 4, DEFER_MESSAGE = 5, DEFER_UPDATE = 6, UPDATE = 7;
const EPHEMERAL = 64;

const ERROR_MSG = 'Something went wrong. Check that I have Manage Channels and Manage Roles permissions.';

const reply = (content) => ({ type: MESSAGE, data: { content, flags: EPHEMERAL } });

/** Run slow work after the 3s interaction deadline; report failures to the user. */
function background(ctx, env, i, work) {
  ctx.waitUntil(
    work.catch(async (err) => {
      console.error(err);
      await api(env, 'POST', `/webhooks/${env.DISCORD_APP_ID}/${i.token}`, { content: ERROR_MSG, flags: EPHEMERAL }).catch(() => {});
    }),
  );
}

/** Reply publicly after the 3s deadline: acknowledge now, fill in the message when `work` resolves to text. */
function deferredReply(ctx, env, i, work) {
  const edit = (content) => api(env, 'PATCH', `/webhooks/${env.DISCORD_APP_ID}/${i.token}/messages/@original`, { content });
  ctx.waitUntil(
    work.then(edit).catch(async (err) => {
      console.error(err);
      await edit(ERROR_MSG).catch(() => {});
    }),
  );
  return { type: DEFER_MESSAGE };
}

async function resultsText(q) {
  const { responded, windows } = await bestWindows(q.crab.id);
  if (!responded) return `Nobody has filled in the grid yet: ${q.crab.url}`;
  if (!windows.length) return `${responded} responded, but nobody shares a free ${SESSION_HOURS}-hour block yet: ${q.crab.url}`;
  const lines = windows.map((w, n) => {
    const from = Math.floor(w.start / 1000);
    const to = from + SESSION_HOURS * 3600;
    return `${n + 1}. <t:${from}:F> to <t:${to}:t> (${w.names.length}/${responded}: ${w.names.join(', ')})`;
  });
  return `📅 **Best ${SESSION_HOURS}-hour windows for ${q.title}**\n${lines.join('\n')}\n\nGrid: ${q.crab.url}`;
}

function isGM(i, q, cfg) {
  return (
    i.member.user.id === q.hostId ||
    hasPerm(i.member.permissions, P.ManageGuild) ||
    (cfg.gmRoleId && i.member.roles.includes(cfg.gmRoleId))
  );
}

async function onCommand(i, env, ctx) {
  const sub = i.data.options[0];
  const opts = Object.fromEntries((sub.options ?? []).map((o) => [o.name, o.value]));
  const userId = i.member.user.id;

  if (sub.name === 'setup') {
    if (!hasPerm(i.member.permissions, P.ManageGuild)) return reply('You need Manage Server for that.');
    const cfg = await store.config(env, i.guild_id);
    if (opts.board) cfg.boardChannelId = opts.board;
    if (opts.gm_role) cfg.gmRoleId = opts.gm_role;
    await store.saveConfig(env, i.guild_id, cfg);
    return reply(
      `Board: ${cfg.boardChannelId ? `<#${cfg.boardChannelId}>` : 'wherever /quest create is used'}\n` +
        `GM role: ${cfg.gmRoleId ? `<@&${cfg.gmRoleId}>` : 'none'}`,
    );
  }

  if (sub.name === 'edit') {
    const q = (await store.byChannel(env, i.channel_id)) ?? (await store.latestOpenByHost(env, i.guild_id, userId));
    if (!q) return reply('No open quest of yours found. Run this in a quest channel, or create a quest first.');
    if (!isGM(i, q, await store.config(env, q.guildId))) return reply('Only the host or a GM can edit this quest.');

    const max = opts.max ?? q.max;
    if (max < q.players.length) return reply(`There are already ${q.players.length} players; max can't be lower.`);

    if (opts.title) q.title = opts.title;
    if (opts.description) q.description = opts.description;
    q.max = max;
    await store.save(env, q);

    background(ctx, env, i, quest.shouldAutoLaunch(q) ? quest.launch(env, q) : quest.refreshBoard(env, q));
    return reply(`Updated **${q.title}**.`);
  }

  if (sub.name === 'close') {
    const q = await store.byChannel(env, i.channel_id);
    if (!q) return reply('Run this inside an active quest channel.');
    if (!isGM(i, q, await store.config(env, q.guildId))) return reply('Only the host or a GM can close this quest.');
    background(ctx, env, i, quest.teardown(env, q));
    return reply('Closing quest and deleting channels...');
  }

  // create
  const cfg = await store.config(env, i.guild_id);
  const q = {
    id: [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join(''),
    guildId: i.guild_id,
    hostId: userId,
    title: opts.title,
    description: opts.description ?? null,
    max: opts.max ?? 5,
    status: 'open',
    createdAt: Date.now(),
    players: [{ id: userId, ready: true }],
  };

  // Prefer the configured board; fall back to the current channel if it's gone or unpostable.
  const candidates = [...new Set([cfg.boardChannelId, i.channel_id].filter(Boolean))];
  for (const channelId of candidates) {
    try {
      const msg = await api(env, 'POST', `/channels/${channelId}/messages`, quest.render(q));
      q.boardChannelId = channelId;
      q.messageId = msg.id;
      await store.save(env, q);
      return reply(`Quest posted in <#${channelId}>.`);
    } catch (err) {
      console.warn(`Could not post quest in ${channelId}:`, err.message);
    }
  }
  return reply(`I can't post in <#${candidates.at(-1)}>. Give me View/Send/Embed permissions there.`);
}

async function onButton(i, env, ctx) {
  const [, action, id] = i.data.custom_id.split(':');
  const q = await store.get(env, id);
  if (!q || q.status === 'closed' || q.status === 'cancelled') return reply('This quest is no longer active.');

  const userId = i.member.user.id;
  const me = q.players.find((p) => p.id === userId);

  switch (action) {
    case 'join':
      if (me) return reply("You're already in this party.");
      if (q.max && q.players.length >= q.max) return reply('This party is full.');
      q.players.push({ id: userId, ready: false });
      if (q.status === 'launched') await quest.syncAccess(env, q, userId, true);
      break;
    case 'leave':
      if (!me) return reply("You're not in this party.");
      if (userId === q.hostId) return reply("The host can't leave; use Cancel instead.");
      q.players = q.players.filter((p) => p.id !== userId);
      if (q.status === 'launched') await quest.syncAccess(env, q, userId, false);
      break;
    case 'ready':
      if (!me) return reply('Join the party first.');
      if (q.status !== 'open') return reply('Already launched.');
      me.ready = !me.ready;
      break;
    case 'findtime': {
      if (!me) return reply('Only party members can do that.');
      if (q.status !== 'launched') return reply('This quest has no party channel.');
      if (q.crab) return reply(`The availability grid already exists: ${q.crab.url}`);
      background(ctx, env, i, quest.createSchedule(env, q));
      return { type: DEFER_UPDATE };
    }
    case 'results':
      if (!me) return reply('Only party members can do that.');
      if (!q.crab) return reply('Press **Find a time** first.');
      return deferredReply(ctx, env, i, resultsText(q));
    case 'launch':
      if (userId !== q.hostId) return reply('Only the host can do that.');
      if (q.status !== 'open') return reply('Already launched.');
      background(ctx, env, i, quest.launch(env, q));
      return { type: DEFER_UPDATE };
    case 'cancel':
      if (userId !== q.hostId) return reply('Only the host can do that.');
      if (q.status !== 'open') return reply('Use /quest close in the quest channel.');
      q.status = 'cancelled';
      break;
  }
  await store.save(env, q);

  if (quest.shouldAutoLaunch(q)) {
    background(ctx, env, i, quest.launch(env, q));
    return { type: DEFER_UPDATE };
  }
  return { type: UPDATE, data: quest.render(q) };
}

async function onInteraction(i, env, ctx) {
  try {
    if (i.type === COMMAND && i.data.name === 'quest') return await onCommand(i, env, ctx);
    if (i.type === COMPONENT && i.data.custom_id.startsWith('quest:')) return await onButton(i, env, ctx);
  } catch (err) {
    console.error(err);
    return reply(ERROR_MSG);
  }
  return reply('Unknown interaction.');
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('questloi');

    const body = await request.text();
    if (!(await verifyRequest(request, body, env.DISCORD_PUBLIC_KEY))) return new Response('Bad signature', { status: 401 });

    const i = JSON.parse(body);
    if (i.type === PING) return Response.json({ type: PONG });
    return Response.json(await onInteraction(i, env, ctx));
  },
};
