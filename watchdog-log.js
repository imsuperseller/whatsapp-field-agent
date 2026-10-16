// webhook.jsonl proves every delivery ARRIVED (the April 2026 four-day silent drop).
// Proving arrival needs no message content, so a line holds metadata only.
// The single exception is the watchdog's own round-trip nonce: we generated it,
// and the line it lands on is the evidence the round trip completed.
const crypto = require('crypto');
const ROUNDTRIP = /^roundtrip-[a-z0-9]+-[a-z0-9]+$/;

// A WhatsApp message id embeds the chat and usually a phone number
// (false_<chat>@c.us_<key>, or ..._<participant>@c.us in a group), so the line keeps
// a one-way digest instead: still distinct per message, and no number in it.
function idDigest(id) {
  return typeof id === 'string' && id ? crypto.createHash('sha256').update(id).digest('hex').slice(0, 16) : null;
}

function chatKind(id) {
  const s = String(id || '');
  if (s.endsWith('@g.us')) return 'group';
  if (s.endsWith('@c.us') || s.endsWith('@lid') || s.endsWith('@s.whatsapp.net')) return 'private';
  return s ? 'other' : null;
}

function webhookRecord({ at, url, signatureOk, payload }) {
  const m = payload && payload.payload && typeof payload.payload === 'object' ? payload.payload : null;
  const body = m && typeof m.body === 'string' ? m.body : '';
  return {
    at, url,
    event: payload && payload.event,
    session: payload && payload.session,
    signatureOk,
    id: m ? idDigest(m.id) : null,
    chat: m ? chatKind(m.from) : null,
    // Which watched group, and when it was sent: the crew-silence alarm needs both.
    // A group's id is kept; a private chat's id is a person's number and is not.
    group: m && chatKind(m.from) === 'group' ? m.from : null,
    ts: m && Number.isFinite(Number(m.timestamp)) ? Number(m.timestamp) : null,
    fromMe: m ? m.fromMe === true : null,
    hasMedia: m ? m.hasMedia === true || Boolean(m.media && m.media.url) : null,
    chars: body.length,
    status: m && typeof m.status === 'string' ? m.status : null,
    roundtrip: m && m.fromMe === true && ROUNDTRIP.test(body) ? body : null
  };
}

// Log positions come from stat().size and therefore count bytes, not characters.
// A rotated (renamed) log restarts smaller than the offset taken before rotation;
// the new file then holds only lines written after the send, so read it whole.
function webhookContainsEcho(buffer, offset, nonce, session) {
  const from = offset > buffer.length ? 0 : offset;
  return buffer.subarray(from).toString('utf8').split('\n').some(line => {
    try {
      const r = JSON.parse(line);
      return r.signatureOk === true && r.session === session
        && ['message', 'message.any'].includes(r.event) && r.fromMe === true && r.roundtrip === nonce;
    } catch { return false; }
  });
}

module.exports = { webhookRecord, webhookContainsEcho };
