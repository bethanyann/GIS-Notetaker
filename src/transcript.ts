/**
 * Turning many short per-speaker clips into a readable transcript.
 *
 * Discord only sends audio while someone is talking, so the recording is a list
 * of short clips ("utterances"), each tagged with who said it and when. Silence is
 * never recorded, so we only pay to transcribe actual speech.
 *
 * Before transcribing, we group clips into conversational "turns": consecutive
 * clips from the same person, with nobody else speaking in between and only a
 * short pause between them. Each turn becomes one transcription request. That
 * gives the model enough context to transcribe accurately, keeps the number of
 * requests reasonable, and keeps the transcript in the right speaking order.
 */

export interface UtteranceMeta {
  userId: string;
  /** Milliseconds since the meeting started. */
  startMs: number;
  durationMs: number;
  /** Raw 16 kHz mono s16le PCM on disk. */
  file: string;
}

export interface Turn {
  userId: string;
  startMs: number;
  endMs: number;
  utterances: UtteranceMeta[];
}

export interface TranscriptLine {
  userId: string;
  meetingMs: number;
  text: string;
}

/** Same-speaker clips closer together than this belong to one turn. */
export const TURN_GAP_MS = 3_000;
/** Cap a turn's length so one long monologue doesn't become one giant upload. */
export const MAX_TURN_MS = 2 * 60 * 1000;
/** Longest pause kept between clips inside a turn; longer pauses are shortened to this. */
export const MAX_INNER_SILENCE_MS = 600;

export function buildTurns(
  utterances: UtteranceMeta[],
  gapMs = TURN_GAP_MS,
  maxTurnMs = MAX_TURN_MS,
): Turn[] {
  const sorted = [...utterances].sort((a, b) => a.startMs - b.startMs);
  const turns: Turn[] = [];
  let current: Turn | undefined;

  for (const u of sorted) {
    const uEnd = u.startMs + u.durationMs;
    const continues =
      current !== undefined &&
      current.userId === u.userId &&
      u.startMs - current.endMs <= gapMs &&
      uEnd - current.startMs <= maxTurnMs;

    if (continues) {
      current!.utterances.push(u);
      current!.endMs = Math.max(current!.endMs, uEnd);
    } else {
      current = { userId: u.userId, startMs: u.startMs, endMs: uEnd, utterances: [u] };
      turns.push(current);
    }
  }
  return turns;
}

/** Silence (ms) to insert before each clip of a turn when stitching its audio together. */
export function innerSilences(turn: Turn): number[] {
  return turn.utterances.map((u, i) => {
    if (i === 0) return 0;
    const prev = turn.utterances[i - 1];
    const gap = u.startMs - (prev.startMs + prev.durationMs);
    return Math.max(0, Math.min(gap, MAX_INNER_SILENCE_MS));
  });
}

// Speech models sometimes invent these from a cough, a click or background noise.
const HALLUCINATIONS = new Set([
  'thank you',
  'thanks for watching',
  'thank you for watching',
  'you',
  'bye',
  'okay',
  'hmm',
]);

/** Drop text that is probably not real speech: empty output or stock phrases from very short clips. */
export function isLikelyHallucination(text: string, turnDurationMs: number): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!?,…]+$/g, '')
    .trim();
  if (!normalized) return true;
  return turnDurationMs < 2_000 && HALLUCINATIONS.has(normalized);
}

export function formatTimestamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatTranscript(lines: TranscriptLine[], names: Map<string, string>): string {
  return [...lines]
    .sort((a, b) => a.meetingMs - b.meetingMs)
    .map((l) => `[${formatTimestamp(l.meetingMs)}] ${names.get(l.userId) ?? 'Unknown'}: ${l.text}`)
    .join('\n');
}
