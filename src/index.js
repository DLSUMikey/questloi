const {
  Client,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ChannelType,
} = require('discord.js');
const crypto = require('node:crypto');
const store = require('./store');
const quest = require('./quest');

const command = new SlashCommandBuilder()
  .setName('quest')
  .setDescription('West Marches quest coordination')
  .addSubcommand((s) =>
    s
      .setName('create')
      .setDescription('Post a quest and gather a party')
      .addStringOption((o) => o.setName('title').setDescription('Quest name').setRequired(true).setMaxLength(80))
      .addStringOption((o) => o.setName('description').setDescription('Hook, location, level range, etc.').setMaxLength(1000))
      .addIntegerOption((o) => o.setName('min').setDescription('Minimum players to launch (default 3)').setMinValue(1).setMaxValue(25))
      .addIntegerOption((o) => o.setName('max').setDescription('Party cap (default: no cap)').setMinValue(1).setMaxValue(25))
      .addStringOption((o) => o.setName('when').setDescription('Proposed time, e.g. "Sat 7pm EST"').setMaxLength(100)),
  )
  .addSubcommand((s) => s.setName('close').setDescription('End this quest and delete its party channels (run inside the quest channel)'))
  .addSubcommand((s) =>
    s
      .setName('setup')
      .setDescription('Admin: set the quest board channel and GM role')
      .addChannelOption((o) => o.setName('board').setDescription('Where quests get posted').addChannelTypes(ChannelType.GuildText))
      .addRoleOption((o) => o.setName('gm_role').setDescription('Role that can see every party channel and close quests')),
  );

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
  const guildId = process.env.GUILD_ID;
  if (guildId) await (await client.guilds.fetch(guildId)).commands.set([command]);
  else await client.application.commands.set([command]);
  console.log(`Logged in as ${client.user.tag}`);
});

const reply = (i, content) => i.reply({ content, flags: MessageFlags.Ephemeral });

function isGM(i, q) {
  const gmRole = store.config(q.guildId).gmRoleId;
  return (
    i.user.id === q.hostId ||
    i.memberPermissions.has(PermissionFlagsBits.ManageGuild) ||
    (gmRole && i.member.roles.cache.has(gmRole))
  );
}

async function onCommand(i) {
  const sub = i.options.getSubcommand();

  if (sub === 'setup') {
    if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) return reply(i, 'You need Manage Server for that.');
    const cfg = store.config(i.guildId);
    const board = i.options.getChannel('board');
    const role = i.options.getRole('gm_role');
    if (board) cfg.boardChannelId = board.id;
    if (role) cfg.gmRoleId = role.id;
    store.save();
    return reply(
      i,
      `Board: ${cfg.boardChannelId ? `<#${cfg.boardChannelId}>` : 'wherever /quest create is used'}\n` +
        `GM role: ${cfg.gmRoleId ? `<@&${cfg.gmRoleId}>` : 'none'}`,
    );
  }

  if (sub === 'close') {
    const q = store.byChannel(i.channelId);
    if (!q) return reply(i, 'Run this inside an active quest channel.');
    if (!isGM(i, q)) return reply(i, 'Only the host or a GM can close this quest.');
    await reply(i, 'Closing quest and deleting channels...');
    return quest.teardown(client, q);
  }

  // create
  const cfg = store.config(i.guildId);
  const min = i.options.getInteger('min') ?? 3;
  const max = i.options.getInteger('max');
  if (max && max < min) return reply(i, "Max party size can't be lower than min.");

  const q = {
    id: crypto.randomBytes(4).toString('hex'),
    guildId: i.guildId,
    hostId: i.user.id,
    title: i.options.getString('title'),
    description: i.options.getString('description'),
    when: i.options.getString('when'),
    min,
    max,
    status: 'open',
    players: [{ id: i.user.id, ready: true }],
  };

  const board = cfg.boardChannelId ? await client.channels.fetch(cfg.boardChannelId).catch(() => null) : null;
  const channel = board ?? i.channel;
  let msg;
  try {
    msg = await channel.send(quest.render(q));
  } catch {
    return reply(i, `I can't post in ${channel}. Give me View/Send/Embed permissions there.`);
  }
  q.boardChannelId = channel.id;
  q.messageId = msg.id;
  store.quests()[q.id] = q;
  store.save();
  return reply(i, `Quest posted in ${channel}.`);
}

async function onButton(i) {
  const [, action, id] = i.customId.split(':');
  const q = store.get(id);
  if (!q || q.status === 'closed' || q.status === 'cancelled') return reply(i, 'This quest is no longer active.');

  const me = q.players.find((p) => p.id === i.user.id);

  switch (action) {
    case 'join':
      if (me) return reply(i, "You're already in this party.");
      if (q.max && q.players.length >= q.max) return reply(i, 'This party is full.');
      q.players.push({ id: i.user.id, ready: false });
      if (q.status === 'launched') await quest.syncAccess(client, q, i.user.id, true);
      break;
    case 'leave':
      if (!me) return reply(i, "You're not in this party.");
      if (i.user.id === q.hostId) return reply(i, "The host can't leave; use Cancel instead.");
      q.players = q.players.filter((p) => p.id !== i.user.id);
      if (q.status === 'launched') await quest.syncAccess(client, q, i.user.id, false);
      break;
    case 'ready':
      if (!me) return reply(i, 'Join the party first.');
      if (q.status !== 'open') return reply(i, 'Already launched.');
      me.ready = !me.ready;
      break;
    case 'launch':
      if (i.user.id !== q.hostId) return reply(i, 'Only the host can do that.');
      if (q.status !== 'open') return reply(i, 'Already launched.');
      await i.deferUpdate();
      await quest.launch(client, q);
      return;
    case 'cancel':
      if (i.user.id !== q.hostId) return reply(i, 'Only the host can do that.');
      if (q.status !== 'open') return reply(i, 'Use /quest close in the quest channel.');
      q.status = 'cancelled';
      break;
  }
  store.save();

  if (quest.shouldAutoLaunch(q)) {
    await i.deferUpdate();
    await quest.launch(client, q);
    return;
  }
  await i.update(quest.render(q));
}

client.on('interactionCreate', async (i) => {
  try {
    if (i.isChatInputCommand() && i.commandName === 'quest') await onCommand(i);
    else if (i.isButton() && i.customId.startsWith('quest:')) await onButton(i);
  } catch (err) {
    console.error(err);
    const msg = 'Something went wrong. Check that I have Manage Channels and Manage Roles permissions.';
    if (i.deferred || i.replied) i.followUp({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    else reply(i, msg).catch(() => {});
  }
});

client.login(process.env.DISCORD_TOKEN);
