const { decideReply, decidePrivateReply, decideFollowup, followupDecision, teachCommand, resolveTeach } = require('./reply-decision.cjs');
const { readAttachment, kindOf, mimeOf } = require('./media.cjs');
// The bridge: a technician asks in their group, the assistant answers.
//
// It does NOT think. Thinking lives in one place — the same answering brain the
// customer's dashboard calls — and this only carries the question there and the
// answer back. Two brains would drift, and the drifted one is the one the
// technician would hear.
//
// It obeys /opt/waha/watched-groups.json. A group in LISTEN ONLY is recorded and
// never replied to, and that file is the only thing that can change it — never a
// flag someone remembers.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.WAHA_DIR || '/opt/waha';
const WATCHED = path.join(DIR, 'watched-groups.json');
const LOG = path.join(DIR, 'logs', 'bridge.jsonl');
const FOLLOWUPS = path.join(DIR, 'logs', 'pending-followups.json');
const FOLLOWUP_TTL_MS = 30 * 60 * 1000;
// The last few hours of each watched group, so the owner can say "log Jordan's
// answer as the answer to Alex's question" and Bobot can find both.
const RECENT = path.join(DIR, 'logs', 'recent-messages.json');
const RECENT_KEEP = 80;

function env() {
  return Object.fromEntries(
    fs.readFileSync(path.join(DIR, '.env'), 'utf8')
      .split('\n').filter((l) => l.includes('=')).map((l) => {
        const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)];
      }),
  );
}

function record(entry) {
  fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

// WHO WE ARE, asked of the gateway rather than written in a file. On 2026-08-31
// this was configured by hand as the company's main number — while
// the assistant actually posts as a different, dedicated number. A mention carries a LID, not a
// phone, so both are needed and neither is guessable. Cached for the process:
// the number behind a session does not change without a re-link.
const OUR_IDS = new Map();
async function ourIds(session, e) {
  if (OUR_IDS.has(session)) return OUR_IDS.get(session);
  try {
    const res = await fetch('http://127.0.0.1:3000/api/sessions', { headers: { 'X-Api-Key': e.WAHA_API_KEY } });
    if (!res.ok) return [];
    const me = ((await res.json()) || []).find((x) => x.name === session);
    const ids = [me && me.me && me.me.id, me && me.me && me.me.lid]
      .filter(Boolean)
      .map((x) => String(x).split('@')[0].split(':')[0]);
    if (ids.length) OUR_IDS.set(session, ids);
    return ids;
  } catch {
    return [];
  }
}

function watchedGroup(chatId) {
  try {
    return (JSON.parse(fs.readFileSync(WATCHED, 'utf8')).groups || {})[chatId] || null;
  } catch { return null; }
}

function normalizePhone(raw) {
  return String(raw || '').replace(/\D/g, '');
}

function followupKey(chatId, phone) {
  return crypto.createHash('sha256').update(`${chatId}:${normalizePhone(phone)}`).digest('hex');
}

function readFollowups() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FOLLOWUPS, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function writeFollowups(all) {
  fs.mkdirSync(path.dirname(FOLLOWUPS), { recursive: true });
  const temp = `${FOLLOWUPS}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(all));
  fs.renameSync(temp, FOLLOWUPS);
}

function pendingFollowup(chatId, phone) {
  const all = readFollowups();
  const key = followupKey(chatId, phone);
  const pending = all[key];
  if (!pending) return null;
  if (!pending.at || Date.now() - Number(pending.at) > FOLLOWUP_TTL_MS) {
    delete all[key];
    writeFollowups(all);
    return null;
  }
  return pending;
}

function rememberFollowup(chatId, phone, pending) {
  const all = readFollowups();
  all[followupKey(chatId, phone)] = { ...pending, at: Date.now() };
  writeFollowups(all);
}

function forgetFollowup(chatId, phone) {
  const all = readFollowups();
  const key = followupKey(chatId, phone);
  if (!all[key]) return;
  delete all[key];
  writeFollowups(all);
}

function readRecent() {
  try {
    const parsed = JSON.parse(fs.readFileSync(RECENT, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function rememberMessage(chatId, entry) {
  const all = readRecent();
  const list = Array.isArray(all[chatId]) ? all[chatId] : [];
  const i = list.findIndex((m) => m.id && m.id === entry.id);
  if (i >= 0) list[i] = { ...list[i], ...entry };
  else list.push(entry);
  all[chatId] = list.slice(-RECENT_KEEP);
  fs.mkdirSync(path.dirname(RECENT), { recursive: true });
  const temp = `${RECENT}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(all));
  fs.renameSync(temp, RECENT);
}

function recentMessages(chatId) {
  const list = readRecent()[chatId];
  return Array.isArray(list) ? list : [];
}

/** The question as the brain should store it: without our own @tag in front. */
function storedQuestion(question, ids) {
  let q = String(question || '').trim();
  for (const id of ids || []) q = q.replace(new RegExp(`^@${id}\\b[\\s,:—-]*`), '');
  return q.trim();
}

function isTester(group, phone) {
  return Array.isArray(group.tester_phones)
    && group.tester_phones.some((candidate) => normalizePhone(candidate) === normalizePhone(phone));
}

async function askBrain(group, phone, tester, payload, e) {
  const res = await fetch(`${e.SITE_URL}/api/whatsapp/tech-support`, {
    method: 'POST',
    headers: { 'x-bridge-secret': e.WHATSAPP_BRIDGE_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantSlug: group.tenant_slug, phone, tester, ...payload }),
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

/**
 * Say it the way the crew says it.
 *
 * The dashboard's answer contract — a leading "Answer:", numbered lines, bold
 * markdown — is a DASHBOARD contract, and wrapping it in "🔧 *Bobot*" and 🔹
 * bullets only made the wall prettier. In their own group the men write
 * "hu101 is the non trans" and "Scan the bcm codes if you can". Sam asked the
 * crew to help fine-tune the format on 2026-08-28; this is that format.
 *
 * Three things it does:
 *   - Strips the packaging: the "Answer:" token, list numbering, ** bold **,
 *     markdown headings, bullet glyphs, and our own name at the top.
 *   - Cuts the catalog boilerplate — "Source: UHS catalog", "Also found:",
 *     "Ask if you need programming instructions" — and everything from the raw
 *     shop-chat dump onward, which on 2026-08-27 put a COVID spam message and an
 *     Alarm Lock door-closer sheet into an answer about a Ford key.
 *   - Keeps a real STEP-BY-STEP PROCEDURE whole and numbered. That is the one
 *     long answer the crew liked ("he got it right 👍", 2026-08-28) — length is
 *     not the problem, packaging and catalog dumps are. Everything else is
 *     trimmed to what a technician would actually type.
 */
const CATALOG_NOISE = /^(?:source:|also found:|types? available:|ask if you need|web search found:|from the shop chat)/i;
const STEP_VERB = /^(?:insert|turn|press|close|open|remove|switch|hold|start|connect|scan|pull|cycle|repeat|within|wait|release|plug|disconnect|locks? )/i;
const PLAIN_ANSWER_CHARS = 420;

function formatWhatsAppAnswer(raw) {
  const original = String(raw || '').trim().replace(/\r/g, '');
  // Everything past this point is raw group chat or a search-result dump, never
  // an answer. Cut it before anything else looks at it.
  // "Also found:" is where a catalogue answer stops answering and starts listing
  // aftermarket alternates. Sam asked for a key blank on 2026-08-27 and got
  // four of those rows; his own tech answered him in six words.
  // The boundary may arrive numbered ("6. Also found:") or bulleted ("🔹 Also
  // found:") depending on which branch answered — verified against the live
  // route 2026-08-31, where a fixture using only the numbered form let four
  // aftermarket rows through.
  const cut = original.split(/\n[\s\d.)\-•▪️🔹*]*(?:From the shop chat|Web search found:|Also found:)/i)[0];

  const lines = cut
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({
      numbered: /^\d+[.)]\s/.test(line),
      text: line
        .replace(/^answer:\s*/i, '')
        .replace(/^\d+[.)]\s*/, '')
        .replace(/^answer:\s*/i, '')
        .replace(/^[-•▪️🔹*]+\s*/, '')
        .replace(/^#+\s*/, '')
        .replace(/\*\*/g, '')
        .trim(),
    }))
    .filter((l) => l.text && !CATALOG_NOISE.test(l.text));

  if (lines.length === 0) return original;

  const steps = lines.filter((l) => l.numbered && STEP_VERB.test(l.text)).length;
  if (steps >= 4) {
    // A procedure. Keep every line, and keep the steps numbered so a man working
    // one-handed on a truck can find his place again.
    let n = 0;
    return lines
      .map((l) => (l.numbered && STEP_VERB.test(l.text) ? `${++n}. ${l.text}` : l.text))
      .join('\n')
      .trim();
  }

  // Not a procedure — answer it the way a technician would, and stop.
  const kept = [];
  let used = 0;
  for (const l of lines) {
    if (kept.length && used + l.text.length > PLAIN_ANSWER_CHARS) break;
    kept.push(l.text);
    used += l.text.length;
  }
  return kept.join('\n').trim();
}

/**
 * True when a permission reply from the brain says the shop HAS material — it
 * was withheld, not missing. The brain flags it (`withheld`); the wording is
 * checked too, so an older brain that sends only the sentence is still read
 * correctly. Only the brain's own "don't have this ... look it up online?"
 * message earns the online offer.
 */
function brainFoundMaterial(body, answer) {
  if (body.withheld === true) return true;
  if (body.withheld === false) return false;
  return /\bI do have something on this\b/i.test(String(answer || ''));
}

/**
 * The brain's sentence, said the way the crew types: no "Answer:", no bullets,
 * one line, lower-case starts. "I do have something on this in the shop
 * knowledge, but not an answer I can give you here. Ask Sam." becomes
 * "i do have something on this in the shop knowledge, but not an answer i can
 * give you here. ask Sam."
 */
function crewVoice(raw) {
  return formatWhatsAppAnswer(raw)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/(^|[.!?]\s+)([A-Z])(?![A-Z])/g, (_, lead, c) => lead + c.toLowerCase())
    .replace(/\bI\b/g, 'i')
    .trim();
}

// `channel` is set only for a private chat, so a group's records are unchanged.
// `followupChat` is where the pending yes/no lives; a group keys it by the group,
// a private chat by the person (see handlePrivate).
async function deliverBrainResponse({ res, body, session, chatId, group, phone, text, e, channel = null, followupChat = chatId }) {
  const where = channel ? { chatId, group: group.name, channel } : { chatId, group: group.name };
  if (!res.ok) {
    record({ ...where, phone, text, verdict: `not answered (HTTP ${res.status})`, detail: body.detail || body.error });
    return `not answered (HTTP ${res.status})`;
  }
  const answer = String(body.answer || '').trim();
  if (!answer) {
    record({ ...where, phone, text, verdict: 'the brain returned nothing' });
    return 'the brain returned nothing';
  }

  let outgoing = formatWhatsAppAnswer(answer);
  // A VIDEO ANSWER CARRIES ITS LINK SEPARATELY. The brain returns the owner's
  // video as `videoUrl` beside a one-line orientation ending in a colon. Only
  // `answer` was forwarded, so on 2026-09-22 the crew got "Watch Sam's video
  // for Rekey Schlage (1/1) — it shows the tool position…:" and no link.
  const videoUrl = /^https:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//i.test(String(body.videoUrl || ''))
    ? String(body.videoUrl).trim() : '';
  if (videoUrl) outgoing = `${outgoing}\n${videoUrl}`;
  let nextFollowup = null;
  if (body.needsPermission === true && brainFoundMaterial(body, answer)) {
    // THE BRAIN HAS MATERIAL AND HELD THE ANSWER BACK. Until 2026-09-23 every
    // permission reply was replaced with "don't have that one in the shop
    // knowledge" — so when the brain said "I do have something on this, ask
    // Sam", the crew was told the opposite. Pass on what the brain said, in
    // the crew's voice, and do not offer a web search it did not offer.
    outgoing = crewVoice(answer);
  } else if (body.needsPermission === true) {
    nextFollowup = {
      kind: 'permission',
      question: String(body.question || text).trim(),
    };
    // The dashboard has buttons. WhatsApp does not. Give the technician a plain
    // next move instead of exposing the dashboard's numbered button prompt.
    outgoing = "don't have that one in the shop knowledge. want me to look it up online? yes or no";
  } else if (body.awaitingConfirmation === true && body.provisionalAnswer) {
    nextFollowup = {
      kind: 'confirmation',
      question: String(body.question || text).trim(),
      provisionalAnswer: String(body.provisionalAnswer),
    };
    outgoing = `${formatWhatsAppAnswer(answer)}\n\ndid that work? yes or no`;
  }

  const sent = await reply(session, chatId, outgoing, e);
  // Change the pending step only after the technician actually receives the
  // message. If WhatsApp rejects the send, keep the prior step so a retry can
  // continue rather than advancing a conversation nobody saw.
  if (sent) {
    if (nextFollowup) rememberFollowup(followupChat, phone, nextFollowup);
    else forgetFollowup(followupChat, phone);
  }
  record({ ...where, phone, text, verdict: sent ? 'answered' : 'answer produced but SEND FAILED', escalate: body.escalate === true });
  return sent ? 'answered' : 'answer produced but SEND FAILED';
}

/**
 * What a technician attached, made readable: a photo as bytes, a voice note as
 * its transcript, a video as three stills plus what was said in it. Shared by
 * the group and private-chat paths so an attachment is treated the same in
 * both. `extra` adds fields to the record (the private path marks its channel).
 *
 * Until 2026-10-15 anything that was not a photo got "I can only look at
 * photos" — posted into the live group even when the voice note was one
 * technician talking to another. The reading itself lives in media.cjs; the
 * transcription is done by the brain's door, which checks the sender is a
 * technician of the tenant before a minute of speech is paid for.
 *
 * Returns { kind, imagePart?, transcript?, seconds? } when there is something
 * for the brain, or { result } after telling the sender what went wrong (in a
 * group only when the group may be posted in — a listening group is silent).
 */
const CANNOT_READ = {
  image: "I couldn't open that picture. Send it again, or tell me what you're looking at and I'll answer.",
  audio: "I couldn't make out that voice note. Send it again, or type it, and I'll answer.",
  video: "I couldn't open that video. Send it again, or send a photo and tell me what's going on, and I'll answer.",
  other: "I can read photos, voice notes and videos. Send one of those, or type it, and I'll answer.",
};

async function readMedia({ media, session, chatId, group, phone, tester, text, e, extra = {}, quiet = false }) {
  const kind = kindOf(mimeOf(media));
  const say = async (verdict, line, detail = {}) => {
    if (quiet || !group.may_post) {
      record({ chatId, group: group.name, ...extra, text, kind, verdict: `${verdict} — ${quiet ? 'left alone' : 'listening only'}`, ...detail });
      return;
    }
    const sent = await reply(session, chatId, line, e);
    record({ chatId, group: group.name, ...extra, text, kind, verdict: `${verdict} — ${sent ? 'said so' : 'SEND FAILED'}`, ...detail });
  };

  if (kind === 'other') {
    await say('not a photo, voice note or video', CANNOT_READ.other, { mime: mimeOf(media) || null });
    return { kind, result: 'media not readable' };
  }

  let read;
  try {
    read = await readAttachment(media, e.WAHA_API_KEY);
  } catch (err) {
    // NEVER fall through to answering the caption alone: that is answering a
    // photo nobody looked at, which is the whole reason this exists.
    await say(`${kind} could not be read`, CANNOT_READ[kind], { error: String((err && err.message) || err) });
    return { kind, result: kind === 'image' ? 'picture unavailable' : `${kind} unavailable` };
  }
  if (kind === 'image') return { kind, imagePart: read.imagePart };

  // Speech is transcribed by the door, under the tenant's own daily cap.
  let transcript = '';
  if (read.speech) {
    const { res, body } = await askBrain(group, phone, tester, {
      action: 'transcribe', audio: read.speech, seconds: read.seconds || null, ...(extra.channel ? { channel: extra.channel } : {}),
    }, e);
    if (!res.ok) {
      const why = body && body.error ? String(body.error) : `door answered ${res.status}`;
      if (kind === 'audio') {
        const line = why === 'transcription_cap'
          ? "I've hit my voice-note limit for today. Type it and I'll answer."
          : why === 'transcription_not_configured'
            ? "I can't hear voice notes for this shop yet. Type it and I'll answer."
            : CANNOT_READ.audio;
        await say(`voice note not transcribed (${why})`, line);
        return { kind, result: 'voice note unavailable' };
      }
      // A video still has its pictures; the brain reads those without the words.
      record({ chatId, group: group.name, ...extra, text, kind, verdict: `video speech not transcribed (${why}) — pictures only` });
    } else {
      transcript = String(body.transcript || '').trim();
    }
  }
  if (kind === 'audio' && !transcript) {
    await say('voice note had no words in it', CANNOT_READ.audio);
    return { kind, result: 'voice note unavailable' };
  }
  return { kind, imagePart: read.imagePart || null, transcript, seconds: read.seconds || null, truncated: Boolean(read.truncated) };
}

/**
 * The question the brain gets for a video: the caption, plus what was said in
 * the clip, so the pictures and the words arrive together.
 */
function questionWithTranscript(question, transcript) {
  const said = String(transcript || '').trim().slice(0, 700);
  const asked = String(question || '').trim() || 'What is this, and what do I need for it?';
  if (!said) return asked;
  return `${asked}\n\nThe technician sent a video. The pictures are frames from it, and in it they say: "${said}"`;
}

/** The real phone behind a sender's private id, from the live group roster. */
async function senderPhone(session, chatId, participant, e) {
  const res = await fetch(`http://127.0.0.1:3000/api/${session}/groups?limit=200`, {
    headers: { 'X-Api-Key': e.WAHA_API_KEY },
  });
  if (!res.ok) return null;
  const groups = await res.json();
  const g = (groups || []).find((x) => x.JID === chatId);
  if (!g) return null;
  const p = (g.Participants || []).find((x) => x.JID === participant);
  return p && p.PhoneNumber ? String(p.PhoneNumber).split('@')[0] : null;
}

// A BURST IN A GROUP IS ALWAYS A MISTAKE. 2026-10-05 22:20 UTC Bobot posted 17
// replies in nine seconds to the live Field Techs group, then 10 more at 22:34.
// Whatever the cause, no more than BURST_MAX posts reach one group per window;
// the rest are held and recorded, never sent.
const BURST_MAX = Number(process.env.BOBOT_GROUP_BURST_MAX || 3);
const BURST_WINDOW_MS = 120000;
const groupPosts = new Map();
function burstHeld(chatId) {
  if (!/@g\.us$/.test(String(chatId))) return false;
  const now = Date.now();
  const recent = (groupPosts.get(chatId) || []).filter((t) => now - t < BURST_WINDOW_MS);
  if (recent.length >= BURST_MAX) { groupPosts.set(chatId, recent); return true; }
  recent.push(now);
  groupPosts.set(chatId, recent);
  return false;
}

async function reply(session, chatId, text, e) {
  if (burstHeld(chatId)) {
    record({ chatId, verdict: `held - burst guard (${BURST_MAX} posts in ${BURST_WINDOW_MS / 60000} minutes already)`, chars: String(text || '').length });
    return false;
  }
  const res = await fetch('http://127.0.0.1:3000/api/sendText', {
    method: 'POST',
    headers: { 'X-Api-Key': e.WAHA_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, chatId, text }),
  });
  return res.ok;
}

/**
 * Handle one inbound WhatsApp message. Returns a short verdict string; every
 * path is recorded, including the ones that do nothing, so a silent day can
 * always be told apart from a broken one.
 */
// Message ids already answered. WhatsApp's gateway RETRIES a webhook it thinks
// failed — and the receiver is down for two seconds every time it restarts. On
// 2026-08-27 that turned one technician question into three replies inside three
// seconds, in a live group of sixteen people. A retry is the same question, not
// a new one.
const ANSWERED = path.join(DIR, 'logs', 'answered-ids.json');
function alreadyHandled(id) {
  if (!id) return false;
  let seen = [];
  try { seen = JSON.parse(fs.readFileSync(ANSWERED, 'utf8')); } catch (_) {}
  if (seen.includes(id)) return true;
  seen.push(id);
  fs.writeFileSync(ANSWERED, JSON.stringify(seen.slice(-500)));
  return false;
}

// ─── PRIVATE CHATS WITH BOBOT (2026-09-23) ────────────────────────────────────
// Sam approved his technicians, himself and the office messaging Bobot one to
// one, on the same number that sits in "Field Techs". His standing rule still
// holds: the group IS the access list. So a private chat is answered only when
// the sender is, right now, a member of a group Bobot answers in on this same
// WhatsApp number. Anyone else gets silence — never a "who are you?" — because
// replying to strangers is how a number gets reported and banned. Every private
// message is still written down, so a silent one can be told from a broken one.

// How long a read of the live group roster is trusted. Someone removed from the
// group stops being answered within this long.
const ROSTER_TTL_MS = 60 * 1000;
const ROSTERS = new Map();

/** A one-to-one chat id: a phone (`@c.us`, `@s.whatsapp.net`) or a private id (`@lid`). */
function isPrivateChatId(chatId) {
  return /@(?:c\.us|s\.whatsapp\.net|lid)$/.test(String(chatId || ''));
}

/** "12145550100:12@s.whatsapp.net" -> "12145550100". */
function idUser(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

/**
 * The groups on this WhatsApp number that Bobot may answer in. A group counts
 * only when watched-groups.json binds it to THIS session by name — a private
 * chat has no group id to check, so the binding must be explicit.
 */
function answeringGroupsFor(session) {
  try {
    const all = JSON.parse(fs.readFileSync(WATCHED, 'utf8')).groups || {};
    return Object.entries(all)
      .filter(([id, g]) => /@g\.us$/.test(id) && g && g.may_post === true && g.session === session)
      .map(([id, g]) => ({ chatId: id, group: g }));
  } catch { return []; }
}

/**
 * The live roster of every group this number is in, cached briefly. Returns
 * null when it cannot be read — and null means nobody is admitted.
 */
async function liveRoster(session, e) {
  const hit = ROSTERS.get(session);
  if (hit && Date.now() - hit.at < ROSTER_TTL_MS) return hit.groups;
  try {
    const res = await fetch(`http://127.0.0.1:3000/api/${session}/groups?limit=200`, {
      headers: { 'X-Api-Key': e.WAHA_API_KEY },
    });
    if (!res.ok) return null;
    const groups = await res.json();
    if (!Array.isArray(groups)) return null;
    ROSTERS.set(session, { at: Date.now(), groups });
    return groups;
  } catch { return null; }
}

/** A roster participant's phone, digits only, or null when the roster hides it. */
function participantPhone(p) {
  if (p && p.PhoneNumber) return normalizePhone(idUser(p.PhoneNumber)) || null;
  if (p && p.JID && !/@lid$/.test(String(p.JID))) return normalizePhone(idUser(p.JID)) || null;
  return null;
}

/**
 * The real phone behind a private chat. A `@c.us` chat carries it. A `@lid`
 * chat does not, so, in order: the sender's own entry in the group roster (the
 * roster lists members by the same private id), the phone WhatsApp sends beside
 * the private id (`_data.Info.SenderAlt`), and last the gateway's own lookup.
 */
async function privateSenderPhone(payload, session, participants, e) {
  const from = String(payload.from || '');
  if (!/@lid$/.test(from)) return normalizePhone(idUser(from)) || null;
  const lid = idUser(from);
  const mine = participants.find((p) => p && [p.JID, p.LID].some((j) => j && /@lid$/.test(String(j)) && idUser(j) === lid));
  const fromRoster = mine ? participantPhone(mine) : null;
  if (fromRoster) return fromRoster;
  const info = (payload._data && payload._data.Info) || {};
  for (const alt of [info.SenderAlt, info.Sender, info.Chat]) {
    if (alt && /@(?:s\.whatsapp\.net|c\.us)$/.test(String(alt))) return normalizePhone(idUser(alt)) || null;
  }
  try {
    const res = await fetch(`http://127.0.0.1:3000/api/${session}/lids/${encodeURIComponent(from)}`, {
      headers: { 'X-Api-Key': e.WAHA_API_KEY },
    });
    if (res.ok) {
      const found = await res.json();
      if (found && found.pn) return normalizePhone(idUser(found.pn)) || null;
    }
  } catch (_) { /* unresolved: the sender stays unknown */ }
  return null;
}

/**
 * Who is this, and may Bobot answer them? Admitted only as a CURRENT member of
 * an answering group on this number. A tester (the server-only allowlist the
 * group path uses) is admitted the same way the group path admits him: he must
 * be on the roster, and is then marked a tester so the brain checks its own
 * private allowlist before answering.
 */
async function admitPrivateSender(payload, session, candidates, e) {
  const roster = await liveRoster(session, e);
  if (!roster) return { result: 'roster unreadable — silent', verdict: 'group roster could not be read — not answered' };
  const live = candidates
    .map((c) => ({ ...c, live: roster.find((g) => g && g.JID === c.chatId) }))
    .filter((c) => c.live);
  if (!live.length) return { result: 'roster unreadable — silent', verdict: 'answering group missing from the roster — not answered' };
  const participants = live.flatMap((c) => c.live.Participants || []);
  const phone = await privateSenderPhone(payload, session, participants, e);
  if (!phone) return { result: 'not a member — silent', verdict: 'private chat from a sender whose phone is unknown — not answered' };
  const memberOf = live.filter((c) => (c.live.Participants || []).some((p) => participantPhone(p) === phone));
  if (!memberOf.length) return { phone, result: 'not a member — silent', verdict: 'private chat from someone not in the group — not answered' };
  if (new Set(memberOf.map((c) => c.group.tenant_slug)).size > 1) {
    return { phone, result: 'ambiguous tenant — silent', verdict: 'member of groups for more than one customer on this number — not answered' };
  }
  const chosen = memberOf.find((c) => isTester(c.group, phone)) || memberOf[0];
  return { phone, group: chosen.group, tester: isTester(chosen.group, phone) };
}

async function handlePrivate(payload, session) {
  const chatId = payload.from;
  const channel = 'private';
  let text = (payload.body || '').trim();
  const candidates = answeringGroupsFor(session);
  if (!candidates.length) {
    record({ chatId, channel, verdict: 'private chat on a number with no answering group — not answered', chars: text.length });
    return 'not a watched chat';
  }

  if (alreadyHandled(payload.id)) {
    record({ chatId, channel, verdict: 'already handled - a retried delivery, not a new question', id: payload.id });
    return 'already handled';
  }
  const ageSeconds = payload.timestamp ? Math.floor(Date.now() / 1000) - Number(payload.timestamp) : 0;
  if (ageSeconds > 180) {
    record({ chatId, channel, verdict: `too old to answer (${ageSeconds}s)`, text: text.slice(0, 120) });
    return 'too old to answer';
  }

  const e = env();
  const who = await admitPrivateSender(payload, session, candidates, e);
  if (!who.group) {
    record({ chatId, channel, phone: who.phone || null, verdict: who.verdict, chars: text.length });
    return who.result;
  }
  const { group, phone, tester } = who;
  const where = { chatId, group: group.name, channel };
  // Pending yes/no and recent messages are kept per PERSON on this number, not
  // per chat id: WhatsApp may address the same private chat by phone one day
  // and by private id the next, and a "yes" must still find its question.
  const personal = `private:${session}:${phone}`;

  const media = payload.media && payload.media.url ? payload.media : null;
  const attached = payload.hasMedia === true || Boolean(media) ? kindOf(mimeOf(media)) : null;
  // A photo or a video is itself the question; a voice note is a spoken one.
  const isPicture = Boolean(attached) && attached !== 'audio';
  const senderName = String((payload._data && payload._data.Info && payload._data.Info.PushName) || payload.notifyName || '').trim();
  const quoted = String((payload.replyTo && payload.replyTo.body) || '').trim();
  const remember = (entry) => { try { rememberMessage(personal, entry); } catch (_) {} };

  // A VOICE NOTE IS A SPOKEN MESSAGE. Hear it first; from here on its words are
  // handled exactly as if he had typed them — a spoken "yes" answers a pending
  // question, a spoken request is a request.
  let transcript = '';
  if (attached === 'audio') {
    const heard = await readMedia({ media, session, chatId, group, phone, tester, text, e, extra: { channel } });
    if (!heard.transcript) return heard.result;
    text = heard.transcript;
    remember({ id: payload.id || null, at: Date.now(), participant: chatId, name: senderName, text: `🎤 ${text.slice(0, 2000)}`, asked: null });
  } else if (text) {
    remember({ id: payload.id || null, at: Date.now(), participant: chatId, name: senderName, text: text.slice(0, 2000), asked: null });
  }

  // A yes/no answering Bobot's own "look it up online?" or "did that work?".
  const decision = followupDecision(text);
  if (!isPicture && decision) {
    const pending = pendingFollowup(personal, phone);
    if (pending) {
      const payloadForBrain = { ...decideFollowup(text, pending), channel };
      if (payloadForBrain.action === 'search_online') {
        await reply(session, chatId, 'looking it up online, give me a minute', e);
      }
      const { res, body } = await askBrain(group, phone, tester, payloadForBrain, e);
      return deliverBrainResponse({ res, body, session, chatId, group, phone, text, e, channel, followupChat: personal });
    }
  }

  let imagePart = null;
  if (isPicture) {
    // A photo: its bytes. A video: three stills and what was said in it. In a
    // private chat the sender is already admitted, so the read happens here.
    const read = await readMedia({ media, session, chatId, group, phone, tester, text, e, extra: { channel } });
    if (!read.imagePart) return read.result;
    imagePart = read.imagePart;
    transcript = read.transcript || '';
  }

  if (!imagePart && text.length < 2) {
    record({ ...where, phone, verdict: 'nothing to answer — empty message, no media' });
    return 'nothing to answer';
  }

  // The owner teaching, exactly as in the group: the message must name Bobot.
  // In a private chat the question and the answer are looked up in this chat.
  const idsForUs = await ourIds(session, e);
  const teach = !imagePart && teachCommand({ text, ourIds: idsForUs, quoted });
  if (teach) {
    const found = resolveTeach(teach, recentMessages(personal).filter((m) => !payload.id || m.id !== payload.id), { quoted });
    if (!found.answer || !found.question) {
      const missing = !found.answer ? 'which answer' : 'which question';
      const said = `couldn't tell ${missing} you mean. reply to the answer message and write "bobot save this as the answer to <name>'s question"`;
      const sentHelp = await reply(session, chatId, said, e);
      record({ ...where, phone, text, verdict: sentHelp ? `teach command — could not find ${missing}` : 'teach command — help SEND FAILED' });
      return 'teach command unresolved';
    }
    const { res, body } = await askBrain(group, phone, tester, { question: found.question, action: 'owner_teach', provisionalAnswer: found.answer, channel }, e);
    return deliverBrainResponse({ res, body, session, chatId, group, phone, text, e, channel, followupChat: personal });
  }

  // Everything said here is said to Bobot — except a plain "ok" or "thanks".
  const privateDecision = decidePrivateReply({ text, hasMedia: Boolean(imagePart) });
  if (privateDecision.action === 'ignore') {
    record({ ...where, phone, chars: text.length, verdict: privateDecision.verdict });
    return privateDecision.result;
  }

  const question = storedQuestion(privateDecision.question, idsForUs);
  if (!imagePart) remember({ id: payload.id || null, at: Date.now(), participant: chatId, name: senderName, text: text.slice(0, 2000), asked: question });
  const { res, body } = await askBrain(
    group,
    phone,
    tester,
    imagePart
      ? { question: transcript ? questionWithTranscript(question, transcript) : question, image: imagePart, channel }
      : { question: question || privateDecision.question, channel },
    e,
  );
  return deliverBrainResponse({ res, body, session, chatId, group, phone, text, e, channel, followupChat: personal });
}

async function handle(payload, session) {
  const chatId = payload.from;
  if (isPrivateChatId(chatId)) return handlePrivate(payload, session);
  const group = watchedGroup(chatId);
  if (!group) return 'not a watched chat';
  if (group.session && group.session !== session) return 'wrong gateway session';

  if (alreadyHandled(payload.id)) {
    record({ chatId, group: group.name, verdict: 'already handled - a retried delivery, not a new question', id: payload.id });
    return 'already handled';
  }

  // A backlog is not a conversation. After any downtime the gateway delivers
  // what it held; answering a question asked twenty minutes ago, in a group that
  // has moved on, is noise at best.
  const ageSeconds = payload.timestamp ? Math.floor(Date.now() / 1000) - Number(payload.timestamp) : 0;
  if (ageSeconds > 180) {
    record({ chatId, group: group.name, verdict: `too old to answer (${ageSeconds}s) - the group has moved on`, text: (payload.body || '').slice(0, 120) });
    return 'too old to answer';
  }

  let text = (payload.body || '').trim();
  const media = payload.media && payload.media.url ? payload.media : null;
  const attached = payload.hasMedia === true || Boolean(media) ? kindOf(mimeOf(media)) : null;
  // A photo or a video is itself the question; a voice note is a spoken one.
  const isPicture = Boolean(attached) && attached !== 'audio';
  const senderName = String((payload._data && payload._data.Info && payload._data.Info.PushName) || payload.notifyName || '').trim();
  const quoted = String((payload.replyTo && payload.replyTo.body) || '').trim();
  // Memory must never block an answer.
  const remember = (entry) => { try { rememberMessage(chatId, entry); } catch (_) {} };

  // A VOICE NOTE IS A SPOKEN MESSAGE. The crew talk to each other in voice
  // notes all day, so one is heard and then judged by the same rules as a typed
  // line: chatter is left alone, a question is answered. Nothing is spent on a
  // listening-only group or on a sender who is not on the roster, and when a
  // voice note cannot be read the group hears nothing about it — it was most
  // likely never meant for Bobot.
  let transcript = '';
  if (attached === 'audio') {
    const e = env();
    if (!group.may_post) {
      record({ chatId, group: group.name, verdict: 'voice note — listening only', why: group.why });
      return 'listening — not answered';
    }
    const phone = await senderPhone(session, chatId, payload.participant, e);
    if (!phone) {
      record({ chatId, group: group.name, verdict: 'voice note from a sender not on the roster', participant: payload.participant });
      return 'sender not on the roster';
    }
    const heard = await readMedia({ media, session, chatId, group, phone, tester: isTester(group, phone), text, e, quiet: true });
    if (!heard.transcript) return heard.result;
    text = heard.transcript;
    remember({ id: payload.id || null, at: Date.now(), participant: payload.participant || null, name: senderName, text: `🎤 ${text.slice(0, 2000)}`, asked: null });
  } else if (text) {
    remember({ id: payload.id || null, at: Date.now(), participant: payload.participant || null, name: senderName, text: text.slice(0, 2000), asked: null });
  }

  // A plain yes/no is ordinary group chatter UNLESS this same sender has a fresh
  // Bobot prompt waiting. Without this state, Bobot asked "look online?" and then
  // silently ignored the technician's answer because acknowledgements are
  // normally (correctly) left alone in a busy group.
  const decision = followupDecision(text);
  if (!isPicture && decision) {
    const e = env();
    const phone = await senderPhone(session, chatId, payload.participant, e);
    const pending = phone ? pendingFollowup(chatId, phone) : null;
    if (phone && pending) {
      if (!group.may_post) {
        record({ chatId, group: group.name, phone, text, verdict: 'follow-up heard — listening only', why: group.why });
        return 'listening — not answered';
      }
      const tester = isTester(group, phone);
      const payloadForBrain = decideFollowup(text, pending);
      // A web search takes up to a minute. Say so, or the man on the truck
      // thinks the "yes" went nowhere.
      if (payloadForBrain.action === 'search_online') {
        await reply(session, chatId, 'looking it up online, give me a minute', e);
      }
      const { res, body } = await askBrain(group, phone, tester, payloadForBrain, e);
      return deliverBrainResponse({ res, body, session, chatId, group, phone, text, e });
    }
  }

  // A PICTURE. On 2026-08-28 Sam told the whole crew: "randomly upload pictures
  // of hardware you run into and ask what it is". Nothing here can see a picture
  // — only `body` is forwarded, which for an image is the caption or nothing at
  // all. That left two bad outcomes and no good one: a photo with a caption got
  // a confident answer about an image the assistant never looked at, and a photo
  // without one was dropped in silence.
  //
  // So it says so. A man who is told "I can't see pictures yet" asks again in
  // words; a man who is answered wrongly about a lock he is holding loses trust
  // in the whole thing, and a man ignored stops asking.
  let imagePart = null;
  if (attached === 'image') {
    const read = await readMedia({ media, session, chatId, group, text, e: env() });
    if (!read.imagePart) return read.result;
    imagePart = read.imagePart;
  } else if (attached === 'other') {
    // A document, a sticker, a contact card. Said to be unreadable only when the
    // caption asks us something; a file the room shared with itself is left
    // alone, because "I can only read…" posted under every PDF is noise.
    const e = env();
    const aimed = decideReply({ text, hasMedia: true, ourIds: await ourIds(session, e) }).action === 'ask';
    if (!aimed) {
      record({ chatId, group: group.name, kind: attached, mime: mimeOf(media) || null, chars: text.length, verdict: 'a file type Bobot cannot read, not aimed at us — left alone' });
      return 'left alone - unreadable file not aimed at us';
    }
    return (await readMedia({ media, session, chatId, group, text, e })).result;
  }
  // A VIDEO is read only once the room's rules say it is a question for us and
  // the sender is on the roster: the stills and the transcription cost real
  // work, and a clip the room shared with itself gets none of it.

  // A PICTURE IS ITSELF THE QUESTION. Everything below this line judges words —
  // is it an acknowledgement, is it aimed at the room, is it long enough to be a
  // request — and none of that applies to a man holding up a lock. A photo
  // arrives with a caption, or with nothing at all, and both mean "what is this".
  if (!imagePart && attached !== 'video' && text.length < 2) {
    // Recorded rather than returned in silence: an empty body that is not media
    // is something this bridge does not understand yet, and a silent drop is the
    // failure this house keeps being bitten by.
    record({ chatId, group: group.name, verdict: 'nothing to answer — empty message, no media' });
    return 'nothing to answer';
  }

  // Answer QUESTIONS, not conversation. Their group runs on image dumps, "Ok",
  // "Yes sir" and the odd salute emoji — an assistant that replied to every line
  // would be muted within a day. Sam asked for it to answer his technicians'
  // questions, and this is what a question looks like in their own words: a
  // question mark, or an opening the trade actually uses.
  //
  // FIRST VERSION WAS TOO NARROW AND, WORSE, SILENT. Sam wrote "I just need the
  // metal key blank" — plainly a request, correcting the answer he had just been
  // given — and it was dropped for not starting with a question word AND never
  // written down. A silent drop is the exact failure this whole house was built
  // to prevent. So: the rule is now "is this an acknowledgement or someone
  // answering a mate", not "does this look like a question", and EVERY decision
  // is recorded before returning.
  // THE OWNER TEACHING FROM THE GROUP — see teachCommand. Found here, before the
  // question rules, because "log Jordan's answer" would otherwise be sent to the
  // brain as a technical question and refused.
  const idsForUs = await ourIds(session, env());
  const teach = !imagePart && teachCommand({ text, ourIds: idsForUs, quoted });
  if (teach) {
    const e = env();
    const phone = await senderPhone(session, chatId, payload.participant, e);
    if (!phone) {
      record({ chatId, group: group.name, verdict: 'teach command from a sender not on the roster', participant: payload.participant, chars: text.length });
      return 'sender not on the roster';
    }
    if (!group.may_post) {
      record({ chatId, group: group.name, phone, text, verdict: 'teach command heard — listening only' });
      return 'listening — not answered';
    }
    const found = resolveTeach(teach, recentMessages(chatId).filter((m) => !payload.id || m.id !== payload.id), { quoted });
    if (!found.answer || !found.question) {
      const missing = !found.answer ? 'which answer' : 'which question';
      const said = `couldn't tell ${missing} you mean. reply to the answer message and write "bobot save this as the answer to <name>'s question"`;
      const sentHelp = await reply(session, chatId, said, e);
      record({ chatId, group: group.name, phone, text, verdict: sentHelp ? `teach command — could not find ${missing}` : 'teach command — help SEND FAILED' });
      return 'teach command unresolved';
    }
    const tester = isTester(group, phone);
    const { res, body } = await askBrain(group, phone, tester, { question: found.question, action: 'owner_teach', provisionalAnswer: found.answer }, e);
    return deliverBrainResponse({ res, body, session, chatId, group, phone, text, e });
  }

  const replyDecision = decideReply({ text, hasMedia: Boolean(imagePart) || attached === 'video', ourIds: idsForUs });
  if (replyDecision.action === 'ignore') {
    record({ chatId, group: group.name, chars: text.length, verdict: replyDecision.verdict });
    return replyDecision.result;
  }

  const e = env();
  const phone = await senderPhone(session, chatId, payload.participant, e);
  if (!phone) {
    record({ chatId, group: group.name, verdict: 'sender not on the roster', participant: payload.participant, chars: text.length });
    return 'sender not on the roster';
  }
  // Operators may test in the real room without becoming customer technicians.
  // The raw-number allowlist stays in the server-only watched-groups config; no
  // personal number belongs in source control. The web door independently checks
  // a private tenant+phone hash before accepting this tester assertion.
  const tester = isTester(group, phone);

  if (!group.may_post) {
    // LISTENING. The question is written down with who asked it, because this is
    // the whole point of listening: the real list of what the library cannot answer.
    record({ chatId, group: group.name, phone, text, verdict: 'listening — not answered', why: group.why });
    return 'listening — not answered';
  }

  if (attached === 'video') {
    const clip = await readMedia({ media, session, chatId, group, phone, tester, text, e });
    if (!clip.imagePart) return clip.result;
    imagePart = clip.imagePart;
    transcript = clip.transcript || '';
  }

  if (!imagePart) remember({ id: payload.id || null, at: Date.now(), participant: payload.participant || null, name: senderName, text: text.slice(0, 2000), asked: storedQuestion(replyDecision.question, idsForUs) });
  const asked = storedQuestion(replyDecision.question, idsForUs);
  const { res, body } = await askBrain(
    group,
    phone,
    tester,
    imagePart
      ? { question: transcript ? questionWithTranscript(asked, transcript) : asked, image: imagePart }
      : { question: asked || replyDecision.question },
    e,
  );
  return deliverBrainResponse({ res, body, session, chatId, group, phone, text, e });
}

module.exports = { handle, watchedGroup, formatWhatsAppAnswer, crewVoice, brainFoundMaterial };
