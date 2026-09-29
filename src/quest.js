const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits: P,
} = require('discord.js');
const store = require('./store');

const COLORS = { open: 0x5865f2, launched: 0x57f287, cancelled: 0x808080, closed: 0x808080 };

function embed(q) {
  const lines = q.players.map((p) => {
    const mark = q.status === 'open' ? (p.ready ? '✅' : '⏳') : '⚔️';
    return `${mark} <@${p.id}>${p.id === q.hostId ? ' (host)' : ''}`;
  });
  const cap = q.max ? `/${q.max}` : '';
  const e = new EmbedBuilder()
    .setTitle(`🗺️ ${q.title}`)
    .setColor(COLORS[q.status])
    .setDescription(q.description || '*No description.*')
    .addFields(
      { name: 'When', value: q.when || 'TBD — sort it out with your party', inline: true },
      { name: 'Party size', value: `min ${q.min}${q.max ? `, max ${q.max}` : ''}`, inline: true },
      { name: `Adventurers (${q.players.length}${cap})`, value: lines.join('\n') || '—' },
    );

  if (q.status === 'open') {
    e.setFooter({
      text: `Launches automatically when ${q.min}+ players have joined and everyone is ✅ Ready.`,
    });
  } else if (q.status === 'launched') {
    e.addFields({ name: 'Party channels', value: `<#${q.textChannelId}> · <#${q.voiceChannelId}>` });
  } else {
    e.setFooter({ text: q.status === 'cancelled' ? 'Cancelled by the host.' : 'Quest complete.' });
  }
  return e;
}

function buttons(q) {
  const id = (a) => `quest:${a}:${q.id}`;
  if (q.status === 'open') {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(id('join')).setLabel('Join').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(id('ready')).setLabel('Ready').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(id('leave')).setLabel('Leave').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(id('launch')).setLabel('Launch now (host)').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(id('cancel')).setLabel('Cancel (host)').setStyle(ButtonStyle.Danger),
      ),
    ];
  }
  if (q.status === 'launched') {
    // Latecomers can still hop in while there's room.
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(id('join')).setLabel('Join').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(id('leave')).setLabel('Leave').setStyle(ButtonStyle.Secondary),
      ),
    ];
  }
  return [];
}

const render = (q) => ({ embeds: [embed(q)], components: buttons(q) });

async function refreshBoard(client, q) {
  try {
    const ch = await client.channels.fetch(q.boardChannelId);
    const msg = await ch.messages.fetch(q.messageId);
    await msg.edit(render(q));
  } catch (err) {
    console.warn(`Could not refresh board message for quest ${q.id}:`, err.message);
  }
}

function playerOverwrite(userId) {
  return {
    id: userId,
    allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.Connect, P.Speak, P.AttachFiles, P.EmbedLinks],
  };
}

function shouldAutoLaunch(q) {
  return q.status === 'open' && q.players.length >= q.min && q.players.every((p) => p.ready);
}

async function launch(client, q) {
  const guild = await client.guilds.fetch(q.guildId);
  const cfg = store.config(q.guildId);
  const slug = q.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'quest';

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
    { id: client.user.id, allow: [P.ViewChannel, P.SendMessages, P.ManageChannels, P.Connect] },
    ...q.players.map((p) => playerOverwrite(p.id)),
  ];
  if (cfg.gmRoleId) overwrites.push({ id: cfg.gmRoleId, allow: [P.ViewChannel, P.SendMessages, P.Connect, P.Speak, P.ManageMessages, P.MuteMembers] });

  const category = await guild.channels.create({
    name: `⚔️ ${q.title}`.slice(0, 100),
    type: ChannelType.GuildCategory,
    permissionOverwrites: overwrites,
  });
  const text = await guild.channels.create({ name: slug, type: ChannelType.GuildText, parent: category.id });
  const voice = await guild.channels.create({ name: `${slug}-voice`.slice(0, 100), type: ChannelType.GuildVoice, parent: category.id });

  q.status = 'launched';
  q.categoryId = category.id;
  q.textChannelId = text.id;
  q.voiceChannelId = voice.id;
  store.save();

  await text.send(
    `**${q.title}** is a go! ${q.players.map((p) => `<@${p.id}>`).join(' ')}\n` +
      `${q.when ? `🕒 ${q.when}\n` : ''}` +
      `Sort out the details here. When the quest is done, the host (or a GM) can run \`/quest close\` to tidy these channels up.`,
  );
  await refreshBoard(client, q);
}

async function teardown(client, q) {
  for (const id of [q.textChannelId, q.voiceChannelId, q.categoryId]) {
    if (!id) continue;
    try {
      await (await client.channels.fetch(id)).delete();
    } catch {}
  }
  q.status = 'closed';
  store.save();
  await refreshBoard(client, q);
}

/** Give or remove a player's access to already-launched channels. */
async function syncAccess(client, q, userId, grant) {
  try {
    const category = await client.channels.fetch(q.categoryId);
    if (grant) await category.permissionOverwrites.edit(userId, Object.fromEntries(
      ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'Connect', 'Speak', 'AttachFiles', 'EmbedLinks'].map((k) => [k, true]),
    ));
    else await category.permissionOverwrites.delete(userId);
    // Child channels sync from the category unless overridden, so nothing else to do.
  } catch (err) {
    console.warn('syncAccess failed:', err.message);
  }
}

module.exports = { render, refreshBoard, shouldAutoLaunch, launch, teardown, syncAccess };
