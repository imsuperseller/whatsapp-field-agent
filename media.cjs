'use strict';
// What a technician attaches, made readable for the brain.
//
// Until 2026-10-15 the bridge could carry a PHOTO to the brain and nothing
// else. A voice note or a video — the two things a man on a truck actually
// sends when his hands are dirty — got "I can only look at photos", posted into
// the crew's group even when the voice note was one technician talking to
// another. the operator: "It's supposed to deal with all."
//
// This file turns an attachment into something the brain already understands:
//   - a PHOTO stays a photo (bytes, as before);
//   - a VOICE NOTE becomes a small speech track the brain's door transcribes,
//     and the transcript is then handled exactly like a typed message;
//   - a VIDEO becomes a contact sheet of three stills (one picture, so the
//     brain's photo path reads it unchanged) plus its speech track.
//
// The heavy lifting happens HERE, on the server beside the gateway, with the
// box's own ffmpeg — never on the brain's side, where a serverless request has
// a few megabytes of body and no ffmpeg. What leaves this box is small: a 32 kbps
// mono MP3 of at most three minutes, and one JPEG.
//
// It does not think, and it does not decide whether to answer. It reads, and
// it says plainly when it cannot.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const IMAGE_TYPES = /^image\/(?:jpeg|png|webp|gif)$/;
const AUDIO_TYPES = /^audio\//;                       // WhatsApp voice notes arrive as audio/ogg; codecs=opus
const VIDEO_TYPES = /^video\/(?:mp4|quicktime|webm|3gpp|x-matroska)$/;

// How much the bridge will pull from the gateway for one message. WhatsApp
// itself caps an ordinary video at 16 MB; HD sends run larger.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_VIDEO_BYTES = 48 * 1024 * 1024;

// Transcribe at most the first three minutes. A longer voice note is a story,
// not a question, and every minute is paid for.
const MAX_SPEECH_SECONDS = 180;
// The speech track the door receives: mono, 16 kHz, 32 kbps — plenty for
// speech, and three minutes of it is well under a megabyte.
const SPEECH_BITRATE = '32k';
// The contact sheet: three stills across one row, each this wide.
const FRAME_COUNT = 3;
const FRAME_WIDTH = 480;
const FFMPEG_TIMEOUT_MS = 60 * 1000;

/**
 * Everything that touches the outside world, in one place, so a test can hand
 * in a fake ffmpeg or a fake gateway without the network or a binary.
 */
const tools = {
  ffmpeg: process.env.BOBOT_FFMPEG || 'ffmpeg',
  ffprobe: process.env.BOBOT_FFPROBE || 'ffprobe',
  run: (bin, args) => new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: FFMPEG_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        // ffmpeg says WHY two lines above its last line ("Output file does not
        // contain any stream" … "Invalid argument"), so keep the tail, not the end.
        const detail = String(stderr || '').trim().split('\n').slice(-3).join(' | ') || err.message;
        return reject(new Error(`${path.basename(bin)} failed: ${detail}`));
      }
      resolve({ stdout, stderr });
    });
  }),
  fetch: (...args) => fetch(...args),
};

/** "audio/ogg; codecs=opus" -> "audio/ogg". */
function mimeOf(media) {
  return String((media && media.mimetype) || '').toLowerCase().split(';')[0].trim();
}

/** What kind of attachment this is, by its declared type. */
function kindOf(mime) {
  if (IMAGE_TYPES.test(mime)) return 'image';
  if (AUDIO_TYPES.test(mime)) return 'audio';
  if (VIDEO_TYPES.test(mime)) return 'video';
  return 'other';
}

/** The attachment's bytes from the gateway, which keeps them behind its API key. */
async function download(media, apiKey, cap) {
  const res = await tools.fetch(media.url, { headers: { 'X-Api-Key': apiKey } });
  if (!res.ok) throw new Error(`gateway returned ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('empty file');
  if (buf.length > cap) throw new Error(`too large (${buf.length} bytes, cap ${cap})`);
  return buf;
}

/** How long the clip runs, in seconds, or null when the container does not say. */
async function durationOf(file) {
  try {
    const { stdout } = await tools.run(tools.ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
    ]);
    const seconds = Number(String(stdout).trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch { return null; }
}

/**
 * The speech in a clip, as a small MP3 cut at MAX_SPEECH_SECONDS. Null when the
 * clip has no audio track at all (a silent video), which is not an error.
 */
async function speechTrack(file, out) {
  try {
    await tools.run(tools.ffmpeg, [
      '-y', '-v', 'error', '-i', file,
      '-t', String(MAX_SPEECH_SECONDS), '-vn', '-ac', '1', '-ar', '16000', '-b:a', SPEECH_BITRATE,
      '-f', 'mp3', out,
    ]);
  } catch (err) {
    if (/does not contain any stream|Stream map .* matches no streams|no audio/i.test(err.message)) return null;
    throw err;
  }
  const bytes = fs.existsSync(out) ? fs.readFileSync(out) : Buffer.alloc(0);
  return bytes.length ? bytes : null;
}

/**
 * Three stills from across the clip, side by side in one JPEG, so the brain's
 * photo path can look at a video without learning anything new. A clip too
 * short to split gets its single most representative frame.
 */
async function frameSheet(file, seconds, out) {
  const filter = seconds && seconds >= FRAME_COUNT
    ? `fps=${FRAME_COUNT}/${seconds.toFixed(3)},scale=${FRAME_WIDTH}:-2,tile=${FRAME_COUNT}x1`
    : `thumbnail,scale=${FRAME_WIDTH}:-2`;
  await tools.run(tools.ffmpeg, [
    '-y', '-v', 'error', '-i', file, '-vf', filter, '-frames:v', '1', '-q:v', '4', out,
  ]);
  const bytes = fs.existsSync(out) ? fs.readFileSync(out) : Buffer.alloc(0);
  if (!bytes.length) throw new Error('ffmpeg produced no frame');
  return bytes;
}

/**
 * Read one attachment. Returns, by kind:
 *   image → { kind: 'image', imagePart }
 *   audio → { kind: 'audio', seconds, truncated, speech }
 *   video → { kind: 'video', seconds, truncated, imagePart, speech | null }
 *   other → { kind: 'other' }                       (nothing fetched)
 * where imagePart / speech are { base64, mimeType }. Throws, with a plain
 * message, when the file cannot be fetched or converted — the caller decides
 * what to tell the sender, never this file.
 */
async function readAttachment(media, apiKey) {
  const mime = mimeOf(media);
  const kind = kindOf(mime);
  if (kind === 'other') return { kind, mime };

  if (kind === 'image') {
    const bytes = await download(media, apiKey, MAX_IMAGE_BYTES);
    return { kind, mime, imagePart: { base64: bytes.toString('base64'), mimeType: mime } };
  }

  const bytes = await download(media, apiKey, kind === 'audio' ? MAX_AUDIO_BYTES : MAX_VIDEO_BYTES);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobot-media-'));
  try {
    const input = path.join(dir, 'in');
    fs.writeFileSync(input, bytes);
    const seconds = await durationOf(input);
    const truncated = Boolean(seconds && seconds > MAX_SPEECH_SECONDS);
    const speechBytes = await speechTrack(input, path.join(dir, 'speech.mp3'));
    const speech = speechBytes ? { base64: speechBytes.toString('base64'), mimeType: 'audio/mpeg' } : null;
    if (kind === 'audio') {
      if (!speech) throw new Error('no speech track in the voice note');
      return { kind, mime, seconds, truncated, speech };
    }
    const sheet = await frameSheet(input, seconds, path.join(dir, 'frames.jpg'));
    return { kind, mime, seconds, truncated, speech, imagePart: { base64: sheet.toString('base64'), mimeType: 'image/jpeg' } };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  readAttachment,
  kindOf,
  mimeOf,
  tools,
  MAX_SPEECH_SECONDS,
  FRAME_COUNT,
};
