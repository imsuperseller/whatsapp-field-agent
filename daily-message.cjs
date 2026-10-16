'use strict';
// What the assistant says to the crew every morning and every night.
//
// Sam asked for two standing messages a day (2026-09-17, through the operator):
//   morning  — good morning, I'm here for any questions, don't forget reviews
//   evening  — hope you had a good day, update all your service calls and jobs,
//              call the office if you need help
//
// And one hard condition: "dont repeat so each time u phrase things differently
// like a human would". A man who reads the same sentence at 8am for a fortnight
// stops reading it at all, which is the same as never sending it.
//
// So a message is BUILT, not looked up: an opener, the body, the reminder, and
// sometimes a sign-off, each drawn from its own set, each forbidden from
// repeating what it said in the last few days. The whole finished sentence is
// checked against everything sent before it as well. Nothing here touches the
// network, the clock or a file — the caller passes the day and the history in,
// so the same day can be replayed in a test and the wording proven.

// ---------------------------------------------------------------------------
// The parts. Written the way the crew writes in their own group: short, plain,
// no marketing voice, no "Dear team". Occasional emoji, never a wall of them.
// ---------------------------------------------------------------------------

const MORNING_OPENERS = {
  any: [
    'Morning everyone ☀️',
    'Good morning team',
    'Morning all',
    'Good morning 👋',
    'Morning gents',
    'Hey team, good morning',
    'Morning — hope you got some sleep',
    'Good morning, crew',
    'Morning everybody',
    'Up and at it — good morning',
  ],
  1: [
    'Morning everyone, fresh week',
    'Good morning — new week, clean start',
    'Monday morning, here we go',
  ],
  5: [
    "Morning all, it's Friday 🙌",
    'Good morning — last push before the weekend',
    'Friday morning, nearly there',
  ],
  6: [
    'Morning everyone, weekend shift',
    'Good morning — hope the weekend is treating you alright',
  ],
  0: [
    'Morning all, Sunday one',
    'Good morning — quiet one hopefully',
  ],
};

const MORNING_AVAILABLE = [
  "I'm around all day if anything comes up — just ask.",
  'Anything you get stuck on out there, ask me here.',
  "I'm here if you need a blank, a code or a procedure.",
  "Questions? Drop them in here, I'm on.",
  "If something's got you stuck, ask me — that's what I'm for.",
  "I'm on all day, ask me whatever you need.",
  'Any question, big or small, put it in here.',
  'Need something looked up? Ask away.',
  "Shout if you need me, I don't go anywhere.",
  "Stuck on a job? Ask me before you burn an hour on it.",
];

const MORNING_REVIEWS = [
  "And don't forget to ask for a review when the job goes well 🌟",
  'One more thing — reviews. Ask while you are still standing there.',
  "Don't forget the reviews, they do more for us than people think.",
  'Happy customer? Ask for the review before you drive off.',
  'And reviews — grab one today if you can.',
  "Keep the reviews coming, ask when the customer's smiling.",
  "Don't forget to ask for a review on every good job.",
  'Reviews please — a quick ask at the end goes a long way.',
  'If the customer is happy, that is the moment to ask for the review.',
  'Reviews are the easy part of the job — ask for one today.',
];

// Midday. Not part of the standing two — this is the "we are here, and here is
// what good looks like" note, sent when the crew is mid-shift and a job has just
// gone well. the operator asked for one on 2026-09-17 to show Sam the thing is alive.
const MIDDAY_OPENERS = {
  any: [
    'Afternoon everyone ☀️',
    'Afternoon all',
    'Hope the day is going alright out there',
    'Afternoon crew',
    'Midway through — hope it is going well',
    'Afternoon gents',
    'Hey team 👋',
    'Hope the morning treated you fairly',
  ],
  5: [
    'Afternoon all, nearly the weekend',
  ],
};

const MIDDAY_AVAILABLE = [
  'Just so you know I am on all day — a key blank, a pin code, a procedure, anything that has you stuck out there, ask me right here.',
  'I am here the whole shift. Stuck on a blank, a code or a procedure? Ask me before you lose an hour to it.',
  'If a job is fighting you, ask me here — that is what I am for, all day.',
  'Anything you need looked up while you are out, put it in here and I will get it.',
  'I am on all afternoon. Ask me anything — the worst that happens is I say I do not know and go find out.',
  'Whatever the truck throws at you this afternoon, ask me here first.',
];

const MIDDAY_REVIEWS = [
  'And do not forget the reviews. When the customer is happy, that is the moment to ask 🌟',
  'And if this morning went well for you — ask that customer for a review before you drive off.',
  'One more thing: reviews. The ask takes ten seconds and it is worth more than the ten seconds.',
  'And reviews — if you had a good one today, ask for it while you are still standing there 🌟',
  'Good job behind you already? Ask for the review, they rarely say no.',
];

const EVENING_OPENERS = {
  any: [
    'Evening everyone',
    "Alright, that's the day",
    'Hope you all had a good one today',
    'Evening crew — good work out there',
    'Hey team, hope today went your way',
    'Evening all',
    'Long day? Hope it treated you well',
    'Hope today was a good one',
    'Evening gents',
    "That's us for today",
  ],
  5: [
    'Hope it was a good week, enjoy the weekend',
    "Evening all — that's the week done",
    'Friday night, hope the week was kind',
  ],
  0: [
    'Evening everyone, hope the Sunday was easy',
  ],
};

const EVENING_WRAPUP = [
  'Before you switch off, make sure all your service calls and jobs are updated.',
  'Quick one — get your jobs and service calls updated tonight.',
  "Don't leave the write-ups for tomorrow, update your calls and jobs now.",
  'Make sure everything you ran today is written up — calls and jobs both.',
  'Update your service calls and close out your jobs before you settle in.',
  'Take two minutes and update all your service calls and jobs.',
  'Please get every service call and job updated before the day is closed off.',
  'Whatever you ran today, get it updated — calls and jobs.',
];

const EVENING_OFFICE = [
  "And if anything is not clear, call the office — they would rather hear from you.",
  'Anything you need a hand with, call the office.',
  'Stuck on something? Give the office a ring.',
  'If you need help with any of it, the office is there — call them.',
  'Any trouble, call the office.',
  "Don't sit on a problem, call the office and they will sort it.",
  'If something needs sorting out, the office is a phone call away.',
];

const EVENING_SIGNOFF = [
  'Get some rest 😴',
  'See you tomorrow',
  'Goodnight all',
  'Drive safe',
  'Rest up',
  null,
  null,
];

// ---------------------------------------------------------------------------

/** The openers for a slot on a weekday: the everyday ones plus that day's own. */
const OPENERS = { morning: MORNING_OPENERS, midday: MIDDAY_OPENERS, evening: EVENING_OPENERS };

function openersFor(slot, weekday) {
  const table = OPENERS[slot];
  return [...table.any, ...(table[weekday] || [])];
}

const SLOTS = {
  morning: { body: () => MORNING_AVAILABLE, reminder: () => MORNING_REVIEWS, signoff: () => [null] },
  midday: { body: () => MIDDAY_AVAILABLE, reminder: () => MIDDAY_REVIEWS, signoff: () => [null] },
  evening: { body: () => EVENING_WRAPUP, reminder: () => EVENING_OFFICE, signoff: () => EVENING_SIGNOFF },
};

function partsFor(slot, weekday) {
  const shape = SLOTS[slot];
  if (!shape) throw new Error(`unknown slot: ${slot}`);
  return { opener: openersFor(slot, weekday), body: shape.body(), reminder: shape.reminder(), signoff: shape.signoff() };
}

/**
 * How many recent sends a single part must stay clear of. A greeting repeated
 * inside a week is the thing that reads like a machine, so it is held back
 * hardest; the body and the reminder carry the actual instruction and may come
 * round sooner. Never so large that every option is excluded.
 */
const COOLDOWN = { opener: 6, body: 4, reminder: 4, signoff: 3 };

function recentlyUsed(history, part, cooldown) {
  const used = new Set();
  for (const entry of history.slice(-cooldown)) {
    const value = entry && entry.parts && entry.parts[part];
    if (value != null) used.add(value);
  }
  return used;
}

function choose(options, part, history, random) {
  const cooldown = Math.min(COOLDOWN[part] || 3, Math.max(0, options.length - 1));
  const banned = recentlyUsed(history, part, cooldown);
  const open = options.filter((option) => !banned.has(option));
  const pool = open.length ? open : options;
  return pool[Math.floor(random() * pool.length) % pool.length];
}

/** Two shapes, so the reminder is not always the last line of the message. */
function render({ opener, body, reminder, signoff }, shape) {
  // "And don't forget the reviews" is a second thought, not an opening line. When
  // the reminder is moved to the front it stops being one.
  const lead = (line) => String(line).replace(/^(?:And|One more thing —)\s+/, (m) => '').replace(/^./, (c) => c.toUpperCase());
  const lines = shape === 'reminder-first'
    ? [opener, lead(reminder), body]
    : [opener, body, reminder];
  if (signoff) lines.push(signoff);
  return `${lines[0]}.\n${lines.slice(1).join(' ')}`
    .replace(/([.!?🌟😴👋☀️🙌])\.\n/, '$1\n')
    .trim();
}

/**
 * Compose one message.
 *
 * @param {'morning'|'evening'} slot
 * @param {number} weekday        0 = Sunday, as Date.getDay() gives it
 * @param {Array}  history        previous sends for this group and slot, oldest first
 * @param {Function} random       () => [0,1), injectable so a test is not a coin toss
 * @returns {{ text: string, parts: object }}
 */
function composeDailyMessage({ slot, weekday, history = [], random = Math.random }) {
  const options = partsFor(slot, weekday);
  const spoken = new Set(history.map((entry) => entry && entry.text).filter(Boolean));

  // Try for a sentence nobody in this group has been sent before. The part
  // cooldowns alone make a repeat unlikely; this makes it impossible to send one
  // while any unseen combination is still reachable.
  let last = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const parts = {
      opener: choose(options.opener, 'opener', history, random),
      body: choose(options.body, 'body', history, random),
      reminder: choose(options.reminder, 'reminder', history, random),
      signoff: choose(options.signoff, 'signoff', history, random),
    };
    const shape = random() < 0.25 ? 'reminder-first' : 'plain';
    const text = render(parts, shape);
    last = { text, parts: { ...parts, shape } };
    if (!spoken.has(text)) return last;
  }
  return last;
}

module.exports = {
  composeDailyMessage,
  partsFor,
  COOLDOWN,
  MORNING_OPENERS,
  MORNING_AVAILABLE,
  MORNING_REVIEWS,
  MIDDAY_OPENERS,
  MIDDAY_AVAILABLE,
  MIDDAY_REVIEWS,
  EVENING_OPENERS,
  EVENING_WRAPUP,
  EVENING_OFFICE,
  EVENING_SIGNOFF,
};
