// KV layout:
//   config:<guildId>                          -> { boardChannelId, gmRoleId }
//   quest:<id>                                -> quest
//   channel:<textChannelId>                   -> quest id, while launched
//   open:<guildId>:<hostId>:<createdAt>:<id>  -> '1', while open (lets /quest edit find the host's latest)
const kv = (env) => env.QUEST_KV;

export const config = async (env, guildId) => (await kv(env).get(`config:${guildId}`, 'json')) ?? {};
export const saveConfig = (env, guildId, cfg) => kv(env).put(`config:${guildId}`, JSON.stringify(cfg));

export const get = (env, id) => kv(env).get(`quest:${id}`, 'json');

export async function save(env, q) {
  const openKey = `open:${q.guildId}:${q.hostId}:${q.createdAt}:${q.id}`;
  const ops = [kv(env).put(`quest:${q.id}`, JSON.stringify(q))];
  ops.push(q.status === 'open' ? kv(env).put(openKey, '1') : kv(env).delete(openKey));
  if (q.textChannelId) {
    const key = `channel:${q.textChannelId}`;
    ops.push(q.status === 'launched' ? kv(env).put(key, q.id) : kv(env).delete(key));
  }
  await Promise.all(ops);
}

export async function byChannel(env, channelId) {
  const id = await kv(env).get(`channel:${channelId}`);
  return id ? get(env, id) : null;
}

export async function latestOpenByHost(env, guildId, hostId) {
  const { keys } = await kv(env).list({ prefix: `open:${guildId}:${hostId}:` });
  const last = keys.at(-1);
  return last ? get(env, last.name.split(':').at(-1)) : null;
}
