const API = 'https://discord.com/api/v10';

export const P = {
  ManageChannels: 1n << 4n,
  ManageGuild: 1n << 5n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  ManageMessages: 1n << 13n,
  EmbedLinks: 1n << 14n,
  AttachFiles: 1n << 15n,
  ReadMessageHistory: 1n << 16n,
  Connect: 1n << 20n,
  Speak: 1n << 21n,
  MuteMembers: 1n << 22n,
};
const ADMINISTRATOR = 1n << 3n;

export const bits = (...perms) => perms.reduce((a, b) => a | b, 0n).toString();
export const hasPerm = (memberPerms, perm) => {
  const b = BigInt(memberPerms);
  return (b & ADMINISTRATOR) !== 0n || (b & perm) === perm;
};

export async function api(env, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bot ${env.DISCORD_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'DiscordBot (questloi, 1.0.0)',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Discord ${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const hex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));

/** Verify Discord's Ed25519 signature over timestamp + raw body. */
export async function verifyRequest(request, body, publicKey) {
  const sig = request.headers.get('x-signature-ed25519');
  const ts = request.headers.get('x-signature-timestamp');
  if (!sig || !ts) return false;
  try {
    const key = await crypto.subtle.importKey('raw', hex(publicKey), { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }, false, ['verify']);
    return await crypto.subtle.verify('NODE-ED25519', key, hex(sig), new TextEncoder().encode(ts + body));
  } catch {
    return false;
  }
}
