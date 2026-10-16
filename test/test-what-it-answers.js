/**
 * Original English cases are actual Field Techs messages. Hebrew cases below
 * are fictional internal-demo regressions, never attributed to a customer.
 */
// Each case below is a separate conversation, not a burst: lift the live per-group post cap.
process.env.BOBOT_GROUP_BURST_MAX = '1000';
const path = require('path');
const DIR = __dirname;

const sent = [];
let brainCalled = 0;
global.fetch = async (url, opts) => {
  if (String(url).includes('/api/sendText')) { sent.push(JSON.parse(opts.body).text); return { ok: true, json: async () => ({}) }; }
  if (String(url).includes('/api/sessions')) return { ok: true, json: async () => ([{ name: 's', me: { id: '15555550100@c.us', lid: '100000000000002@lid' } }]) };
  if (String(url).includes('/groups')) return { ok: true, json: async () => ([{ JID: 'G@g.us', Participants: [{ JID: 'p@lid', PhoneNumber: '12145550000' }] }]) };
  if (String(url).includes('/api/whatsapp/tech-support')) { brainCalled++; return { ok: true, json: async () => ({ answer: 'Answer:\n1. A real answer.' }) }; }
  throw new Error(`unexpected call to ${url}`);
};
const fs = require('fs');
const realRead = fs.readFileSync;
fs.readFileSync = (p, ...rest) => {
  const s = String(p);
  if (s.endsWith('watched-groups.json')) return JSON.stringify({ groups: { 'G@g.us': { name: 'Test', may_post: true, tenant_slug: 't' } } });
  if (s.endsWith('.env')) return 'WAHA_API_KEY=x\nSITE_URL=https://example.invalid\nWHATSAPP_BRIDGE_SECRET=y\n';
  if (s.includes('answered-ids')) return '[]';
  return realRead(p, ...rest);
};
fs.appendFileSync = () => {};
fs.writeFileSync = () => {};

const { handle } = require(path.join(DIR, '..', 'bridge.js'));
const now = () => Math.floor(Date.now() / 1000);

const { MUST_ANSWER, MUST_IGNORE } = require('./reply-corpus.cjs');


(async () => {
  let fails = 0, id = 0;
  for (const text of MUST_ANSWER) {
    brainCalled = 0; sent.length = 0;
    const v = await handle({ from: 'G@g.us', participant: 'p@lid', id: `a${id++}`, timestamp: now(), body: text, hasMedia: false }, 's');
    // It must answer — and it must sound like the crew, not like a dashboard:
    // no name header, no "Answer:", no bullet glyphs, no list numbering on a
    // one-line answer. The full format gate is test-how-it-talks.js.
    const ok = v === 'answered'
      && brainCalled === 1
      && sent.length === 1
      && !/🔹|🔧|\*Bobot\*/.test(sent[0])
      && !/^Answer:/mi.test(sent[0])
      && !/^\d+\./m.test(sent[0])
      && sent[0].trim().length > 0;
    console.log(`${ok ? 'PASS' : 'FAIL'}  answers: "${text}"${ok ? '' : ` — got "${v}"`}`);
    if (!ok) fails++;
  }
  for (const text of MUST_IGNORE) {
    brainCalled = 0; sent.length = 0;
    const v = await handle({ from: 'G@g.us', participant: 'p@lid', id: `i${id++}`, timestamp: now(), body: text, hasMedia: false }, 's');
    const ok = v.startsWith('left alone') && sent.length === 0 && brainCalled === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ignores: "${text}"${ok ? '' : ` — got "${v}", sent ${sent.length}`}`);
    if (!ok) fails++;
  }
  console.log(fails ? `\n${fails} case(s) wrong` : '\nEnglish customer regressions and fictional Hebrew demo cases passed');
  process.exit(fails ? 1 : 0);
})();
