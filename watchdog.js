#!/usr/bin/env node
// Does a WhatsApp message still complete the round trip?
//
// April 2026: the gateway's webhook pointed at a Docker bridge address nothing
// was listening on. Every inbound message was dropped for four days. The
// container was healthy, the dashboard was green, and nothing said a word.
// "Is the container running" was never the question. This asks the real one:
// can a message leave, come back through our own webhook, and be seen?
//
// Exit 0 = the round trip completed (or there is no bound number yet and every
//          piece of plumbing under it is proven reachable)
// Exit 1 = broken — a technician's message would be dropped right now
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { webhookContainsEcho } = require('./watchdog-log');

const DIR = '/opt/waha';
const LOG = path.join(DIR, 'logs', 'webhook.jsonl');
const STATE = path.join(DIR, 'logs', 'watchdog.json');
const RECEIVER = 'http://host.docker.internal:3010';
const API = 'http://127.0.0.1:3000';

const env = Object.fromEntries(
  fs.readFileSync(path.join(DIR, '.env'), 'utf8')
    .split('\n').filter(l => l.includes('=')).map(l => {
      const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)];
    })
);
const KEY = env.WAHA_API_KEY;
const checks = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function api(pathname, options = {}) {
  const res = await fetch(API + pathname, {
    ...options,
    headers: { 'X-Api-Key': KEY, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text };
}

async function main() {
  // 1. the container is actually up
  let up = false;
  try {
    up = execSync("docker inspect -f '{{.State.Running}}' waha 2>/dev/null").toString().trim() === 'true';
  } catch (_) {}
  record('gateway container running', up);

  // 2. the API answers, and the key still works
  let version = null;
  try {
    const r = await api('/api/version');
    version = r.json; record('gateway API answering', r.status === 200, version && version.version);
  } catch (e) { record('gateway API answering', false, e.message); }

  // 3. THE APRIL CHECK: from inside the container, is anything listening where
  //    the webhook points? This is the check that did not exist in April.
  let reachable = false;
  try {
    const out = execSync(
      `docker exec waha node -e "fetch('${RECEIVER}/health').then(r=>{console.log(r.status)}).catch(()=>console.log('0'))"`,
      { timeout: 20000 }
    ).toString().trim();
    reachable = out === '200';
    record('webhook target reachable FROM INSIDE the container', reachable, `HTTP ${out}`);
  } catch (e) { record('webhook target reachable FROM INSIDE the container', false, e.message); }

  // 4. the configured webhook URL is the one we just proved reachable
  const configured = env.WHATSAPP_HOOK_URL || '';
  record('webhook URL points at the proven target', configured.startsWith(RECEIVER), configured);

  // 5. the real round trip, for every session with a number bound
  let sessions = [];
  try { const r = await api('/api/sessions?all=true'); sessions = r.json || []; } catch (_) {}
  const working = sessions.filter(s => s.status === 'WORKING' && s.me && s.me.id);
  record('sessions present', sessions.length > 0,
    sessions.map(s => `${s.name}=${s.status}`).join(', ') || 'none');

  // A session that fell over, or was stopped by nobody, means messages are not
  // flowing. "Zero must be distinguishable from deliberate idleness": a stopped
  // session is only acceptable when a human parked it here, with a reason.
  let parked = {};
  try { parked = JSON.parse(fs.readFileSync(path.join(DIR, 'sessions-parked.json'), 'utf8')).parked || {}; } catch (_) {}
  for (const name of Object.keys(parked)) {
    record(`[${name}] session still exists`, sessions.some(s => s.name === name),
      sessions.some(s => s.name === name) ? 'present' : 'GONE - a session we expect is not on the gateway at all');
  }
  for (const s of sessions) {
    if (s.status === 'FAILED') {
      record(`[${s.name}] session is not broken`, false,
        'session is FAILED - it is receiving nothing. If it was waiting to be paired, the QR timed out.');
    } else if (s.status === 'STOPPED') {
      const why = parked[s.name];
      record(`[${s.name}] stopped on purpose, not by accident`, Boolean(why),
        why || 'STOPPED and not named in sessions-parked.json - nobody recorded why, so treat it as fallen over');
    } else if (s.status === 'SCAN_QR_CODE') {
      record(`[${s.name}] waiting for a person`, true,
        'showing a QR code - nothing is wrong, but nobody has paired a phone yet');
    }
  }

  if (working.length === 0) {
    record('live message round trip', true,
      'no number bound yet — plumbing proven, nothing to send through it');
  }

  for (const s of working) {
    const nonce = 'roundtrip-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const before = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
    let sent = false;
    try {
      const r = await api('/api/sendText', {
        method: 'POST',
        body: JSON.stringify({ session: s.name, chatId: s.me.id, text: nonce })
      });
      sent = r.status >= 200 && r.status < 300;
      record(`[${s.name}] heartbeat sent to its own chat`, sent, `HTTP ${r.status}`);
    } catch (e) { record(`[${s.name}] heartbeat sent to its own chat`, false, e.message); }

    let echoed = false;
    if (sent) {
      for (let i = 0; i < 30 && !echoed; i++) {
        await sleep(2000);
        try {
          echoed = webhookContainsEcho(fs.readFileSync(LOG),before,nonce,s.name);
        } catch (_) {}
      }
    }
    record(`[${s.name}] heartbeat came BACK through our own webhook`, echoed,
      echoed ? 'round trip complete' : 'sent but never returned — inbound is being dropped');
  }

  const ok = checks.every(c => c.ok);
  const state = { at: new Date().toISOString(), epoch: Math.floor(Date.now() / 1000), ok, checks, version };
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  fs.appendFileSync(path.join(DIR, 'logs', 'watchdog.jsonl'), JSON.stringify(state) + '\n');
  if (!ok) console.error('ALARM: WhatsApp round trip is broken — a technician message would be dropped right now');
  process.exit(ok ? 0 : 1);
}

main().catch(e => {
  const state = { at: new Date().toISOString(), epoch: Math.floor(Date.now() / 1000), ok: false,
    checks: [{ name: 'watchdog ran to completion', ok: false, detail: e.message }] };
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.error('ALARM: watchdog itself failed —', e.message);
  process.exit(1);
});
