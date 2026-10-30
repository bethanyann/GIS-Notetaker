import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTurns,
  formatTimestamp,
  formatTranscript,
  innerSilences,
  isLikelyHallucination,
  MAX_INNER_SILENCE_MS,
  type UtteranceMeta,
} from '../src/transcript.ts';

const u = (userId: string, startMs: number, durationMs: number): UtteranceMeta => ({
  userId,
  startMs,
  durationMs,
  file: `${startMs}-${userId}.pcm`,
});

test('same speaker with short pauses becomes one turn', () => {
  const turns = buildTurns([u('alice', 0, 2000), u('alice', 3000, 1500), u('alice', 5500, 1000)]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].startMs, 0);
  assert.equal(turns[0].endMs, 6500);
  assert.equal(turns[0].utterances.length, 3);
});

test('a long pause starts a new turn for the same speaker', () => {
  const turns = buildTurns([u('alice', 0, 1000), u('alice', 10_000, 1000)]);
  assert.equal(turns.length, 2);
});

test('another speaker in between splits turns and keeps speaking order', () => {
  const turns = buildTurns([
    u('alice', 0, 2000),
    u('bob', 2500, 1000),
    u('alice', 4000, 2000),
  ]);
  assert.deepEqual(
    turns.map((t) => t.userId),
    ['alice', 'bob', 'alice'],
  );
});

test('input order does not matter', () => {
  const turns = buildTurns([u('bob', 2500, 1000), u('alice', 4000, 2000), u('alice', 0, 2000)]);
  assert.deepEqual(
    turns.map((t) => [t.userId, t.startMs]),
    [
      ['alice', 0],
      ['bob', 2500],
      ['alice', 4000],
    ],
  );
});

test('very long monologues are capped', () => {
  const clips = Array.from({ length: 60 }, (_, i) => u('alice', i * 5000, 4500)); // 5 minutes
  const turns = buildTurns(clips);
  assert.ok(turns.length >= 3, `expected the 5-minute monologue to be split, got ${turns.length} turn(s)`);
  for (const t of turns) assert.ok(t.endMs - t.startMs <= 2 * 60 * 1000);
  assert.equal(turns.flatMap((t) => t.utterances).length, 60, 'no clips lost');
});

test('inner silences mirror real pauses but are capped', () => {
  const [turn] = buildTurns([u('alice', 0, 1000), u('alice', 1200, 1000), u('alice', 4000, 500)]);
  assert.deepEqual(innerSilences(turn), [0, 200, MAX_INNER_SILENCE_MS]);
});

test('hallucination filter drops stock phrases only from very short clips', () => {
  assert.equal(isLikelyHallucination('', 5000), true);
  assert.equal(isLikelyHallucination('   ', 5000), true);
  assert.equal(isLikelyHallucination('Thank you.', 800), true);
  assert.equal(isLikelyHallucination('Thank you.', 5000), false);
  assert.equal(isLikelyHallucination('I pushed the fix for ABC-142.', 800), false);
});

test('timestamps format as mm:ss and h:mm:ss', () => {
  assert.equal(formatTimestamp(0), '00:00');
  assert.equal(formatTimestamp(65_400), '01:05');
  assert.equal(formatTimestamp(3_725_000), '1:02:05');
});

test('transcript is sorted by time with speaker names', () => {
  const names = new Map([
    ['a', 'Alice'],
    ['b', 'Bob'],
  ]);
  const text = formatTranscript(
    [
      { userId: 'b', meetingMs: 5000, text: 'Sounds good.' },
      { userId: 'a', meetingMs: 1000, text: "I'll take ABC-142." },
      { userId: 'x', meetingMs: 9000, text: 'Hi.' },
    ],
    names,
  );
  assert.equal(text, "[00:01] Alice: I'll take ABC-142.\n[00:05] Bob: Sounds good.\n[00:09] Unknown: Hi.");
});
