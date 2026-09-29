import { api, bits, P } from './discord.js';
import * as store from './store.js';
import { bestWindows, createEvent, DEFAULT_HOURS, googleCalendarUrl, MAX_HOURS, MIN_HOURS } from './schedule.js';

const COLORS = { open: 0x5865f2, launched: 0x57f287, cancelled: 0x808080, closed: 0x808080 };
const PRIMARY = 1, SECONDARY = 2, SUCCESS = 3, DANGER = 4;
const TEXT = 0, VOICE = 2, CATEGORY = 4;
const ROLE = 0, MEMBER = 1;

const PLAYER_PERMS = bits(P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.Connect, P.Speak, P.AttachFiles, P.EmbedLinks);
// The schedule channel is bot-only for writing: players read it and use its buttons.
const READ_ONLY_PERMS = bits(P.ViewChannel, P.ReadMessageHistory);
const HOUR = 3600_000;

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

const button = (q, action, label, style, extra = '', disabled = false) => ({
  type: 2,
  style,
  label,
  custom_id: `quest:${action}:${q.id}${extra}`,
  ...(disabled && { disabled }),
});

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

  const overwritesFor = (playerPerms, botPerms) => {
    const list = [
      { id: q.guildId, type: ROLE, deny: bits(P.ViewChannel) }, // @everyone shares the guild's id
      { id: env.DISCORD_APP_ID, type: MEMBER, allow: botPerms },
      ...q.players.map((p) => ({ id: p.id, type: MEMBER, allow: playerPerms })),
    ];
    if (cfg.gmRoleId) {
      list.push({
        id: cfg.gmRoleId,
        type: ROLE,
        allow: bits(P.ViewChannel, P.SendMessages, P.Connect, P.Speak, P.ManageMessages, P.MuteMembers),
      });
    }
    return list;
  };
  const botPerms = bits(P.ViewChannel, P.SendMessages, P.ManageChannels, P.Connect);

  const create = (body) => api(env, 'POST', `/guilds/${q.guildId}/channels`, body);
  const category = await create({
    name: `⚔️ ${q.title}`.slice(0, 100),
    type: CATEGORY,
    permission_overwrites: overwritesFor(PLAYER_PERMS, botPerms),
  });
  const text = await create({ name: slug, type: TEXT, parent_id: category.id });
  const voice = await create({ name: `${slug}-voice`.slice(0, 100), type: VOICE, parent_id: category.id });
  const schedule = await create({
    name: `${slug}-schedule`.slice(0, 100),
    type: TEXT,
    parent_id: category.id,
    permission_overwrites: overwritesFor(READ_ONLY_PERMS, botPerms),
  });

  q.status = 'launched';
  q.categoryId = category.id;
  q.textChannelId = text.id;
  q.voiceChannelId = voice.id;
  q.scheduleChannelId = schedule.id;
  await store.save(env, q);

  await api(env, 'POST', `/channels/${text.id}/messages`, {
    content:
      `**${q.title}** is a go! ${q.players.map((p) => `<@${p.id}>`).join(' ')}\n` +
      `Sort out the details here, and mark your availability in <#${schedule.id}>. ` +
      `When the quest is done, the host (or a GM) can run \`/quest close\` to tidy these channels up.`,
  });
  await createScheduleOrFallback(env, q);
  await refreshBoard(env, q);
}

export async function teardown(env, q) {
  if (q.confirmed?.eventId) await api(env, 'DELETE', `/guilds/${q.guildId}/scheduled-events/${q.confirmed.eventId}`).catch(() => {});
  for (const id of [q.textChannelId, q.voiceChannelId, q.scheduleChannelId, q.categoryId]) {
    if (!id) continue;
    try {
      await api(env, 'DELETE', `/channels/${id}`);
    } catch {}
  }
  q.status = 'closed';
  await store.save(env, q);
  await refreshBoard(env, q);
}

const scheduleChannel = (q) => q.scheduleChannelId ?? q.textChannelId; // older quests have no schedule channel
const hoursOf = (q) => q.hours ?? DEFAULT_HOURS;

function scheduleMessage(q, { responded, windows }) {
  const hours = hoursOf(q);
  const head = [`📅 **Availability for ${q.title}**`, `Fill in the grid: ${q.crab.url}`];
  if (q.confirmed) {
    const s = Math.floor(q.confirmed.start / 1000);
    head.push(`✅ **Confirmed:** <t:${s}:F> to <t:${s + q.confirmed.hours * 3600}:t>`);
  }

  const rows = windows.map((w, n) => {
    const from = Math.floor(w.start / 1000);
    return `${n + 1}. <t:${from}:F> to <t:${from + hours * 3600}:t>`;
  });
  const party = q.players.length;
  let body;
  if (!responded) body = 'Nobody has filled in the grid yet.';
  else if (!rows.length) {
    body = `No ${hours}-hour window where everyone is free yet. Try a shorter session, or have people add more availability.`;
  } else body = `**${hours}-hour windows where everyone is free**\n${rows.join('\n')}`;
  if (responded && responded < party) body += `\n⏳ Only ${responded} of ${party} have filled in the grid, so these only count those ${responded}.`;

  const controls = [
    button(q, 'shorter', '− 1 hour', SECONDARY, '', hours <= MIN_HOURS),
    button(q, 'longer', '+ 1 hour', SECONDARY, '', hours >= MAX_HOURS),
    button(q, 'refresh', '🔄 Refresh', PRIMARY),
    button(q, 'newsession', '🆕 New session (host)', SECONDARY),
  ];
  const components = [{ type: 1, components: controls }];
  if (windows.length) {
    const label = q.confirmed ? 'Reschedule to' : 'Confirm';
    components.push({
      type: 1,
      components: windows.map((w, n) => button(q, 'confirm', `${label} #${n + 1}`, SUCCESS, `:${w.start}`)),
    });
  }

  return {
    content: `${head.join('\n')}\n\n${body}\n\n-# Session length: ${hours}h. Use the buttons to change it. Only the host or a GM can confirm a time. Staying together for another quest? The host can press New session.`,
    components,
  };
}

/** Create the availability grid and post the results panel in the schedule channel. */
export async function createSchedule(env, q) {
  q.crab = await createEvent(q.title);
  q.hours = hoursOf(q);
  const msg = await api(env, 'POST', `/channels/${scheduleChannel(q)}/messages`, scheduleMessage(q, { responded: 0, windows: [] }));
  q.scheduleMessageId = msg.id;
  await store.save(env, q);
}

/** Crab Fit being down shouldn't break a launch or reset; the party can retry from a button. */
async function createScheduleOrFallback(env, q) {
  try {
    await createSchedule(env, q);
  } catch (err) {
    console.warn(`Could not create availability grid for quest ${q.id}:`, err.message);
    await api(env, 'POST', `/channels/${scheduleChannel(q)}/messages`, {
      content: "I couldn't create the availability grid just now. Press the button to try again.",
      components: [{ type: 1, components: [button(q, 'findtime', '📅 Find a time', SUCCESS)] }],
    });
  }
}

/** Optional: a party that stays together after a quest starts over on scheduling. Drops the confirmed date and its event, archive the old grid, start a fresh one. */
export async function newSession(env, q) {
  if (q.confirmed?.eventId) await api(env, 'DELETE', `/guilds/${q.guildId}/scheduled-events/${q.confirmed.eventId}`).catch(() => {});

  if (q.crab && q.scheduleMessageId) {
    const past = q.confirmed ? `<t:${Math.floor(q.confirmed.start / 1000)}:F>` : 'never scheduled';
    await api(env, 'PATCH', `/channels/${scheduleChannel(q)}/messages/${q.scheduleMessageId}`, {
      content: `📁 **Past session** (${past})
Grid: ${q.crab.url}`,
      components: [],
    }).catch(() => {});
  }

  q.crab = null;
  q.confirmed = null;
  q.scheduleMessageId = null;
  await store.save(env, q);

  await api(env, 'POST', `/channels/${q.textChannelId}/messages`, {
    content: `🆕 New session time! Mark your availability in <#${scheduleChannel(q)}>. ${q.players.map((p) => `<@${p.id}>`).join(' ')}`,
  });
  await createScheduleOrFallback(env, q);
}

/** Recompute the best windows and edit the results panel in place. */
export async function refreshSchedule(env, q) {
  const result = await bestWindows(q.crab.id, hoursOf(q));
  await api(env, 'PATCH', `/channels/${scheduleChannel(q)}/messages/${q.scheduleMessageId}`, scheduleMessage(q, result));
}

/** Lock in a start time: announce it, add a Discord event and a Google Calendar link. */
export async function confirm(env, q, start) {
  const hours = hoursOf(q);
  const end = start + hours * HOUR;

  if (q.confirmed?.eventId) await api(env, 'DELETE', `/guilds/${q.guildId}/scheduled-events/${q.confirmed.eventId}`).catch(() => {});

  let eventId = null;
  try {
    const ev = await api(env, 'POST', `/guilds/${q.guildId}/scheduled-events`, {
      name: q.title.slice(0, 100),
      privacy_level: 2, // GUILD_ONLY
      entity_type: 2, // VOICE
      channel_id: q.voiceChannelId,
      scheduled_start_time: new Date(start).toISOString(),
      scheduled_end_time: new Date(end).toISOString(),
      description: `West Marches party of ${q.players.length}`,
    });
    eventId = ev.id;
  } catch (err) {
    // Needs the Manage Events permission; the calendar link below still works without it.
    console.warn(`Could not create Discord event for quest ${q.id}:`, err.message);
  }

  q.confirmed = { start, hours, eventId };
  await store.save(env, q);

  const s = Math.floor(start / 1000);
  const gcal = googleCalendarUrl({
    title: q.title,
    details: `West Marches session. Party chat: https://discord.com/channels/${q.guildId}/${q.textChannelId}`,
    start,
    end,
  });
  await api(env, 'POST', `/channels/${q.textChannelId}/messages`, {
    content:
      `✅ **${q.title}** is set for <t:${s}:F> to <t:${s + hours * 3600}:t> (<t:${s}:R>). ` +
      `${q.players.map((p) => `<@${p.id}>`).join(' ')}\nAdd it to your calendar from <#${scheduleChannel(q)}>.`,
  });
  await api(env, 'POST', `/channels/${scheduleChannel(q)}/messages`, {
    content:
      `📆 **${q.title}**: <t:${s}:F> to <t:${s + hours * 3600}:t>\n` +
      `[Add to Google Calendar](<${gcal}>)` +
      (eventId
        ? `\n[Open the Discord event](<https://discord.com/events/${q.guildId}/${eventId}>) and press **Interested** to get a reminder.`
        : ''),
  });
  await refreshSchedule(env, q);
}

/** Give or remove a player's access to already-launched channels. */
export async function syncAccess(env, q, userId, grant) {
  const targets = [[q.categoryId, PLAYER_PERMS]];
  // The schedule channel has its own overrides (read-only for players), so it doesn't follow the category.
  if (q.scheduleChannelId) targets.push([q.scheduleChannelId, READ_ONLY_PERMS]);
  for (const [channelId, perms] of targets) {
    try {
      const path = `/channels/${channelId}/permissions/${userId}`;
      if (grant) await api(env, 'PUT', path, { type: MEMBER, allow: perms });
      else await api(env, 'DELETE', path);
    } catch (err) {
      console.warn('syncAccess failed:', err.message);
    }
  }
}
