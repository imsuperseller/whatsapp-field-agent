/**
 * What the bridge does with a voice note and a video (2026-10-15).
 *
 * Until now anything that was not a photo got "I can only look at photos",
 * posted into the live group even when the voice note was one technician
 * talking to another. the operator: "It's supposed to deal with all." These replays pin
 * the new path:
 *   - a voice note is transcribed by the door and then judged like a typed
 *     line: a question is answered, chatter is left alone, and a listening-only
 *     group or an unknown sender costs nothing;
 *   - a video with a caption reaches the brain as one picture (three stills)
 *     plus what was said in it; a bare video shared with the room is left alone;
 *   - when speech cannot be read, a private chat is told so and the group hears
 *     nothing about it; when the door says the day's cap is spent, the same.
 *
 * Runs the real bridge with the network AND ffmpeg stubbed: nothing reaches
 * WhatsApp, the site, any AI, or a binary. The real ffmpeg path is proven in
 * test-media.cjs.
 */
process.env.BOBOT_GROUP_BURST_MAX = '1000';
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobot-voice-'));
process.env.WAHA_DIR = dir;
fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
fs.writeFileSync(path.join(dir, '.env'), 'WAHA_API_KEY=x\nSITE_URL=https://example.invalid\nWHATSAPP_BRIDGE_SECRET=y\n');
fs.writeFileSync(path.join(dir, 'watched-groups.json'), JSON.stringify({
  groups: {
    'G@g.us': { name: 'Field Techs', session: 'acme', may_post: true, tenant_slug: 'acme-locks' },
    'QUIET@g.us': { name: 'Listening only', session: 'acme', may_post: false, tenant_slug: 'acme-locks' },
  },
}));

const media = require(path.join(__dirname, '..', 'media.cjs'));
const ffmpegRuns = [];
let ffmpegMode = 'ok'; // 'ok' | 'fails'
media.tools.run = async (bin, args) => {
  ffmpegRuns.push({ bin, args });
  if (ffmpegMode === 'fails') throw new Error('ffmpeg failed: Invalid data found when processing input');
  if (/ffprobe$/.test(bin)) return { stdout: Buffer.from('6.0\n'), stderr: Buffer.alloc(0) };
  const out = args[args.length - 1];
  const isSpeech = args.includes('mp3');
  fs.writeFileSync(out, isSpeech ? Buffer.from('ID3fake-mp3-bytes') : Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]));
  return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
};

const sent = [];
const transcribed = [];   // every transcription request the door received
const asked = [];         // every answer request the brain received
const fetched = [];       // every file pulled from the gateway
let transcript = 'what blank for a 2012 silverado';
let doorMode = 'ok';      // 'ok' | 'cap' | 'down' | 'no-key'

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.endsWith('/api/sessions')) return { ok: true, json: async () => ([{ name: 'acme', me: { id: '15555550100@c.us', lid: '999999999999999@lid' } }]) };
  if (u.includes('/groups')) return { ok: true, json: async () => ([{ JID: 'G@g.us', Participants: [{ JID: 'p@lid', PhoneNumber: '12145550000@s.whatsapp.net' }] }, { JID: 'QUIET@g.us', Participants: [{ JID: 'p@lid', PhoneNumber: '12145550000@s.whatsapp.net' }] }]) };
  if (u.endsWith('/api/sendText')) { sent.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
  if (u.startsWith('http://127.0.0.1:3000/api/files/')) {
    fetched.push(u);
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer };
  }
  if (u.includes('/api/whatsapp/tech-support')) {
    const body = JSON.parse(opts.body);
    if (body.action === 'transcribe') {
      transcribed.push(body);
      if (doorMode === 'cap') return { ok: false, status: 429, json: async () => ({ error: 'transcription_cap' }) };
      if (doorMode === 'down') return { ok: false, status: 502, json: async () => ({ error: 'transcription_failed' }) };
      if (doorMode === 'no-key') return { ok: false, status: 503, json: async () => ({ error: 'transcription_not_configured' }) };
      return { ok: true, status: 200, json: async () => ({ transcript, seconds: 6 }) };
    }
    asked.push(body);
    return { ok: true, status: 200, json: async () => ({ answer: 'Answer:\n1. H92-PT for that one.' }) };
  }
  throw new Error(`unexpected call to ${u}`);
};

const { handle } = require(path.join(__dirname, '..', 'bridge.js'));
const now = () => Math.floor(Date.now() / 1000);
let id = 0;
const VOICE = () => ({ url: `http://127.0.0.1:3000/api/files/v${id}.ogg`, mimetype: 'audio/ogg; codecs=opus' });
const VIDEO = () => ({ url: `http://127.0.0.1:3000/api/files/c${id}.mp4`, mimetype: 'video/mp4' });
const inGroup = (chat, body, m) => ({ from: chat, participant: 'p@lid', id: `m${id++}`, timestamp: now(), body, hasMedia: Boolean(m), ...(m ? { media: m } : {}) });
const inPrivate = (body, m) => ({ from: '12145550000@c.us', id: `m${id++}`, timestamp: now(), body, hasMedia: Boolean(m), ...(m ? { media: m } : {}) });
const reset = () => { sent.length = 0; transcribed.length = 0; asked.length = 0; fetched.length = 0; ffmpegRuns.length = 0; doorMode = 'ok'; ffmpegMode = 'ok'; };

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' — ' + JSON.stringify(detail)}`);
  if (!ok) failures++;
};

(async () => {
  // 1. A spoken question in the group is heard and answered.
  reset(); transcript = 'bobot what blank for a 2012 silverado';
  let v = await handle(inGroup('G@g.us', '', VOICE()), 'acme');
  check('a voice note is fetched, rendered to speech and sent to the door to transcribe',
    fetched.length === 1 && ffmpegRuns.some((r) => r.args.includes('mp3')) && transcribed.length === 1
      && transcribed[0].audio && transcribed[0].audio.mimeType === 'audio/mpeg' && transcribed[0].phone === '12145550000',
    { fetched, transcribed: transcribed.map((t) => ({ mime: t.audio && t.audio.mimeType, phone: t.phone })) });
  check('its words are then asked of the brain as a question, and the crew gets the answer',
    v === 'answered' && asked.length === 1 && asked[0].question === 'what blank for a 2012 silverado' && !asked[0].image && sent.length === 1 && /H92/.test(sent[0].text),
    { v, asked, sent });

  // 2. A voice note of plain chatter is heard and left alone.
  reset(); transcript = "ok I'm on my way, be there in ten";
  v = await handle(inGroup('G@g.us', '', VOICE()), 'acme');
  check('a spoken "on my way" is transcribed and then left alone like a typed one',
    transcribed.length === 1 && asked.length === 0 && sent.length === 0 && /left alone/.test(v), { v, asked, sent });

  // 3. A listening-only group spends nothing on a voice note.
  reset(); transcript = 'bobot what blank for a 2012 silverado';
  v = await handle(inGroup('QUIET@g.us', '', VOICE()), 'acme');
  check('a voice note in a listening-only group is neither fetched nor transcribed',
    v === 'listening — not answered' && fetched.length === 0 && transcribed.length === 0 && sent.length === 0, { v, fetched, transcribed });

  // 4. The day's transcription cap: the group hears nothing; a private chat is told.
  reset(); doorMode = 'cap';
  v = await handle(inGroup('G@g.us', '', VOICE()), 'acme');
  check('when the door says the cap is spent, the group hears nothing about it',
    v === 'voice note unavailable' && sent.length === 0 && asked.length === 0, { v, sent });
  reset(); doorMode = 'cap';
  v = await handle(inPrivate('', VOICE()), 'acme');
  check('…and a private chat is told to type it',
    v === 'voice note unavailable' && sent.length === 1 && /voice-note limit/i.test(sent[0].text) && asked.length === 0, { v, sent });

  // 4b. A shop that has given no transcription key of its own: nothing is spent,
  //     the group hears nothing, a private chat is told to type it.
  reset(); doorMode = 'no-key';
  v = await handle(inGroup('G@g.us', '', VOICE()), 'acme');
  check('with no tenant transcription key the group hears nothing',
    v === 'voice note unavailable' && sent.length === 0 && asked.length === 0, { v, sent });
  reset(); doorMode = 'no-key';
  v = await handle(inPrivate('', VOICE()), 'acme');
  check('…and a private chat is told the shop cannot hear voice notes yet',
    v === 'voice note unavailable' && sent.length === 1 && /can'?t hear voice notes for this shop/i.test(sent[0].text) && asked.length === 0, { v, sent });

  // 5. A voice note in a private chat: every word is for Bobot.
  reset(); transcript = 'how do I program a 2019 camry smart key';
  v = await handle(inPrivate('', VOICE()), 'acme');
  check('a private voice note is answered, and the brain is told the chat is private',
    v === 'answered' && asked.length === 1 && asked[0].channel === 'private' && asked[0].question === transcript && transcribed[0].channel === 'private' && sent.length === 1,
    { v, asked, transcribed });

  // 6. A video with a caption in the group: one picture plus the words in it.
  reset(); transcript = 'the key turns but the truck wont crank';
  v = await handle(inGroup('G@g.us', 'bobot whats wrong here?', VIDEO()), 'acme');
  check('a captioned video reaches the brain as a JPEG of its stills',
    v === 'answered' && asked.length === 1 && asked[0].image && asked[0].image.mimeType === 'image/jpeg' && ffmpegRuns.some((r) => r.args.some((a) => /tile=3x1/.test(a))),
    { v, asked: asked.map((a) => ({ q: a.question, img: a.image && a.image.mimeType })), ffmpeg: ffmpegRuns.map((r) => r.args.join(' ')) });
  check('…with the caption AND what was said in the clip, as one question',
    asked.length === 1 && /^whats wrong here\?/.test(asked[0].question) && /wont crank/.test(asked[0].question) && /frames from it/.test(asked[0].question) && sent.length === 1,
    { question: asked[0] && asked[0].question });

  // 7. A bare video shared with the room is left alone — and costs nothing.
  reset();
  v = await handle(inGroup('G@g.us', '', VIDEO()), 'acme');
  check('a video with no caption is left alone, with no ffmpeg run and no transcription',
    sent.length === 0 && asked.length === 0 && fetched.length === 0 && ffmpegRuns.length === 0 && transcribed.length === 0, { v, fetched, ffmpegRuns });

  // 8. A silent video (no speech track) still gets its pictures answered.
  reset(); transcript = '';
  v = await handle(inPrivate('', VIDEO()), 'acme');
  // The door supplies the default "what is this?" when a picture arrives with no words, exactly as for a photo.
  check('a private video with no caption is still a question, answered from its stills',
    v === 'answered' && asked.length === 1 && asked[0].image && asked[0].image.mimeType === 'image/jpeg' && asked[0].question === '' && asked[0].channel === 'private',
    { v, asked: asked.map((a) => ({ q: a.question, img: a.image && a.image.mimeType })) });

  // 9. When the clip cannot be read: a private chat is told, the group is not.
  reset(); ffmpegMode = 'fails';
  v = await handle(inPrivate('', VOICE()), 'acme');
  check('a voice note ffmpeg cannot read is admitted in a private chat, and never answered from nothing',
    v === 'audio unavailable' && sent.length === 1 && /couldn'?t make out that voice note/i.test(sent[0].text) && asked.length === 0 && transcribed.length === 0, { v, sent, asked });
  reset(); ffmpegMode = 'fails';
  v = await handle(inGroup('G@g.us', '', VOICE()), 'acme');
  check('…and the group hears nothing when a voice note between the crew cannot be read',
    v === 'audio unavailable' && sent.length === 0 && asked.length === 0, { v, sent });

  // 10. The door being down for transcription does not silence a video's pictures.
  reset(); doorMode = 'down';
  v = await handle(inGroup('G@g.us', 'bobot what is this?', VIDEO()), 'acme');
  check('a video whose speech could not be transcribed is still answered from its stills',
    v === 'answered' && asked.length === 1 && asked[0].image && !/frames from it/.test(asked[0].question), { v, asked: asked.map((a) => a.question) });

  // 11. The log says what happened, in words, for the silent cases.
  const log = fs.readFileSync(path.join(dir, 'logs', 'bridge.jsonl'), 'utf8');
  check('every quiet decision is written down',
    /voice note — listening only/.test(log) && /left alone/.test(log) && /transcription_cap/.test(log), { logTail: log.split('\n').slice(-4) });

  console.log(failures ? `\n${failures} case(s) wrong` : '\nvoice notes and videos are heard, seen, and judged like typed lines');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
