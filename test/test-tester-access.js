/** A group operator may test Bobot without becoming a ACME technician. */
const path = require('path');
const DIR = __dirname;

let brainBody = null;
const sent = [];
global.fetch = async (url, opts) => {
  if (String(url).includes('/api/sendText')) {
    sent.push(JSON.parse(opts.body).text);
    return { ok: true, json: async () => ({}) };
  }
  if (String(url).includes('/groups')) {
    return {
      ok: true,
      json: async () => ([{
        JID: 'G@g.us',
        Participants: [{ JID: 'operator@lid', PhoneNumber: '12145550100' }],
      }]),
    };
  }
  if (String(url).includes('/api/whatsapp/tech-support')) {
    brainBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ answer: 'Answer:\n1. A real answer.' }) };
  }
  throw new Error(`unexpected call to ${url}`);
};

const fs = require('fs');
const realRead = fs.readFileSync;
fs.readFileSync = (p, ...rest) => {
  const s = String(p);
  if (s.endsWith('watched-groups.json')) {
    return JSON.stringify({
      groups: {
        'G@g.us': {
          name: 'Test',
          may_post: true,
          tenant_slug: 'acme-locks',
          tester_phones: ['12145550100'],
        },
      },
    });
  }
  if (s.endsWith('.env')) {
    return 'WAHA_API_KEY=x\nSITE_URL=https://example.invalid\nWHATSAPP_BRIDGE_SECRET=y\n';
  }
  if (s.includes('answered-ids')) return '[]';
  return realRead(p, ...rest);
};
fs.appendFileSync = () => {};
fs.writeFileSync = () => {};

const { handle } = require(path.join(DIR, '..', 'bridge.js'));

(async () => {
  const verdict = await handle({
    from: 'G@g.us',
    participant: 'operator@lid',
    id: 'tester-1',
    timestamp: Math.floor(Date.now() / 1000),
    body: 'What key blank is used for a 2020 Ford Escape?',
    hasMedia: false,
  }, 'acme');

  const ok = verdict === 'answered'
    && brainBody?.tester === true
    && brainBody?.phone === '12145550100'
    && sent.length === 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  an allowlisted group operator reaches the brain as a tester`);
  if (!ok) console.log(JSON.stringify({ verdict, brainBody, sentCount: sent.length }));
  process.exit(ok ? 0 : 1);
})();
