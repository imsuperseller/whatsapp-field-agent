// WAHA inbound webhook receiver + liveness beacon.
// Exists because in April 2026 the gateway's webhook pointed at a Docker bridge
// address nothing was listening on: every inbound message was dropped for four
// days and the dashboard stayed green. Nothing is allowed to be silently dropped
// here — every delivery is appended to webhook.jsonl and stamps last-event.json.
// The line records THAT a message arrived, never what it said (see watchdog-log.js):
// until 2026-10 it held every raw payload, so all chatter in every chat on the
// number was kept with no expiry.
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { webhookRecord } = require('./watchdog-log');

const DIR = process.env.WAHA_DIR || '/opt/waha';
const LOG = path.join(DIR, 'logs', 'webhook.jsonl');
const BEACON = path.join(DIR, 'logs', 'last-event.json');
const PORT = Number(process.env.WAHA_WEBHOOK_PORT || 3010);

const env = Object.fromEntries(
  fs.readFileSync(path.join(DIR, '.env'), 'utf8')
    .split('\n').filter(l => l.includes('=')).map(l => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    })
);
const HMAC_KEY = env.WHATSAPP_HOOK_HMAC_KEY || '';

function stamp(kind, extra) {
  fs.writeFileSync(BEACON, JSON.stringify({
    at: new Date().toISOString(), epoch: Math.floor(Date.now() / 1000), kind, ...extra
  }));
}

function note(entry) {
  fs.appendFileSync(path.join(DIR, 'logs', 'bridge.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

// When answering fails, the question itself is kept, so nobody's question is lost
// just because the log no longer holds message text.
function unanswered(m) {
  return { chatId: m.from || null, participant: m.participant || null, text: typeof m.body === 'string' ? m.body : '' };
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    let beacon = null;
    try { beacon = JSON.parse(fs.readFileSync(BEACON, 'utf8')); } catch (_) {}
    const ageSeconds = beacon ? Math.floor(Date.now() / 1000) - beacon.epoch : null;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, lastEvent: beacon, ageSeconds }));
  }
  if (req.method !== 'POST' || req.url !== '/waha/webhook') { res.writeHead(404); return res.end('not found'); }

  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let signatureOk = null;
    const given = req.headers['x-webhook-hmac'];
    if (HMAC_KEY && given) {
      const mine = crypto.createHmac('sha512', HMAC_KEY).update(body).digest('hex');
      signatureOk = typeof given === 'string' && /^[a-f0-9]{128}$/i.test(given) && crypto.timingSafeEqual(Buffer.from(mine, 'hex'), Buffer.from(given, 'hex'));
    }
    if (!signatureOk) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid_signature' }));
    }
    let payload = null;
    try { payload = JSON.parse(body); } catch (_) {}
    const record = webhookRecord({ at: new Date().toISOString(), url: req.url, signatureOk, payload });
    fs.appendFileSync(LOG, JSON.stringify(record) + '\n');
    stamp('webhook', { event: record.event, session: record.session, signatureOk });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ received: true }));

    // Answering happens AFTER the 200. WhatsApp retries a delivery it believes
    // failed, and a slow answer must never turn one technician question into
    // three. Its arrival was already recorded above, so a crash here can lose
    // the reply but never the evidence that the question came in.
    const inbound = payload && payload.payload;
    if (['message', 'message.any'].includes(record.event) && inbound && inbound.fromMe === false) {
      try {
        const { handle } = require(path.join(DIR, 'bridge.js'));
        handle(inbound, record.session)
          .catch((e) => note({ ...unanswered(inbound), verdict: 'bridge threw', error: String((e && e.message) || e) }));
      } catch (e) {
        note({ ...unanswered(inbound), verdict: 'bridge could not be loaded', error: String((e && e.message) || e) });
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`waha webhook receiver listening on 0.0.0.0:${server.address().port}`));
