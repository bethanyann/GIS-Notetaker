import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downsample48kTo16k, pcm16kDurationMs, pcm16kToWav, silence16k } from '../src/audio.ts';
import { splitMessage } from '../src/post.ts';

test('downsampling 1 second of 48 kHz audio gives 1 second at 16 kHz', () => {
  const oneSecond48k = Buffer.alloc(48_000 * 2);
  const out = downsample48kTo16k(oneSecond48k);
  assert.equal(out.length, 16_000 * 2);
  assert.equal(pcm16kDurationMs(out), 1000);
});

test('downsampling averages each group of three samples', () => {
  const input = Buffer.alloc(6 * 2);
  [300, 600, 900, -3, -6, -9].forEach((v, i) => input.writeInt16LE(v, i * 2));
  const out = downsample48kTo16k(input);
  assert.equal(out.readInt16LE(0), 600);
  assert.equal(out.readInt16LE(2), -6);
});

test('silence has the requested length', () => {
  assert.equal(pcm16kDurationMs(silence16k(600)), 600);
});

test('WAV header describes 16 kHz mono 16-bit audio', () => {
  const pcm = silence16k(250);
  const wav = pcm16kToWav(pcm);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt32LE(24), 16_000); // sample rate
  assert.equal(wav.readUInt16LE(34), 16); // bits per sample
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.equal(wav.length, 44 + pcm.length);
});

test('short messages are not split', () => {
  assert.deepEqual(splitMessage('hello\nworld'), ['hello\nworld']);
});

test('long messages split at line breaks within the limit', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `- action item number ${i}`);
  const parts = splitMessage(lines.join('\n'), 500);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 500);
  assert.equal(parts.join('\n'), lines.join('\n'), 'nothing lost or reordered');
});

test('a single very long line is broken at spaces', () => {
  const line = Array.from({ length: 300 }, () => 'word').join(' ');
  const parts = splitMessage(line, 100);
  for (const p of parts) assert.ok(p.length <= 100);
  assert.equal(parts.join(' '), line);
});
