// 2026-09-22: a video answer reached the crew without its link.
const path = require('path');
const sent = [];
let reply = {};
global.fetch = async (url, opts) => {
  if (String(url).includes('/api/sendText')) { sent.push(JSON.parse(opts.body).text); return { ok: true, json: async () => ({}) }; }
  if (String(url).includes('/api/sessions')) return { ok: true, json: async () => ([{ name: 's', me: { id: '15555550100@c.us' } }]) };
  if (String(url).includes('/groups')) return { ok: true, json: async () => ([{ JID: 'G@g.us', Participants: [{ JID: 'p@lid', PhoneNumber: '12145550000' }] }]) };
  if (String(url).includes('/api/whatsapp/tech-support')) return { ok: true, json: async () => reply };
  throw new Error(`unexpected call to ${url}`);
};
const fs = require('fs');
const realRead = fs.readFileSync;
fs.readFileSync = (p, ...rest) => {
  const s = String(p);
  if (s.endsWith('watched-groups.json')) return JSON.stringify({ groups: { 'G@g.us': { name: 'Test', may_post: true, tenant_slug: 't' } } });
  if (s.endsWith('.env')) return 'WAHA_API_KEY=x\nSITE_URL=https://example.invalid\nWHATSAPP_BRIDGE_SECRET=y\n';
  if (s.includes('answered-ids') || s.includes('pending-followups')) return '[]';
  return realRead(p, ...rest);
};
fs.appendFileSync = () => {};
fs.writeFileSync = () => {};
fs.renameSync = () => {};
fs.mkdirSync = () => {};
const { handle } = require(path.join(__dirname, '..', 'bridge.js'));
const now = () => Math.floor(Date.now() / 1000);
(async () => {
  let fails = 0;
  const cases = [
    ['keeps a YouTube link', { answer: "Answer: Watch Sam's video for Rekey Schlage (1/1) — it shows the tool position and motion that text can't:", videoUrl: 'https://youtu.be/abc123' }, (t) => t.endsWith('\nhttps://youtu.be/abc123') && t.startsWith('Watch Sam')],
    ['drops a non-YouTube link', { answer: 'Answer: Watch this:', videoUrl: 'javascript:alert(1)' }, (t) => !/javascript/.test(t)],
    ['plain answer unchanged', { answer: 'Answer: hu101 is the non trans' }, (t) => t === 'hu101 is the non trans'],
  ];
  let id = 0;
  for (const [name, body, check] of cases) {
    reply = body; sent.length = 0;
    const v = await handle({ from: 'G@g.us', participant: 'p@lid', id: `v${id++}`, timestamp: now(), body: 'how do I rekey a schlage?', hasMedia: false }, 's');
    const ok = v === 'answered' && sent.length === 1 && check(sent[0]);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — got ${JSON.stringify(sent)}`}`);
    if (!ok) fails++;
  }
  process.exit(fails ? 1 : 0);
})();
