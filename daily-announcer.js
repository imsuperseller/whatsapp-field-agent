'use strict';
// The two standing messages a day, into the crew's own group.
//
// Sam's request (2026-09-17, through the operator): a good-morning at 8, and an
// end-of-day around nine, every day — and never the same wording twice. The
// wording lives next door in daily-message.cjs; this file decides whether a
// message is DUE, sends it once, and writes down that it did.
//
// Four rules it will not break:
//   1. It obeys /opt/waha/watched-groups.json exactly like the answer bridge.
//      A group with `may_post: false` is listened to, never posted in — a
//      standing announcement is still posting, and a group that has not been
//      switched on does not get one because a schedule said so.
//   2. One send per group, per slot, per LOCAL day. The ledger is the authority,
//      not the process being alive; a restart, a retry or a second cron tick
//      cannot put the same good-morning in the group twice.
//   3. A late tick is not a send. If the box was down at 8am and the timer fires
//      at noon, the window has closed and the morning message is simply skipped.
//      Nobody wants "Good morning ☀️" at lunchtime.
//   4. An off day carries no message at all. Sunday is off unless the group's
//      schedule says otherwise: the operator asked on 2026-09-20 that the crew hear
//      nothing on Sundays, and a default that lives in this file is one a
//      fresh server cannot forget. A schedule may name its own off days
//      (`skip_weekdays`, e.g. ["Sun", "Sat"]) or post seven days a week
//      (`skip_weekdays: []`). On an off day nothing is composed and nothing is
//      sent, and the reason is written to the log, so a quiet Sunday can be
//      told apart from a broken one. The day is read on the crew's clock, in
//      the same timezone as the slots.
//
// Run it every fifteen minutes from cron. Nothing happens on a tick outside a
// window, and that nothing is recorded too, so a silent day can be told apart
// from a broken one.
//
//   node daily-announcer.js                 decide and send what is due
//   node daily-announcer.js --dry-run       decide and print, send nothing
//   node daily-announcer.js --preview 14    two weeks of wording, no side effects
//   node daily-announcer.js --preview 14 --chat <group id>   a named group's own
//                                           schedule, so its off days show as off
//   node daily-announcer.js --now 2026-09-18T08:04  pretend it is that local time

const fs = require('fs');
const path = require('path');
const { composeDailyMessage } = require('./daily-message.cjs');

const DIR = process.env.WAHA_DIR || '/opt/waha';
// The gateway on the box, and the one address every send goes through. A test
// points it at a port nothing listens on so a rehearsal can never touch WhatsApp.
const API = process.env.WAHA_API_BASE || 'http://127.0.0.1:3000';
const WATCHED = path.join(DIR, 'watched-groups.json');
const LEDGER = path.join(DIR, 'logs', 'announcer-ledger.json');
const LOG = path.join(DIR, 'logs', 'announcer.jsonl');
const HISTORY_KEPT = 120;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};

function env() {
  return Object.fromEntries(
    fs.readFileSync(path.join(DIR, '.env'), 'utf8')
      .split('\n').filter((l) => l.includes('=')).map((l) => {
        const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)];
      }),
  );
}

function record(entry) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch (error) {
    process.stderr.write(`announcer: could not write the log: ${error.message}\n`);
  }
}

function readLedger() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function writeLedger(all) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  const temp = `${LEDGER}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(all, null, 2));
  fs.renameSync(temp, LEDGER);
}

/**
 * What day and what time is it where the crew is? A crew reads
 * "good morning" at eight in the morning THEIR time; the server's clock is not
 * an opinion worth having about it.
 */
function localNow(timezone, at = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(at).map((p) => [p.type, p.value]),
  );
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: weekdays[parts.weekday],
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
}

function parseClock(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes < 24 * 60 ? minutes : null;
}

const DEFAULT_SLOTS = [
  { id: 'morning', at: '08:00', window_minutes: 60 },
  { id: 'evening', at: '20:00', window_minutes: 60 },
];

const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_NAMES = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
};

/** The off days a schedule gets when it names none: Sunday. */
const DEFAULT_OFF_DAYS = ['Sun'];

/**
 * The weekdays a schedule does not post on, written the way a person thinks
 * about days — `["Sun"]`, `"Sunday"` and `0` all mean the same thing. A
 * schedule that says nothing gets DEFAULT_OFF_DAYS; one that says `[]` posts
 * every day of the week.
 *
 * Anything unreadable throws instead of being ignored: a typo in a day name
 * must never turn into a message landing in a crew's group on their day off.
 */
function parseOffDays(list) {
  if (list == null) list = DEFAULT_OFF_DAYS;
  if (!Array.isArray(list)) {
    throw new Error('skip_weekdays must be a list of weekday names or numbers, like ["Sun"]');
  }
  const days = new Set();
  for (const raw of list) {
    if (Number.isInteger(raw) && raw >= 0 && raw <= 6) { days.add(raw); continue; }
    const key = String(raw).trim().toLowerCase();
    if (/^[0-6]$/.test(key)) { days.add(Number(key)); continue; }
    if (key in WEEKDAY_NAMES) { days.add(WEEKDAY_NAMES[key]); continue; }
    throw new Error(`skip_weekdays does not know the day "${raw}"`);
  }
  return days;
}

/** Why today carries no message at all, or null when today is an ordinary day. */
function offDayReason(schedule, now) {
  const named = schedule && schedule.skip_weekdays;
  if (!parseOffDays(named).has(now.weekday)) return null;
  return `${WEEKDAY_LABELS[now.weekday]} is an off day for this group${named == null ? ' (the default — set skip_weekdays to change it)' : ''}`;
}

/** Which slot, if any, is due right now for this group. */
function dueSlot(schedule, now) {
  const slots = Array.isArray(schedule.slots) && schedule.slots.length ? schedule.slots : DEFAULT_SLOTS;
  for (const slot of slots) {
    const start = parseClock(slot.at);
    if (start == null) continue;
    const window = Number(slot.window_minutes) > 0 ? Number(slot.window_minutes) : 60;
    if (now.minutes >= start && now.minutes < start + window) return { ...slot, start, window };
  }
  return null;
}

async function send(session, chatId, text, e) {
  const res = await fetch(`${API}/api/sendText`, {
    method: 'POST',
    headers: { 'X-Api-Key': e.WAHA_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, chatId, text }),
  });
  return res.ok;
}

function groups() {
  const parsed = JSON.parse(fs.readFileSync(WATCHED, 'utf8'));
  return Object.entries(parsed.groups || {});
}

async function run() {
  const dryRun = flag('dry-run');
  const pretend = value('now') ? new Date(value('now')) : new Date();
  if (Number.isNaN(pretend.getTime())) throw new Error('--now needs a date like 2026-09-18T08:04');

  const ledger = readLedger();
  let changed = false;

  for (const [chatId, group] of groups()) {
    const schedule = group.daily_messages;
    if (!schedule || schedule.enabled === false) continue;

    const why = [];
    // Listening-only is a decision about this group, and it outranks a schedule.
    if (!group.may_post) why.push('the group is listening only (may_post is false)');
    if (!group.session) why.push('no gateway session on the group');

    const now = localNow(schedule.timezone || 'America/Chicago', pretend);
    // A day the schedule is off outranks everything below it: nothing is
    // composed, and an off day still says so in the log.
    const offDay = offDayReason(schedule, now);
    if (offDay) {
      record({ chatId, group: group.name, verdict: `no message today — ${offDay}`, date: now.date, weekday: now.weekday });
      continue;
    }
    const slot = dueSlot(schedule, now);
    if (!slot) {
      record({ chatId, group: group.name, verdict: 'nothing due at this hour', local: now });
      continue;
    }

    const key = `${chatId}:${slot.id}`;
    const history = Array.isArray(ledger[key]) ? ledger[key] : [];
    if (history.some((entry) => entry && entry.date === now.date)) {
      record({ chatId, group: group.name, slot: slot.id, verdict: 'already sent today', date: now.date });
      continue;
    }

    if (why.length) {
      record({ chatId, group: group.name, slot: slot.id, verdict: `not sent — ${why.join('; ')}` });
      continue;
    }

    const composed = composeDailyMessage({ slot: slot.id, weekday: now.weekday, history });

    if (dryRun) {
      process.stdout.write(`\n[${group.name} · ${slot.id} · ${now.date}]\n${composed.text}\n`);
      continue;
    }

    let sent = false;
    try {
      sent = await send(group.session, chatId, composed.text, env());
    } catch (error) {
      record({ chatId, group: group.name, slot: slot.id, verdict: `send threw: ${error.message}` });
      continue;
    }

    // Only a message that actually left is written down. A failed send that
    // marked the day done would swallow the morning entirely; leaving it unwritten
    // lets the next tick inside the window try again.
    if (sent) {
      ledger[key] = [...history, { date: now.date, text: composed.text, parts: composed.parts, at: new Date().toISOString() }]
        .slice(-HISTORY_KEPT);
      changed = true;
    }
    record({ chatId, group: group.name, slot: slot.id, verdict: sent ? 'sent' : 'SEND FAILED', text: composed.text });
    process.stdout.write(`${sent ? 'sent' : 'SEND FAILED'}: ${group.name} · ${slot.id}\n`);
  }

  if (changed) writeLedger(ledger);
}

/**
 * The schedule a preview is reading, so the days it skips are that group's own
 * and not someone else's. `--chat <group id>` names one; with nothing named, the
 * first group that actually posts daily is used. An unreadable file is not a
 * reason to invent an answer — the preview then simply shows every day.
 */
function previewSchedule() {
  const chat = value('chat');
  try {
    const entries = Object.entries(JSON.parse(fs.readFileSync(WATCHED, 'utf8')).groups || {});
    const chosen = chat
      ? entries.find(([id]) => id === chat)
      : entries.find(([, group]) => group.daily_messages && group.daily_messages.enabled !== false);
    if (!chosen) return null;
    return chosen[1].daily_messages;
  } catch { return null; }
}

/** A fortnight of wording, on the screen, before a single message goes out. */
function preview(days) {
  const start = value('from') ? new Date(value('from')) : new Date();
  const history = { morning: [], evening: [] };
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const off = parseOffDays((previewSchedule() || {}).skip_weekdays);
  for (let day = 0; day < days; day += 1) {
    const when = new Date(start.getTime() + day * 86400000);
    const weekday = when.getDay();
    if (off.has(weekday)) {
      process.stdout.write(`\n── ${names[weekday]} ${when.toISOString().slice(0, 10)} — off day, no message ──\n`);
      continue;
    }
    process.stdout.write(`\n── ${names[weekday]} ${when.toISOString().slice(0, 10)} ──\n`);
    for (const slot of ['morning', 'evening']) {
      const composed = composeDailyMessage({ slot, weekday, history: history[slot] });
      history[slot].push({ date: when.toISOString().slice(0, 10), text: composed.text, parts: composed.parts });
      process.stdout.write(`\n${slot === 'morning' ? '08:00' : '20:00'}\n${composed.text}\n`);
    }
  }
  const all = [...history.morning, ...history.evening].map((entry) => entry.text);
  process.stdout.write(`\n${all.length} messages, ${new Set(all).size} of them different.`);
  if (off.size) {
    process.stdout.write(` No message goes out on ${[...off].sort().map((d) => names[d]).join(', ')}.`);
  }
  process.stdout.write('\n');
}

if (require.main === module) {
  if (flag('preview')) {
    preview(Number(value('preview')) > 0 ? Number(value('preview')) : 14);
  } else {
    run().catch((error) => {
      record({ verdict: `run failed: ${error.message}` });
      process.stderr.write(`announcer: ${error.message}\n`);
      process.exit(1);
    });
  }
}

module.exports = { localNow, dueSlot, parseClock, parseOffDays, offDayReason, DEFAULT_SLOTS, DEFAULT_OFF_DAYS };
