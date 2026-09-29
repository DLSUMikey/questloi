const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'data', 'db.json');

let db = { config: {}, quests: {} };
try {
  db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch {}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

module.exports = {
  save,
  config: (guildId) => (db.config[guildId] ??= {}),
  quests: () => db.quests,
  get: (id) => db.quests[id],
  byChannel: (channelId) =>
    Object.values(db.quests).find((q) => q.textChannelId === channelId && q.status === 'launched'),
};
