/**
 * No group ever gets more than three Bobot posts in two minutes.
 *
 * 2026-10-05 22:20 UTC: 28 job photos posted on request drew 27 replies in the
 * live Field Techs group. Six real questions in a row here must produce three
 * posts, and the other three must be held and recorded, never sent.
 * Runs the real bridge with the network stubbed, so nothing reaches a group.
 */
const path = require('path');
const sent = [];
const records = [];
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/api/sendText')) { sent.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
  if (u.includes('/groups')) return { ok: true, json: async () => ([{ JID: 'G@g.us', Participants: [{ JID: 'p@lid', PhoneNumber: '12145550000' }] }]) };
  if (u.includes('/api/whatsapp/tech-support')) return { ok: true, json: async () => ({ answer: 'Use the B111 blank.' }) };
  throw new Error(`unexpected call to ${u}`);
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
fs.appendFileSync = (p, line) => { if (String(p).includes('bridge.jsonl')) records.push(JSON.parse(line)); };
fs.writeFileSync = () => {};
const { handle } = require(path.join(__dirname, '..', 'bridge.js'));
const now = () => Math.floor(Date.now() / 1000);
(async () => {
  for (let i = 0; i < 6; i++) {
    await handle({ from: 'G@g.us', participant: 'p@lid', id: `b${i}`, timestamp: now(), body: `What is the key blank for a 20${10 + i} ford escape?`, hasMedia: false }, 's');
  }
  const held = records.filter((r) => /burst guard/.test(r.verdict || ''));
  const ok = sent.length === 3 && held.length === 3;
  console.log(`${ok ? 'PASS' : 'FAIL'}  six questions in a row: ${sent.length} posted, ${held.length} held`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
