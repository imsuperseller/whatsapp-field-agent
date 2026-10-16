/**
 * The chat door must never contradict the brain.
 *
 * 2026-09-23: the operator asked Bobot privately "what key blank for a 2019 Ram 1500?".
 * The brain answered "I do have something on this in the shop knowledge, but not
 * an answer I can give you here. Ask Sam." (needsPermission, escalate) — and
 * the bridge replaced it with "don't have that one in the shop knowledge. want
 * me to look it up online? yes or no", which is false. The same happened to
 * "2018 Ram 1500 what do I need to make a key" (2026-09-14) and "how do I drill
 * open a Schlage Everest?" (2026-09-22).
 *
 * Rule: when the brain says the shop HAS material, the crew gets the brain's
 * message in the crew's voice and no web-search offer. The "look it up online?
 * yes or no" offer is only for a brain that truly found nothing.
 */
// Each case below is a separate conversation, not a burst: lift the live per-group post cap.
process.env.BOBOT_GROUP_BURST_MAX = '1000';
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobot-withheld-'));
process.env.WAHA_DIR = dir;
fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
fs.writeFileSync(path.join(dir, '.env'), 'WAHA_API_KEY=x\nSITE_URL=https://example.invalid\nWHATSAPP_BRIDGE_SECRET=y\n');
fs.writeFileSync(path.join(dir, 'watched-groups.json'), JSON.stringify({
  groups: { 'G@g.us': { name: 'Test', may_post: true, tenant_slug: 'acme-locks' } },
}));
fs.writeFileSync(path.join(dir, 'logs', 'answered-ids.json'), '[]');

const WITHHELD = 'Answer:\n🔹 I do have something on this in the shop knowledge, but not an answer I can give you here.\n🔹 Ask Sam.';
const NOTHING = "Answer:\n🔹 I don't have this in the shop knowledge yet. Want me to look it up online?";
const PARTS = 'Answer:\n🔹 2019 Ram 1500 (new body) takes a 4 or 5 button smart key, FCC OHT-4882056.\n🔹 OEM part numbers 68291688AD, 68291691AD.\n🔹 The emergency blade profile is not listed in the catalogue.';

// What the brain says next, set per case.
let next = null;
const sent = [];
const brainBodies = [];
global.fetch = async (url, opts) => {
  if (String(url).includes('/api/sendText')) { sent.push(JSON.parse(opts.body).text); return { ok: true, json: async () => ({}) }; }
  if (String(url).includes('/api/sessions')) return { ok: true, json: async () => ([{ name: 's', me: { id: '15555550100@c.us', lid: '100000000000002@lid' } }]) };
  if (String(url).includes('/groups')) {
    return { ok: true, json: async () => ([{ JID: 'G@g.us', Participants: [{ JID: 'tech@lid', PhoneNumber: '12145550100' }] }]) };
  }
  if (String(url).includes('/api/whatsapp/tech-support')) {
    const body = JSON.parse(opts.body);
    brainBodies.push(body);
    if (body.action === 'search_online') {
      return { ok: true, json: async () => ({ answer: 'Answer:\n🔹 Found online.', awaitingConfirmation: true, provisionalAnswer: 'Found online.', question: body.question }) };
    }
    return { ok: true, json: async () => ({ ...next, question: body.question }) };
  }
  throw new Error(`unexpected call to ${url}`);
};

const { handle, crewVoice, brainFoundMaterial } = require('../bridge.js');
const now = () => Math.floor(Date.now() / 1000);
let id = 0;
const message = (body) => ({ from: 'G@g.us', participant: 'tech@lid', id: `w${id++}`, timestamp: now(), body, hasMedia: false });

(async () => {
  let fails = 0;
  const check = (ok, label, got) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — got ${JSON.stringify(got)}`}`);
    if (!ok) fails++;
  };

  // 1. The three real questions, each answered by a brain that HAS material.
  for (const question of [
    'Bobot what key blank for a 2019 Ram 1500?',
    'Bobot 2018 Ram 1500 what do I need to make a key',
    'Bobot how do I drill open a Schlage Everest?',
  ]) {
    next = { answer: WITHHELD, needsPermission: true, escalate: true, withheld: true };
    sent.length = 0;
    await handle(message(question), 's');
    check(sent.length === 1
        && !/don'?t have/i.test(sent[0])
        && !/look it up online/i.test(sent[0])
        && !/yes or no/i.test(sent[0])
        && /i do have something on this in the shop knowledge/i.test(sent[0])
        && /ask Sam/.test(sent[0])
        && !/Answer:|🔹/.test(sent[0]),
      `withheld → the brain's truthful message, crew voice: "${question}"`, sent);

    // No web-search offer was made, so a "yes" must not start one.
    const before = brainBodies.length;
    sent.length = 0;
    await handle(message('yes'), 's');
    check(brainBodies.length === before && sent.length === 0,
      '  ...and a "yes" afterwards does not start an online search nobody offered', { calls: brainBodies.length - before, sent });
  }

  // 2. An older brain that sends the sentence without the flag is read the same way.
  next = { answer: WITHHELD, needsPermission: true, escalate: true };
  sent.length = 0;
  await handle(message('Bobot what fob for a 2019 Ram 1500?'), 's');
  check(sent.length === 1 && !/don'?t have/i.test(sent[0]) && /i do have something/i.test(sent[0]),
    'no flag, truthful sentence → still relayed, never "don\'t have"', sent);

  // 3. Truly nothing found → the online offer, and "yes" runs the search.
  next = { answer: NOTHING, needsPermission: true, escalate: true, withheld: false };
  sent.length = 0;
  await handle(message('Bobot what is the fuse for the pats ring on a 2004 f250'), 's');
  check(sent.length === 1 && /don't have that one in the shop knowledge/i.test(sent[0]) && /look it up online\? yes or no/i.test(sent[0]),
    'truly nothing → "don\'t have that one ... look it up online? yes or no"', sent);
  sent.length = 0;
  await handle(message('yes'), 's');
  check(brainBodies.at(-1).action === 'search_online', '  ...and "yes" runs the online search', brainBodies.at(-1));

  // 4. A parts answer is passed on as an answer: FCC and part numbers, no price, no offer.
  next = { answer: PARTS, escalate: false };
  sent.length = 0;
  await handle(message('Bobot what key blank for a 2019 Ram 1500?'), 's');
  check(sent.length === 1
      && /OHT-4882056/.test(sent[0])
      && /68291691AD/.test(sent[0])
      && !/\$\s?\d/.test(sent[0])
      && !/don'?t have|yes or no/i.test(sent[0]),
    'parts answer → blank / FCC / part number reach the tech, no price, no offer', sent);

  // 5. The helpers themselves.
  check(crewVoice(WITHHELD) === 'i do have something on this in the shop knowledge, but not an answer i can give you here. ask Sam.',
    'crewVoice keeps the words and the owner\'s name, drops the packaging', crewVoice(WITHHELD));
  check(brainFoundMaterial({ withheld: false }, WITHHELD) === false && brainFoundMaterial({}, NOTHING) === false,
    'an explicit withheld:false and the no-knowledge wording both mean "nothing found"');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fails ? `\n${fails} case(s) wrong` : '\nthe chat door never contradicts the brain');
  process.exit(fails ? 1 : 0);
})().catch((error) => {
  fs.rmSync(dir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});
