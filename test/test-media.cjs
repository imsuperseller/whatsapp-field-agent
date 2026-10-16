'use strict';
// The real ffmpeg path: does a voice note become a small speech track, and a
// video three stills in one picture? Runs against the box's own ffmpeg on
// synthetic clips it makes itself; skips, loudly, where there is no ffmpeg.
// The deploy probe fails if the Bobot server ever lacks one.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const media = require('../media.cjs');

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobot-media-test-'));
const file = (name) => path.join(dir, name);

function make(args) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { timeout: 60000 });
}

function probe(target, entries) {
  return execFileSync('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'csv=p=0', target], { encoding: 'utf8' }).trim();
}

// The gateway is stood in for by the local file system.
media.tools.fetch = async (url) => ({ ok: true, arrayBuffer: async () => fs.readFileSync(url.replace('file://', '')).buffer.slice(0) });
const att = (name, mimetype) => ({ url: `file://${file(name)}`, mimetype });

test('a voice note becomes a mono MP3 the door can transcribe', { skip: !haveFfmpeg && 'ffmpeg not installed here' }, async () => {
  make(['-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=16000', '-t', '4', '-c:a', 'libopus', file('voice.ogg')]);
  const read = await media.readAttachment(att('voice.ogg', 'audio/ogg; codecs=opus'), 'k');
  assert.equal(read.kind, 'audio');
  assert.equal(read.speech.mimeType, 'audio/mpeg');
  assert.ok(read.seconds > 3.5 && read.seconds < 4.5, `duration ${read.seconds}`);
  assert.equal(read.truncated, false);
  fs.writeFileSync(file('speech.mp3'), Buffer.from(read.speech.base64, 'base64'));
  // ffprobe prints codec, sample rate, channels in its own order.
  assert.match(probe(file('speech.mp3'), 'stream=codec_name,sample_rate,channels'), /mp3,16000,1/);
});

test('a video becomes three stills side by side, plus its speech', { skip: !haveFfmpeg && 'ffmpeg not installed here' }, async () => {
  make(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file('clip.mp4')]);
  const read = await media.readAttachment(att('clip.mp4', 'video/mp4'), 'k');
  assert.equal(read.kind, 'video');
  assert.equal(read.imagePart.mimeType, 'image/jpeg');
  assert.ok(read.speech, 'the clip has speech');
  fs.writeFileSync(file('sheet.jpg'), Buffer.from(read.imagePart.base64, 'base64'));
  // Three 480-wide stills in a row: 1440 wide, and under the brain's 5 MB cap by a mile.
  assert.match(probe(file('sheet.jpg'), 'stream=codec_name,width'), /mjpeg,1440/);
  assert.ok(Buffer.from(read.imagePart.base64, 'base64').length < 1024 * 1024);
});

test('a silent video has pictures and no speech, which is not an error', { skip: !haveFfmpeg && 'ffmpeg not installed here' }, async () => {
  make(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', file('silent.mp4')]);
  const read = await media.readAttachment(att('silent.mp4', 'video/mp4'), 'k');
  assert.equal(read.kind, 'video');
  assert.equal(read.speech, null);
  assert.ok(read.imagePart, 'a short clip still yields a still');
});

test('only the first three minutes of a long voice note are sent to be transcribed', { skip: !haveFfmpeg && 'ffmpeg not installed here' }, async () => {
  make(['-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=16000', '-t', '200', '-c:a', 'libopus', file('long.ogg')]);
  const read = await media.readAttachment(att('long.ogg', 'audio/ogg'), 'k');
  assert.equal(read.truncated, true);
  fs.writeFileSync(file('long.mp3'), Buffer.from(read.speech.base64, 'base64'));
  const seconds = Number(probe(file('long.mp3'), 'format=duration'));
  assert.ok(seconds <= media.MAX_SPEECH_SECONDS + 1, `speech track runs ${seconds}s`);
  assert.ok(Buffer.from(read.speech.base64, 'base64').length < 1024 * 1024, 'three minutes of speech stays under a megabyte');
});

test('a type it cannot read is named as such, and nothing is fetched', async () => {
  let fetched = 0;
  media.tools.fetch = async () => { fetched += 1; return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }; };
  const read = await media.readAttachment({ url: 'file:///nowhere', mimetype: 'application/pdf' }, 'k');
  assert.equal(read.kind, 'other');
  assert.equal(fetched, 0);
  assert.equal(media.kindOf('audio/ogg'), 'audio');
  assert.equal(media.kindOf('video/quicktime'), 'video');
  assert.equal(media.kindOf('image/webp'), 'image');
  assert.equal(media.mimeOf({ mimetype: 'Audio/OGG; codecs=opus' }), 'audio/ogg');
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
