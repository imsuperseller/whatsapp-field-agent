/**
 * Private (one-to-one) chats with Bobot, 2026-09-23.
 *
 * Sam approved his technicians, himself and the office messaging Bobot
 * privately on the same number. His rule still holds: membership of the group
 * IS the access list. These replays pin that rule for private chats:
 *   - a current member is answered, and the brain is told the chat is private;
 *   - anyone else, including someone who has since left the group, gets
 *     silence (no reply at all) and a line in the log;
 *   - a roster that cannot be read admits nobody;
 *   - "ok" / "thanks" / "👍" are left alone, everything else is a question;
 *   - the yes/no follow-up works, per person;
 *   - a private id (@lid) is resolved to the real phone.
 *
 * Runs the real bridge with the network stubbed: nothing reaches WhatsApp, the
 * site, or any AI.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobot-private-'));
process.env.WAHA_DIR = dir;
fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
fs.writeFileSync(path.join(dir, '.env'), 'WAHA_API_KEY=x\nSITE_URL=https://example.invalid\nWHATSAPP_BRIDGE_SECRET=y\n');
fs.writeFileSync(path.join(dir, 'watched-groups.json'), JSON.stringify({
  groups: {
    'ACME@g.us': {
      name: 'Field Techs', session: 'acme', may_post: true,
      tenant_slug: 'acme-locks', tester_phones: ['12145550100'],
    },
    'QUIET@g.us': { name: 'Listening only', session: 'quiet', may_post: false, tenant_slug: 'someone-else' },
  },
}));

const MEMBERS = [
  { JID: '111111111111111@lid', PhoneNumber: '14695550001@s.whatsapp.net' }, // Alex, a technician
  { JID: '222222222222222@lid', PhoneNumber: '14695550002@s.whatsapp.net' }, // Jordan, a technician
  { JID: '333333333333333@lid', PhoneNumber: '12145550100@s.whatsapp.net' }, // the operator tester
];
let roster = MEMBERS.slice();
let rosterMode = 'ok'; // 'ok' | 'http-error' | 'throws'
const sent = [];
const brain = [];
const calls = [];
let brainReply = null;

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push(u);
  if (u.endsWith('/api/sessions')) return { ok: true, json: async () => ([{ name: 'acme', me: { id: '15555550100@c.us', lid: '999999999999999@lid' } }]) };
  if (u.includes('/groups')) {
    if (rosterMode === 'throws') throw new Error('connect ECONNREFUSED');
    if (rosterMode === 'http-error') return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, json: async () => ([{ JID: 'ACME@g.us', Participants: roster }]) };
  }
  if (u.includes('/lids/')) return { ok: false, status: 404, json: async () => ({}) };
  if (u.endsWith('/api/sendText')) { sent.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
  if (u.startsWith('http://127.0.0.1:3000/api/files/')) {
    return { ok: true, arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).buffer };
  }
  if (u.endsWith('/api/whatsapp/tech-support')) {
    const body = JSON.parse(opts.body);
    brain.push(body);
    const answer = brainReply ? brainReply(body) : { answer: 'Answer:\n1. HU101 is the non-transponder blank.' };
    return { ok: true, json: async () => answer };
  }
  throw new Error(`unexpected call to ${u}`);
};

const bridgePath = require.resolve('../bridge.js');
let { handle } = require(bridgePath);
const fresh = () => { delete require.cache[bridgePath]; ({ handle } = require(bridgePath)); };

const nowS = () => Math.floor(Date.now() / 1000);
let n = 0;
const dm = (from, body, extra = {}) => ({ from, id: `dm-${n++}`, timestamp: nowS(), body, hasMedia: false, fromMe: false, ...extra });
const records = () => fs.readFileSync(path.join(dir, 'logs', 'bridge.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const lastRecord = () => records().at(-1);

let fails = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      ${JSON.stringify(detail)}`}`);
  if (!ok) fails++;
};
const reset = () => { sent.length = 0; brain.length = 0; calls.length = 0; brainReply = null; };

(async () => {
  // 1. A member asks privately, from a phone-addressed chat.
  reset();
  let v = await handle(dm('14695550001@c.us', 'what blank for a 2016 Nissan Altima'), 'acme');
  check(v === 'answered'
      && brain.length === 1
      && brain[0].channel === 'private'
      && brain[0].phone === '14695550001'
      && brain[0].tenantSlug === 'acme-locks'
      && brain[0].tester === false
      && brain[0].question === 'what blank for a 2016 Nissan Altima'
      && sent.length === 1 && sent[0].chatId === '14695550001@c.us' && sent[0].session === 'acme'
      && /HU101/.test(sent[0].text) && !/^Answer:/.test(sent[0].text),
    'member DM is answered in the private chat, marked private for the brain', { v, brain, sent });
  check(lastRecord().channel === 'private' && lastRecord().verdict === 'answered' && lastRecord().group === 'Field Techs',
    'the log line says it was a private chat', lastRecord());

  // 2. Something the group would leave alone as room chatter is a question here.
  reset();
  v = await handle(dm('14695550001@c.us', 'Tricky one: 2004 f250 pats fuse'), 'acme');
  check(v === 'answered' && brain.length === 1 && brain[0].question === 'Tricky one: 2004 f250 pats fuse',
    'no room-chatter filtering in a private chat', { v, brain });

  // 3. A stranger writes to the number: silence, and a line in the log.
  reset();
  v = await handle(dm('15125550999@c.us', 'hi, how much to rekey my house?'), 'acme');
  check(v === 'not a member — silent' && sent.length === 0 && brain.length === 0,
    'non-member DM gets no reply at all and never reaches the brain', { v, sent, brain });
  check(lastRecord().channel === 'private' && lastRecord().phone === '15125550999' && /not in the group/.test(lastRecord().verdict),
    'the non-member is recorded', lastRecord());

  // 4. The operator tester, who is in the group.
  reset();
  v = await handle(dm('12145550100@c.us', 'bobot what key for a 2020 Ford Escape?'), 'acme');
  check(v === 'answered' && brain.length === 1 && brain[0].tester === true && brain[0].phone === '12145550100'
      && brain[0].channel === 'private' && brain[0].question === 'what key for a 2020 Ford Escape?',
    'tester DM is answered and still marked a tester for the brain to verify', { v, brain });

  // 5. Acknowledgements are left alone.
  for (const ack of ['ok', 'thanks', '👍', 'thank you 🙏', 'ok thanks bobot']) {
    reset();
    v = await handle(dm('14695550001@c.us', ack), 'acme');
    check(v === 'left alone - acknowledgement' && sent.length === 0 && brain.length === 0,
      `"${ack}" in a private chat is left alone`, { v, sent, brain });
  }

  // 6. Duplicate delivery and a stale backlog are still refused.
  reset();
  const again = dm('14695550001@c.us', 'what is the pin for a 2018 f150?');
  await handle(again, 'acme');
  const brainCalls = brain.length;
  v = await handle(again, 'acme');
  check(v === 'already handled' && brain.length === brainCalls, 'a retried delivery is not answered twice', { v });
  reset();
  v = await handle(dm('14695550001@c.us', 'what is the pin for a 2018 f150?', { timestamp: nowS() - 600 }), 'acme');
  check(v === 'too old to answer' && sent.length === 0 && brain.length === 0, 'a ten-minute-old private message is not answered', { v });

  // 7. The yes/no follow-up, kept per person.
  reset();
  brainReply = (body) => {
    if (body.action === 'search_online') {
      return { answer: 'Answer:\n1. Fuse 19 in the central junction box.', awaitingConfirmation: true, provisionalAnswer: 'Fuse 19 in the central junction box.', question: body.question };
    }
    if (body.action === 'confirm_worked') return { answer: 'Thanks — I sent it to Sam for approval.' };
    return { answer: "Answer:\n1. I don't have this yet.", needsPermission: true, question: body.question };
  };
  await handle(dm('14695550002@c.us', "what's the fuse for the pats ring on a 2004 f250"), 'acme');
  check(sent.length === 1 && /look it up online\? yes or no/.test(sent[0].text), 'a gap becomes a yes-or-no offer in the private chat', sent);
  sent.length = 0;
  await handle(dm('14695550001@c.us', 'yes'), 'acme');
  check(sent.length === 0 && brain.length === 1, "another member's yes, in his own private chat, does not take over Jordan's question", { sent, brain });
  sent.length = 0;
  await handle(dm('14695550002@c.us', 'yes'), 'acme');
  const search = brain.at(-1);
  check(search.action === 'search_online' && search.channel === 'private'
      && search.question === "what's the fuse for the pats ring on a 2004 f250" && search.phone === '14695550002',
    'follow-up yes in a DM searches online for the same person and question', search);
  check(sent.length === 2 && sent[0].text === 'looking it up online, give me a minute' && /did that work\? yes or no/.test(sent[1].text)
      && sent.every((m) => m.chatId === '14695550002@c.us'),
    'says it is looking, then asks "did that work?", both in the private chat', sent);
  sent.length = 0;
  // The same person, now addressed by his private id: his "yes" still finds the question.
  await handle(dm('222222222222222@lid', 'yes'), 'acme');
  check(brain.at(-1).action === 'confirm_worked' && /Fuse 19/.test(brain.at(-1).provisionalAnswer || ''),
    'the second yes confirms the answer, even when WhatsApp switches the chat to his private id', brain.at(-1));

  // 8. A private id (@lid) sender, resolved through the group roster.
  reset();
  v = await handle(dm('111111111111111@lid', 'how do I program a 2019 Camry smart key?'), 'acme');
  check(v === 'answered' && brain[0].phone === '14695550001' && sent[0].chatId === '111111111111111@lid',
    '@lid sender is resolved to his real phone and answered in the same chat', { v, brain, sent });

  // 8b. A @lid the roster does not show by private id: the phone WhatsApp sends beside it.
  reset();
  v = await handle(dm('444444444444444@lid', 'what blank for a 2012 Silverado?', { _data: { Info: { SenderAlt: '14695550002@s.whatsapp.net' } } }), 'acme');
  check(v === 'answered' && brain[0].phone === '14695550002', '@lid sender resolved from SenderAlt, then checked against the roster', { v, brain });
  reset();
  v = await handle(dm('555555555555555@lid', 'what blank for a 2012 Silverado?', { _data: { Info: { SenderAlt: '15125550999@s.whatsapp.net' } } }), 'acme');
  check(v === 'not a member — silent' && sent.length === 0 && brain.length === 0, 'a @lid stranger is still silent', { v, sent });
  reset();
  v = await handle(dm('666666666666666@lid', 'what blank for a 2012 Silverado?'), 'acme');
  check(v === 'not a member — silent' && sent.length === 0 && brain.length === 0
      && calls.some((u) => u.includes('/lids/')),
    'a @lid nobody can resolve is silent (after asking the gateway)', { v, calls });

  // 9. A picture in a private chat behaves as in the group.
  reset();
  v = await handle(dm('14695550001@c.us', 'what is this?', { hasMedia: true, media: { url: 'http://127.0.0.1:3000/api/files/x.jpg', mimetype: 'image/jpeg' } }), 'acme');
  check(v === 'answered' && brain[0].image && brain[0].image.mimeType === 'image/jpeg' && brain[0].channel === 'private',
    'a photo in a private chat reaches the brain with the image', { v, hasImage: Boolean(brain[0] && brain[0].image) });
  // (A voice note in a private chat is heard and answered since 2026-10-15 —
  // test-voice-and-video.js covers it with the same roster.)

  // 10. The owner teaching privately: quote the answer, name Bobot.
  reset();
  await handle(dm('14695550001@c.us', 'how do you drill a schlage everest?'), 'acme');
  reset();
  v = await handle(dm('14695550001@c.us', 'bobot save this as the answer', { replyTo: { body: 'Drill the top shear line at the 12 o\'clock pin, then bypass the sidebar.' } }), 'acme');
  check(brain.length === 1 && brain[0].action === 'owner_teach' && brain[0].channel === 'private'
      && brain[0].question === 'how do you drill a schlage everest?' && /shear line/.test(brain[0].provisionalAnswer),
    'a teach command works in a private chat, from that chat\'s own history', brain);

  // 11. Someone who LEAVES the group stops being answered once the roster is re-read.
  fresh();
  reset();
  v = await handle(dm('14695550001@c.us', 'what blank for a 2016 Altima?'), 'acme');
  check(v === 'answered', 'Alex is answered while he is in the group', { v });
  roster = MEMBERS.filter((m) => !/14695550001/.test(m.PhoneNumber));
  const realNow = Date.now;
  Date.now = () => realNow() + 61 * 1000;
  try {
    reset();
    v = await handle(dm('14695550001@c.us', 'what blank for a 2017 Altima?'), 'acme');
    check(v === 'not a member — silent' && sent.length === 0 && brain.length === 0,
      'a member who left the group is silent once the one-minute roster cache expires', { v, sent });
  } finally {
    Date.now = realNow;
  }
  roster = MEMBERS.slice();

  // 12. A roster that cannot be read admits nobody.
  for (const mode of ['http-error', 'throws']) {
    fresh();
    reset();
    rosterMode = mode;
    v = await handle(dm('14695550001@c.us', 'what blank for a 2016 Altima?'), 'acme');
    check(v === 'roster unreadable — silent' && sent.length === 0 && brain.length === 0,
      `roster unreadable (${mode}) fails closed: no reply, no brain`, { v, sent });
    check(/roster could not be read/.test(lastRecord().verdict) && lastRecord().channel === 'private',
      `and it is recorded (${mode})`, lastRecord());
  }
  rosterMode = 'ok';

  // 13. A number with no answering group: private chats stay silent.
  reset();
  v = await handle(dm('14695550001@c.us', 'what blank for a 2016 Altima?'), 'quiet');
  check(v === 'not a watched chat' && sent.length === 0 && brain.length === 0 && !calls.some((u) => u.includes('/groups')),
    'a session whose group is listen-only, or not bound, never answers a private chat', { v, calls });
  v = await handle(dm('14695550001@c.us', 'what blank for a 2016 Altima?'), 'sandbox');
  check(v === 'not a watched chat' && sent.length === 0, 'nor does an unbound session', { v });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fails ? `\n${fails} private-chat case(s) wrong` : '\nprivate chats answer members only');
  process.exit(fails ? 1 : 0);
})().catch((error) => {
  fs.rmSync(dir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});
