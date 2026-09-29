// Availability polling via Crab Fit (https://crab.fit, open-source When2meet alternative).
// Crab Fit slot keys are "HHmm-DDMMYYYY" in UTC; viewers see them in their own timezone.
const CRAB_API = 'https://api.crab.fit';
export const CRAB_URL = 'https://crab.fit';

const TIMEZONE = 'Asia/Manila'; // the group's timezone; slot hours below are in this zone
const DAYS = 14; // how far ahead the grid runs
const FIRST_HOUR = 10; // earliest slot start
const LAST_HOUR = 23; // latest slot start (23:00 -> midnight)
export const SESSION_HOURS = 3; // window length used when looking for the best time
const HOUR = 3600_000;

function zoneParts(epoch, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(epoch));
  return Object.fromEntries(parts.map((p) => [p.type, Number(p.value)]));
}

/** Epoch (ms) of a wall-clock time in `tz`. Two passes handle DST transitions. */
function zonedToUtc(y, m, d, h, tz) {
  const guess = Date.UTC(y, m - 1, d, h);
  const offset = (t) => {
    const p = zoneParts(t, tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
  };
  return guess - offset(guess - offset(guess));
}

const pad = (n) => String(n).padStart(2, '0');
const slotKey = (t) => {
  const d = new Date(t);
  return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}-${pad(d.getUTCDate())}${pad(d.getUTCMonth() + 1)}${d.getUTCFullYear()}`;
};
const parseKey = (k) => {
  const [time, date] = k.split('-');
  return Date.UTC(+date.slice(4), +date.slice(2, 4) - 1, +date.slice(0, 2), +time.slice(0, 2), +time.slice(2));
};

/** Hourly slots for the next DAYS days, expressed as UTC keys. Skips slots already in the past. */
function buildSlots(tz, now = Date.now()) {
  const today = zoneParts(now, tz);
  const slots = [];
  for (let day = 0; day < DAYS; day++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + day));
    for (let h = FIRST_HOUR; h <= LAST_HOUR; h++) {
      const t = zonedToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), h, tz);
      if (t > now) slots.push(slotKey(t));
    }
  }
  return slots;
}

async function crab(method, path, body) {
  const res = await fetch(CRAB_API + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Crab Fit ${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

export async function createEvent(name) {
  const ev = await crab('POST', '/event', { name, times: buildSlots(TIMEZONE), timezone: TIMEZONE });
  return { id: ev.id, url: `${CRAB_URL}/${ev.id}` };
}

/**
 * Best SESSION_HOURS-long windows, by how many people are free for the whole window.
 * Overlapping windows are collapsed so the top results are genuinely different options.
 */
export async function bestWindows(eventId, limit = 3) {
  const people = await crab('GET', `/event/${eventId}/people`);
  const free = people.map((p) => ({ name: p.name, slots: new Set(p.availability) }));
  const now = Date.now();

  const starts = new Set();
  for (const p of people) for (const k of p.availability) starts.add(parseKey(k));

  const candidates = [];
  for (const start of [...starts].sort((a, b) => a - b)) {
    if (start <= now) continue;
    const keys = Array.from({ length: SESSION_HOURS }, (_, n) => slotKey(start + n * HOUR));
    const names = free.filter((p) => keys.every((k) => p.slots.has(k))).map((p) => p.name);
    if (names.length) candidates.push({ start, names });
  }
  candidates.sort((a, b) => b.names.length - a.names.length || a.start - b.start);

  const picked = [];
  for (const c of candidates) {
    if (picked.every((p) => Math.abs(p.start - c.start) >= SESSION_HOURS * HOUR)) picked.push(c);
    if (picked.length === limit) break;
  }
  return { responded: people.length, windows: picked };
}
