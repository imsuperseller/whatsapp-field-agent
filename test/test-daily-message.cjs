'use strict';
// The two standing messages: does each one still say what Sam asked for, and
// does it stop sounding like a machine over a long run?

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  composeDailyMessage, partsFor,
  MORNING_AVAILABLE, MORNING_REVIEWS, MIDDAY_AVAILABLE, MIDDAY_REVIEWS, EVENING_WRAPUP, EVENING_OFFICE,
} = require('../daily-message.cjs');
const { localNow, dueSlot, parseClock, parseOffDays, offDayReason } = require('../daily-announcer.js');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A year of both messages, history carried forward exactly as the ledger does.
function aYear(slot, days = 365, start = new Date('2026-09-18T12:00:00Z')) {
  const history = [];
  for (let day = 0; day < days; day += 1) {
    const when = new Date(start.getTime() + day * 86400000);
    const composed = composeDailyMessage({ slot, weekday: when.getDay(), history });
    history.push({ date: when.toISOString().slice(0, 10), text: composed.text, parts: composed.parts });
  }
  return history;
}

test('every promise Sam made to his crew is in every message', () => {
  for (const entry of aYear('morning', 120)) {
    assert.match(entry.text, /morning|up and at it/i, entry.text);       // it greets them
    assert.match(entry.text, /ask|question|stuck|need|shout/i, entry.text); // it is there for questions
    assert.match(entry.text, /review/i, entry.text);                       // and the reviews
  }
  for (const entry of aYear('evening', 120)) {
    assert.match(entry.text, /evening|day|week|today/i, entry.text);     // it closes the day
    assert.match(entry.text, /call/i, entry.text);                        // service calls
    assert.match(entry.text, /job/i, entry.text);                         // and jobs
    assert.match(entry.text, /office/i, entry.text);                      // and the office
  }
});

test('the midday note says it is here and asks for the review, and never repeats inside a season', () => {
  const season = aYear('midday', 90);
  for (const entry of season) {
    assert.match(entry.text, /afternoon|midway|hey team|hope the/i, entry.text); // it greets them mid-shift
    assert.match(entry.text, /ask|stuck|here/i, entry.text);
    assert.match(entry.text, /review/i, entry.text);
  }
  const texts = season.map((entry) => entry.text);
  assert.equal(new Set(texts).size, texts.length, 'midday repeated itself inside a season');
});

test('a full year of mornings and evenings never repeats a sentence', () => {
  for (const slot of ['morning', 'evening']) {
    const texts = aYear(slot).map((entry) => entry.text);
    assert.equal(new Set(texts).size, texts.length, `${slot} repeated itself inside a year`);
  }
});

test('the same greeting never comes round inside a working week', () => {
  for (const slot of ['morning', 'evening']) {
    const openers = aYear(slot, 180).map((entry) => entry.parts.opener);
    for (let i = 0; i < openers.length; i += 1) {
      const window = openers.slice(Math.max(0, i - 6), i);
      assert.ok(!window.includes(openers[i]), `${slot} greeting repeated within a week: ${openers[i]}`);
    }
  }
});

test('Monday, Friday and the weekend get their own openers, and every day can still use the ordinary ones', () => {
  assert.ok(partsFor('morning', 1).opener.some((line) => /week/i.test(line)));
  assert.ok(partsFor('morning', 5).opener.some((line) => /friday|weekend/i.test(line)));
  assert.ok(partsFor('evening', 5).opener.some((line) => /week|friday/i.test(line)));
  for (let weekday = 0; weekday < 7; weekday += 1) {
    assert.ok(partsFor('morning', weekday).opener.length >= MORNING_AVAILABLE.length - 2);
    assert.ok(partsFor('evening', weekday).opener.length >= 10);
  }
});

test('nothing in the wording is a price, an arrival time or a company number — the crew rules hold here too', () => {
  const banned = /\$|\bprice|\bquote|\bcost\b|\beta\b|arrive|arrival|revenue|total for the (?:month|week)/i;
  for (const line of [...MORNING_AVAILABLE, ...MORNING_REVIEWS, ...MIDDAY_AVAILABLE, ...MIDDAY_REVIEWS, ...EVENING_WRAPUP, ...EVENING_OFFICE]) {
    assert.doesNotMatch(line, banned, line);
  }
});

test('an unknown slot is refused rather than guessed at', () => {
  assert.throws(() => composeDailyMessage({ slot: 'lunch', weekday: 1 }), /unknown slot/);
});

test('the clock is the crew\'s clock, not the server\'s', () => {
  // 13:04 UTC is 08:04 in Dallas on a September morning, and the day is Friday.
  const now = localNow('America/Chicago', new Date('2026-09-18T13:04:00Z'));
  assert.equal(now.date, '2026-09-18');
  assert.equal(now.weekday, 5);
  assert.equal(now.minutes, 8 * 60 + 4);
  // And the same instant is already the next hour in Israel — the timezone is read, never assumed.
  assert.equal(localNow('Asia/Jerusalem', new Date('2026-09-18T13:04:00Z')).minutes, 16 * 60 + 4);
});

test('a slot is due inside its window and never late', () => {
  const schedule = { slots: [{ id: 'morning', at: '08:00', window_minutes: 60 }, { id: 'evening', at: '20:30', window_minutes: 60 }] };
  assert.equal(dueSlot(schedule, { minutes: 8 * 60 })?.id, 'morning');
  assert.equal(dueSlot(schedule, { minutes: 8 * 60 + 59 })?.id, 'morning');
  assert.equal(dueSlot(schedule, { minutes: 9 * 60 }), null);        // the window closed
  assert.equal(dueSlot(schedule, { minutes: 12 * 60 }), null);       // a late tick is not a good morning
  assert.equal(dueSlot(schedule, { minutes: 20 * 60 + 45 })?.id, 'evening');
  assert.equal(dueSlot(schedule, { minutes: 7 * 60 + 59 }), null);   // and never early
  assert.equal(parseClock('25:00'), null);
  assert.equal(parseClock('8:00'), 480);
});

test('a group with no schedule of its own still gets eight in the morning and half eight at night', () => {
  assert.equal(dueSlot({}, { minutes: 8 * 60 + 10 })?.id, 'morning');
  assert.equal(dueSlot({}, { minutes: 20 * 60 + 40 })?.id, 'evening');
});

test('a day the schedule is off carries no message, and every other day still does', () => {
  const schedule = { skip_weekdays: ['Sun'], slots: [{ id: 'morning', at: '08:00', window_minutes: 60 }] };
  const sunday = localNow('America/Chicago', new Date('2026-09-20T13:04:00Z'));
  assert.equal(sunday.weekday, 0);
  assert.equal(offDayReason(schedule, sunday), 'Sunday is an off day for this group');
  const monday = localNow('America/Chicago', new Date('2026-09-21T13:04:00Z'));
  assert.equal(monday.weekday, 1);
  assert.equal(offDayReason(schedule, monday), null);
  assert.equal(dueSlot(schedule, monday)?.id, 'morning');
  // The day is the crew's day: 13:04 UTC on the Sunday is still Saturday evening in Israel.
  assert.equal(localNow('Asia/Jerusalem', new Date('2026-09-20T13:04:00Z')).weekday, 0);
});

test('Sunday is off unless the schedule says otherwise — and a schedule may say otherwise', () => {
  // the operator, 2026-09-20: the crew hears nothing on Sundays. A group that names no
  // off days gets that default, and the reason says it is the default.
  assert.match(offDayReason({}, { weekday: 0 }), /Sunday is an off day .* default/);
  assert.match(offDayReason({ slots: [] }, { weekday: 0 }), /Sunday is an off day/);
  for (let weekday = 1; weekday < 7; weekday += 1) assert.equal(offDayReason({}, { weekday }), null);
  // Saying [] means seven days a week; naming days means exactly those days.
  assert.equal(offDayReason({ skip_weekdays: [] }, { weekday: 0 }), null);
  assert.equal(offDayReason({ skip_weekdays: ['Sat'] }, { weekday: 0 }), null);
  assert.equal(offDayReason({ skip_weekdays: ['Sat'] }, { weekday: 6 }), 'Saturday is an off day for this group');
});

test('days are written the way a person writes them, and an unreadable day stops the run', () => {
  assert.deepEqual([...parseOffDays(['Sun'])], [0]);
  assert.deepEqual([...parseOffDays(['sunday', '0'])], [0]);
  assert.deepEqual([...parseOffDays([6, 'Sat'])], [6]);
  assert.throws(() => parseOffDays(['Someday']), /does not know the day/);
  assert.throws(() => parseOffDays('Sun'), /must be a list/);
});

// ── the whole program, run against a fixture gateway ─────────────────────────
// Its own config, its own log, and a send address on a port nothing listens on,
// so a rehearsal can never reach WhatsApp.

function fixture(skipWeekdays) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'announcer-'));
  fs.mkdirSync(path.join(dir, 'logs'));
  fs.writeFileSync(path.join(dir, '.env'), 'WAHA_API_KEY=rehearsal\n');
  fs.writeFileSync(path.join(dir, 'watched-groups.json'), JSON.stringify({
    groups: {
      'crew@g.us': {
        name: 'Rehearsal crew',
        may_post: true,
        session: 'acme',
        daily_messages: {
          enabled: true,
          timezone: 'America/Chicago',
          ...(skipWeekdays ? { skip_weekdays: skipWeekdays } : {}),
          slots: [
            { id: 'morning', at: '08:00', window_minutes: 60 },
            { id: 'evening', at: '20:00', window_minutes: 60 },
          ],
        },
      },
    },
  }));
  return dir;
}

function runAnnouncer(dir, iso) {
  let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, '..', 'daily-announcer.js'), '--now', iso], {
      env: { ...process.env, WAHA_DIR: dir, WAHA_API_BASE: 'http://127.0.0.1:9' },
      encoding: 'utf8',
    });
  } catch (error) { out = `${error.stdout || ''}${error.stderr || ''}`; }
  const logPath = path.join(dir, 'logs', 'announcer.jsonl');
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  return { out, log, ledger: fs.existsSync(path.join(dir, 'logs', 'announcer-ledger.json')) };
}

test('run on a Sunday with the crew off: nothing is composed, nothing is sent, and the log says why', () => {
  const dir = fixture(['Sun']);
  const sunday = runAnnouncer(dir, '2026-09-20T13:04:00Z');   // 08:04 Sunday in Dallas
  assert.equal(sunday.log.length, 1);
  assert.match(sunday.log[0].verdict, /no message today — Sunday is an off day/);
  assert.equal(sunday.ledger, false, 'an off day must not mark the day as sent');
  assert.equal(sunday.out.trim(), '', `nothing should be written to the group, got: ${sunday.out}`);
});

test('the very next day is an ordinary day again, and an off day never converts into a send', () => {
  const dir = fixture(['Sun']);
  const monday = runAnnouncer(dir, '2026-09-21T13:04:00Z');   // 08:04 Monday in Dallas
  assert.doesNotMatch(monday.log[0].verdict, /off day/);
  assert.match(monday.log[0].verdict, /send threw|SEND FAILED/);  // the send is attempted, and heard
  assert.equal(monday.ledger, false, 'a send that did not leave is never written down as done');
  const sunday = runAnnouncer(dir, '2026-09-20T13:04:00Z');
  assert.match(sunday.log[1]?.verdict ?? sunday.log[0].verdict, /off day/);
});

test('a group that names no off days is quiet on Sunday by default, and a group that says [] is not', () => {
  const quiet = runAnnouncer(fixture(null), '2026-09-20T13:04:00Z');
  assert.match(quiet.log[0].verdict, /no message today — Sunday is an off day .* default/);
  assert.equal(quiet.ledger, false);
  assert.equal(quiet.out.trim(), '');
  const everyDay = runAnnouncer(fixture([]), '2026-09-20T13:04:00Z');
  assert.doesNotMatch(everyDay.log[0].verdict, /off day/);
  assert.match(everyDay.log[0].verdict, /send threw|SEND FAILED/);
});
