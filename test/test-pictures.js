/**
 * What the bridge does with a picture.
 *
 * Sam asked his crew for photos on 2026-08-28. These cases pin the whole path:
 * a readable image is fetched from the gateway and its BYTES are handed to the
 * door; anything that is not a readable image says so; and a picture that cannot
 * be fetched NEVER falls through to answering its caption — that would be
 * answering a photo nobody looked at.
 *
 * Runs the real bridge with the network stubbed, so nothing reaches the group.
 */
// Each case below is a separate conversation, not a burst: lift the live per-group post cap.
process.env.BOBOT_GROUP_BURST_MAX = '1000';
const path = require('path');
const DIR = __dirname;

const sent = [];
let doorBody = null;
let imageFetchFails = false;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/api/sendText')) { sent.push(JSON.parse(opts.body).text); return { ok: true, json: async () => ({}) }; }
  if (u.includes('/groups')) return { ok: true, json: async () => ([{ JID: 'G@g.us', Participants: [{ JID: 'p@lid', PhoneNumber: '12145550000' }] }]) };
  if (u.includes('/api/whatsapp/tech-support')) { doorBody = JSON.parse(opts.body); return { ok: true, json: async () => ({ answer: 'Answer:\n1. That is a Kwikset SmartKey cylinder.' }) }; }
  if (u.startsWith('http://127.0.0.1:3000/api/files/')) {
    if (imageFetchFails) return { ok: false, status: 404 };
    return { ok: true, arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).buffer };
  }
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
fs.appendFileSync = () => {};
fs.writeFileSync = () => {};

const { handle } = require(path.join(DIR, '..', 'bridge.js'));
const now = () => Math.floor(Date.now() / 1000);
const IMG = { url: 'http://127.0.0.1:3000/api/files/x.jpg', mimetype: 'image/jpeg' };

let failures = 0, id = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
};

(async () => {
  // 1. A photo with a caption: the picture goes with the question.
  sent.length = 0; doorBody = null;
  let v = await handle({ from: 'G@g.us', participant: 'p@lid', id: `p${id++}`, timestamp: now(), body: 'what is this?', hasMedia: true, media: IMG }, 's');
  check('a photo with a caption reaches the brain WITH the image',
    v === 'answered' && doorBody && doorBody.image && doorBody.image.mimeType === 'image/jpeg' && doorBody.question === 'what is this?',
    JSON.stringify({ v, hasImage: Boolean(doorBody && doorBody.image) }));
  check('and the crew gets the answer, not an apology',
    sent.length === 1 && /Kwikset/.test(sent[0]), sent[0] || '(nothing sent)');

  // 2. A photo with NO caption is left alone — 2026-10-05 28 job photos drew 27 replies.
  sent.length = 0; doorBody = null;
  v = await handle({ from: 'G@g.us', participant: 'p@lid', id: `p${id++}`, timestamp: now(), body: '', hasMedia: true, media: IMG }, 's');
  check('a photo with no caption posts nothing', sent.length === 0 && doorBody === null, `verdict "${v}", sent ${sent.length}`);

  // 3. A photo shared with the room is not a question to us either.
  sent.length = 0; doorBody = null;
  v = await handle({ from: 'G@g.us', participant: 'p@lid', id: `p${id++}`, timestamp: now(), body: '@all check this out', hasMedia: true, media: IMG }, 's');
  check('a photo captioned "@all check this out" posts nothing', sent.length === 0 && doorBody === null, `verdict "${v}"`);

  // 4. A document is not something it can read — say so when asked, never
  //    guess from the caption. (Videos and voice notes are read since
  //    2026-10-15; test-voice-and-video.js covers them.)
  sent.length = 0; doorBody = null;
  v = await handle({ from: 'G@g.us', participant: 'p@lid', id: `p${id++}`, timestamp: now(), body: 'whats wrong here?', hasMedia: true, media: { url: 'http://127.0.0.1:3000/api/files/v.pdf', mimetype: 'application/pdf' } }, 's');
  check('a document is refused honestly, and never answered from its caption',
    v === 'media not readable' && doorBody === null && /photos, voice notes and videos/i.test(sent[0] || ''), sent[0] || '(nothing sent)');
  // 4b. A document the room shared with itself draws no "I can't read that" at all.
  sent.length = 0; doorBody = null;
  v = await handle({ from: 'G@g.us', participant: 'p@lid', id: `p${id++}`, timestamp: now(), body: '', hasMedia: true, media: { url: 'http://127.0.0.1:3000/api/files/v.pdf', mimetype: 'application/pdf' } }, 's');
  check('a document with no question attached is left alone', sent.length === 0 && doorBody === null, `verdict "${v}", sent ${sent.length}`);

  // 5. The picture cannot be fetched → say so; never answer the caption alone.
  imageFetchFails = true;
  sent.length = 0; doorBody = null;
  v = await handle({ from: 'G@g.us', participant: 'p@lid', id: `p${id++}`, timestamp: now(), body: 'what is this?', hasMedia: true, media: IMG }, 's');
  check('an unfetchable picture is admitted, not guessed at',
    v === 'picture unavailable' && doorBody === null && /couldn'?t open that picture/i.test(sent[0] || ''), sent[0] || '(nothing sent)');
  imageFetchFails = false;

  // 6. Plain text is untouched by any of it.
  sent.length = 0; doorBody = null;
  v = await handle({ from: 'G@g.us', participant: 'p@lid', id: `p${id++}`, timestamp: now(), body: 'What is the key blank for a 2020 Ford Escape?', hasMedia: false }, 's');
  check('a text question still goes through with no image attached',
    v === 'answered' && doorBody && !doorBody.image, JSON.stringify({ v, body: doorBody }));

  // 7. Acknowledgements are still ignored.
  sent.length = 0; doorBody = null;
  v = await handle({ from: 'G@g.us', participant: 'p@lid', id: `p${id++}`, timestamp: now(), body: 'Yes sir', hasMedia: false }, 's');
  check('an acknowledgement is still left alone', v.startsWith('left alone') && sent.length === 0, `verdict "${v}"`);

  console.log(failures ? `\n${failures} case(s) wrong` : '\nthe picture path behaves, and text is untouched');
  process.exit(failures ? 1 : 0);
})();
