// Each case below is a separate conversation, not a burst: lift the live per-group post cap.
process.env.BOBOT_GROUP_BURST_MAX = '1000';
// 2026-09-22 replay: Alex asks, Bobot doesn't know, Jordan answers, Sam tells
// Bobot to log Jordan's answer. Also: the "looking it up" notice before a search.
const path = require('path');
const sent = [];
const brain = [];
let brainReply = () => ({ answer: 'Answer: ok' });
const US_LID = '100000000000002';
const roster = [
  { JID: 'alex@lid', PhoneNumber: '12145550001' },
  { JID: 'jordan@lid', PhoneNumber: '12145550002' },
  { JID: 'sam@lid', PhoneNumber: '12145550003' },
];
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/api/sendText')) { sent.push(JSON.parse(opts.body).text); return { ok: true, json: async () => ({}) }; }
  if (u.includes('/api/sessions')) return { ok: true, json: async () => ([{ name: 's', me: { id: '15555550100@c.us', lid: `${US_LID}@lid` } }]) };
  if (u.includes('/groups')) return { ok: true, json: async () => ([{ JID: 'G@g.us', Participants: roster }]) };
  if (u.includes('/api/whatsapp/tech-support')) { const b = JSON.parse(opts.body); brain.push(b); return { ok: true, json: async () => brainReply(b) }; }
  throw new Error(`unexpected call to ${url}`);
};
const fs = require('fs');
const files = new Map();
const realRead = fs.readFileSync;
fs.readFileSync = (p, ...rest) => {
  const s = String(p);
  if (s.endsWith('watched-groups.json')) return JSON.stringify({ groups: { 'G@g.us': { name: 'Test', may_post: true, tenant_slug: 't' } } });
  if (s.endsWith('.env')) return 'WAHA_API_KEY=x\nSITE_URL=https://example.invalid\nWHATSAPP_BRIDGE_SECRET=y\n';
  if (files.has(s)) return files.get(s);
  if (s.includes('/opt/waha/logs/')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return realRead(p, ...rest);
};
fs.writeFileSync = (p, data) => { files.set(String(p), String(data)); };
fs.renameSync = (a, b) => { files.set(String(b), files.get(String(a))); files.delete(String(a)); };
fs.mkdirSync = () => {};
fs.appendFileSync = () => {};
const { handle } = require(path.join(__dirname, '..', 'bridge.js'));
const now = () => Math.floor(Date.now() / 1000);
let n = 0;
const msg = (who, name, body, extra = {}) => handle({ from: 'G@g.us', participant: `${who}@lid`, id: `m${n++}`, timestamp: now(), body, hasMedia: false, _data: { Info: { PushName: name } }, ...extra }, 's');

(async () => {
  let fails = 0;
  const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`); if (!ok) fails++; };

  // 1. Alex asks; the brain doesn't know and offers a search.
  brainReply = () => ({ answer: 'x', needsPermission: true, question: 'how do I drill open a Schlage Everest?' });
  await msg('alex', 'Alex', `@${US_LID}  how do I drill open a Schlage Everest?`);
  check('question forwarded without our tag', brain[0] && brain[0].question.startsWith('how do I drill'), JSON.stringify(brain[0]));

  // 2. Alex says yes: the notice goes out BEFORE the search answer.
  sent.length = 0; brain.length = 0;
  brainReply = () => ({ answer: "I couldn't find a solid answer online either." });
  await msg('alex', 'Alex', 'Yes');
  check('says it is looking before searching', sent[0] === 'looking it up online, give me a minute' && sent.length === 2 && brain[0].action === 'search_online', JSON.stringify(sent));

  // 3. Sam asks Jordan; Jordan answers. Bobot stays out of both.
  sent.length = 0; brain.length = 0;
  await msg('sam', 'Sam Owner', '@100000000000001 tell alex how to drill a Schlage Everest');
  const jordanAnswer = 'Heres how you drill a schlage everest cylinder, you drill the top sheer line  just like you would a regular cylinder, once all top pins have been drilled and cleared, you use a blank schlage everest key matching the current keyway to bypass the secondary bottom security pin, then turn to unlock';
  await msg('jordan', 'Jordan', jordanAnswer);
  check('stays out of Sam tagging Jordan and Jordan answering', sent.length === 0 && brain.length === 0, JSON.stringify(sent));

  // 4. Sam's exact command.
  brainReply = (b) => ({ answer: `saved. next time someone asks "${b.question}" that's the answer.` });
  await msg('sam', 'Sam Owner', `@${US_LID} log Jordan’s answer as the answer to alexs question`);
  const t = brain[0] || {};
  check('owner_teach sent with Alex\'s question and Jordan\'s answer', t.action === 'owner_teach' && t.question === 'how do I drill open a Schlage Everest?' && t.provisionalAnswer === jordanAnswer && t.phone === '12145550003', JSON.stringify(t));
  check('confirms in the group', sent.length === 1 && /^saved/.test(sent[0]), JSON.stringify(sent));

  // 5. Reply-to form: quoting the answer.
  sent.length = 0; brain.length = 0;
  await msg('sam', 'Sam Owner', 'bobot save this', { replyTo: { id: 'q', participant: 'jordan@lid', body: 'Use a HPC 1200 on the Everest, pin 6' } });
  check('quoted answer is used', brain[0] && brain[0].action === 'owner_teach' && brain[0].provisionalAnswer === 'Use a HPC 1200 on the Everest, pin 6', JSON.stringify(brain[0]));

  // 6. Named someone who never answered: ask for a reply instead of guessing.
  sent.length = 0; brain.length = 0;
  await msg('sam', 'Sam Owner', 'bobot log Dakota’s answer');
  check('unknown answer: asks, never guesses', brain.length === 0 && sent.length === 1 && /couldn't tell which answer/.test(sent[0]), JSON.stringify(sent));

  process.exit(fails ? 1 : 0);
})();
