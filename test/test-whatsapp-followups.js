/**
 * A WhatsApp permission prompt must not be a dead end. A technician can reply
 * yes/no in the group, and only that same sender's fresh pending question moves
 * through the existing online-search and confirmation loop.
 */
// Each case below is a separate conversation, not a burst: lift the live per-group post cap.
process.env.BOBOT_GROUP_BURST_MAX = '1000';
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobot-followups-'));
process.env.WAHA_DIR = dir;
fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
fs.writeFileSync(path.join(dir, '.env'), 'WAHA_API_KEY=x\nSITE_URL=https://example.invalid\nWHATSAPP_BRIDGE_SECRET=y\n');
fs.writeFileSync(path.join(dir, 'watched-groups.json'), JSON.stringify({
  groups: {
    'G@g.us': {
      name: 'Test',
      may_post: true,
      tenant_slug: 'acme-locks',
      tester_phones: ['12145550100'],
    },
  },
}));
fs.writeFileSync(path.join(dir, 'logs', 'answered-ids.json'), '[]');

const sent = [];
const brainBodies = [];
let sendOk = true;
global.fetch = async (url, opts) => {
  if (String(url).includes('/api/sendText')) {
    sent.push(JSON.parse(opts.body).text);
    return { ok: sendOk, json: async () => ({}) };
  }
  if (String(url).includes('/groups')) {
    return {
      ok: true,
      json: async () => ([{
        JID: 'G@g.us',
        Participants: [
          { JID: 'tester@lid', PhoneNumber: '12145550100' },
          { JID: 'other@lid', PhoneNumber: '12145550101' },
        ],
      }]),
    };
  }
  if (String(url).includes('/api/whatsapp/tech-support')) {
    const body = JSON.parse(opts.body);
    brainBodies.push(body);
    if (body.action === 'search_online') {
      return {
        ok: true,
        json: async () => ({
          answer: 'Answer:\n1. Fuse 19 in the central junction box. Verify against the vehicle manual.',
          awaitingConfirmation: true,
          provisionalAnswer: 'Fuse 19 in the central junction box. Verify against the vehicle manual.',
          question: body.question,
        }),
      };
    }
    if (body.action === 'confirm_worked') {
      return { ok: true, json: async () => ({ answer: 'Thanks — I sent it to Sam for approval.' }) };
    }
    if (body.action === 'send_to_owner') {
      return { ok: true, json: async () => ({ answer: 'I sent this to Sam.' }) };
    }
    return {
      ok: true,
      json: async () => ({
        answer: "Answer:\n1. I don't have this in the shop knowledge yet.\n2. Want me to look it up online?",
        needsPermission: true,
        question: body.question,
      }),
    };
  }
  throw new Error(`unexpected call to ${url}`);
};

const bridgePath = require.resolve('../bridge.js');
let { handle } = require(bridgePath);
const now = () => Math.floor(Date.now() / 1000);
let id = 0;
const message = (participant, body) => ({
  from: 'G@g.us', participant, id: `m${id++}`, timestamp: now(), body, hasMedia: false,
});

(async () => {
  let fails = 0;
  const check = (ok, label) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) fails++;
  };

  sent.length = 0;
  await handle(message('tester@lid', "Bobot What's the fuse for the pats ring on a 2004 f250"), 's');
  // 2026-08-31 ("say it the way the crew says it"): no emoji menus — one plain line
  // in the crew's own words, offering the online look-up as a yes/no.
  check(sent.length === 1
      && !sent[0].startsWith('Answer:')
      && /don't have that one/i.test(sent[0])
      && /look it up online\? yes or no/i.test(sent[0]),
    'a missing answer becomes a plain yes-or-no offer to look online');
  check(brainBodies[0].question === "What's the fuse for the pats ring on a 2004 f250",
    "Bobot's name is removed before searching the shop knowledge or web");

  delete require.cache[bridgePath];
  ({ handle } = require(bridgePath));

  sent.length = 0;
  await handle(message('other@lid', 'yes'), 's');
  check(sent.length === 0 && brainBodies.length === 1,
    "another sender's yes cannot take over the tester's question");

  sent.length = 0;
  await handle(message('tester@lid', 'yes'), 's');
  const search = brainBodies.at(-1);
  check(search.action === 'search_online'
      && search.question === "What's the fuse for the pats ring on a 2004 f250"
      && search.tester === true,
    'yes searches online for the same sender and original question');
  // 2026-09-22: a search takes up to a minute, so Bobot says it is looking first.
  check(sent.length === 2 && sent[0] === 'looking it up online, give me a minute',
    'says it is looking online before the search result');
  check(!/^Answer:/m.test(sent[1] || '')
      && !/^\d+\./m.test(sent[1] || '')
      && /did that work\? yes or no/i.test(sent[1] || ''),
    'the provisional answer is plain crew-style text that ends with "did that work? yes or no"');

  sent.length = 0;
  await handle(message('tester@lid', 'yes'), 's');
  const confirm = brainBodies.at(-1);
  check(confirm.action === 'confirm_worked'
      && confirm.question === "What's the fuse for the pats ring on a 2004 f250"
      && /Fuse 19/.test(confirm.provisionalAnswer),
    'the second yes confirms the exact provisional answer');

  sent.length = 0;
  const callsBeforeNoState = brainBodies.length;
  await handle(message('tester@lid', 'yes'), 's');
  check(sent.length === 0 && brainBodies.length === callsBeforeNoState,
    'yes without a pending Bobot prompt stays ordinary group chatter');

  sent.length = 0;
  await handle(message('tester@lid', 'Bobot another question'), 's');
  await handle(message('tester@lid', 'no'), 's');
  check(brainBodies.at(-1).action === 'send_to_owner',
    'no routes the unanswered question to Sam instead of disappearing');

  sent.length = 0;
  sendOk = false;
  await handle(message('tester@lid', 'Bobot question whose prompt cannot be sent'), 's');
  const callsBeforeFailedPromptReply = brainBodies.length;
  sendOk = true;
  await handle(message('tester@lid', 'yes'), 's');
  check(brainBodies.length === callsBeforeFailedPromptReply,
    'a failed WhatsApp send does not create a pending step the technician never saw');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fails ? `\n${fails} follow-up case(s) wrong` : '\nWhatsApp follow-ups complete the learning loop');
  process.exit(fails ? 1 : 0);
})().catch((error) => {
  fs.rmSync(dir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});
