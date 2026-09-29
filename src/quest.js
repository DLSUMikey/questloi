import { api, bits, P } from './discord.js';
import * as store from './store.js';
import { createEvent } from './schedule.js';

const COLORS = { open: 0x5865f2, launched: 0x57f287, cancelled: 0x808080, closed: 0x808080 };
const PRIMARY = 1, SECONDARY = 2, SUCCESS = 3, DANGER = 4;
const TEXT = 0, VOICE = 2, CATEGORY = 4;
const ROLE = 0, MEMBER = 1;

const PLAYER_PERMS = bits(P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.Connect, P.Speak, P.AttachFiles, P.EmbedLinks);

function embed(q) {
  const lines = q.players.map((p) => {
    const mark = q.status === 'open' ? (p.ready ? '✅' : '⏳') : '⚔️';
    return `${mark} <@${p.id}>${p.id === q.hostId ? ' (host)' : ''}`;
  });
  const e = {
    title: `🗺️ ${q.title}`,
    color: COLORS[q.status],
    description: q.description || '*No description.*',
    fields: [
      { name: 'Party size', value: `max ${q.max}`, inline: true },
      { name: `Adventurers (${q.players.length}/${q.max})`, value: lines.join('\n') || '—' },
    ],
  };

  if (q.status === 'open') {
    e.footer = {
      text: `Launches automatically when the party is full (${q.max}) and everyone is ✅ Ready. The host can also launch early.`,
    };
  } else if (q.status === 'launched') {
    e.fields.push({ name: 'Party channels', value: `<#${q.textChannelId}> · <#${q.voiceChannelId}>` });
  } else {
    e.footer = { text: q.status === 'cancelled' ? 'Cancelled by the host.' : 'Quest complete.' };
  }
  return e;
}

const button = (q, action, label, style) => ({ type: 2, style, label, custom_id: `quest:${action}:${q.id}` });

function buttons(q) {
  if (q.status === 'open') {
    return [
      {
        type: 1,
        components: [
          button(q, 'join', 'Join', PRIMARY),
          button(q, 'ready', 'Ready', SUCCESS),
          button(q, 'leave', 'Leave', SECONDARY),
          button(q, 'launch', 'Launch now (host)', SECONDARY),
          button(q, 'cancel', 'Cancel (host)', DANGER),
        ],
      },
    ];
  }
  if (q.status === 'launched') {
    // Latecomers can still hop in while there's room.
    return [{ type: 1, components: [button(q, 'join', 'Join', PRIMARY), button(q, 'leave', 'Leave', SECONDARY)] }];
  }
  return [];
}

export const render = (q) => ({ embeds: [embed(q)], components: buttons(q) });

export async function refreshBoard(env, q) {
  try {
    await api(env, 'PATCH', `/channels/${q.boardChannelId}/messages/${q.messageId}`, render(q));
  } catch (err) {
    console.warn(`Could not refresh board message for quest ${q.id}:`, err.message);
  }
}

export const shouldAutoLaunch = (q) =>
  q.status === 'open' && q.max && q.players.length >= q.max && q.players.every((p) => p.ready);

export async function launch(env, q) {
  const cfg = await store.config(env, q.guildId);
  const slug = q.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'quest';

  const overwrites = [
    { id: q.guildId, type: ROLE, deny: bits(P.ViewChannel) }, // @everyone shares the guild's id
    { id: env.DISCORD_APP_ID, type: MEMBER, allow: bits(P.ViewChannel, P.SendMessages, P.ManageChannels, P.Connect) },
    ...q.players.map((p) => ({ id: p.id, type: MEMBER, allow: PLAYER_PERMS })),
  ];
  if (cfg.gmRoleId) {
    overwrites.push({
      id: cfg.gmRoleId,
      type: ROLE,
      allow: bits(P.ViewChannel, P.SendMessages, P.Connect, P.Speak, P.ManageMessages, P.MuteMembers),
    });
  }

  const create = (body) => api(env, 'POST', `/guilds/${q.guildId}/channels`, body);
  const category = await create({ name: `⚔️ ${q.title}`.slice(0, 100), type: CATEGORY, permission_overwrites: overwrites });
  const text = await create({ name: slug, type: TEXT, parent_id: category.id });
  const voice = await create({ name: `${slug}-voice`.slice(0, 100), type: VOICE, parent_id: category.id });

  q.status = 'launched';
  q.categoryId = category.id;
  q.textChannelId = text.id;
  q.voiceChannelId = voice.id;
  await store.save(env, q);

  await api(env, 'POST', `/channels/${text.id}/messages`, {
    content:
      `**${q.title}** is a go! ${q.players.map((p) => `<@${p.id}>`).join(' ')}\n` +
      `Sort out the details here. When the quest is done, the host (or a GM) can run \`/quest close\` to tidy these channels up.`,
  });
  try {
    await createSchedule(env, q);
  } catch (err) {
    // Crab Fit being down shouldn't break the launch; let the party retry from a button.
    console.warn(`Could not create availability grid for quest ${q.id}:`, err.message);
    await api(env, 'POST', `/channels/${text.id}/messages`, {
      content: "I couldn't create the availability grid just now. Press the button to try again.",
      components: [{ type: 1, components: [button(q, 'findtime', '📅 Find a time', SUCCESS)] }],
    });
  }
  await refreshBoard(env, q);
}

export async function teardown(env, q) {
  for (const id of [q.textChannelId, q.voiceChannelId, q.categoryId]) {
    if (!id) continue;
    try {
      await api(env, 'DELETE', `/channels/${id}`);
    } catch {}
  }
  q.status = 'closed';
  await store.save(env, q);
  await refreshBoard(env, q);
}

/** Create the availability grid and post it (with a results button) in the party channel. */
export async function createSchedule(env, q) {
  q.crab = await createEvent(q.title);
  await store.save(env, q);
  await api(env, 'POST', `/channels/${q.textChannelId}/messages`, {
    content:
      `📅 **Availability for ${q.title}**\n${q.crab.url}\n` +
      `Open the link, enter your name, and drag over the hours you're free. Press **Check results** once everyone has filled it in.`,
    components: [{ type: 1, components: [button(q, 'results', 'Check results', PRIMARY)] }],
  });
}

/** Give or remove a player's access to already-launched channels. */
export async function syncAccess(env, q, userId, grant) {
  try {
    const path = `/channels/${q.categoryId}/permissions/${userId}`;
    if (grant) await api(env, 'PUT', path, { type: MEMBER, allow: PLAYER_PERMS });
    else await api(env, 'DELETE', path);
    // Child channels sync from the category unless overridden, so nothing else to do.
  } catch (err) {
    console.warn('syncAccess failed:', err.message);
  }
}
