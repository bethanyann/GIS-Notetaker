import { readFile } from 'node:fs/promises';
import OpenAI, { toFile } from 'openai';
import { pcm16kToWav, silence16k } from './audio.js';
import {
  buildTurns,
  formatTranscript,
  innerSilences,
  isLikelyHallucination,
  type TranscriptLine,
  type Turn,
  type UtteranceMeta,
} from './transcript.js';
import type { Config } from './config.js';

export interface TranscriptResult {
  text: string;
  lines: TranscriptLine[];
  /** Seconds of audio sent for transcription, which is what you're billed for. */
  audioSeconds: number;
}

/** Transcription requests in flight at once. */
const CONCURRENCY = 5;

export async function transcribeMeeting(
  config: Config,
  utterances: UtteranceMeta[],
  names: Map<string, string>,
): Promise<TranscriptResult> {
  // Any OpenAI-compatible endpoint works: OpenAI by default, or e.g. Groq via TRANSCRIPTION_BASE_URL.
  const client = new OpenAI({
    apiKey: config.transcription.apiKey,
    ...(config.transcription.baseUrl ? { baseURL: config.transcription.baseUrl } : {}),
  });
  const prompt = config.glossary
    ? `A software team meeting. Terms that may come up: ${config.glossary}.`
    : 'A software team meeting.';

  const turns = buildTurns(utterances);
  const lines: TranscriptLine[] = [];
  let audioSeconds = 0;

  await mapWithConcurrency(turns, CONCURRENCY, async (turn, index) => {
    const pcm = await stitchTurnAudio(turn);
    audioSeconds += pcm.length / 2 / 16_000;

    const file = await toFile(pcm16kToWav(pcm), `turn-${index}.wav`, { type: 'audio/wav' });
    const response = await withRetry(() =>
      client.audio.transcriptions.create({
        file,
        model: config.transcription.model,
        response_format: 'json',
        prompt,
        ...(config.transcription.language ? { language: config.transcription.language } : {}),
      }),
    );

    const text = response.text?.trim() ?? '';
    if (!isLikelyHallucination(text, turn.endMs - turn.startMs)) {
      lines.push({ userId: turn.userId, meetingMs: turn.startMs, text });
    }
  });

  return { text: formatTranscript(lines, names), lines, audioSeconds };
}

async function stitchTurnAudio(turn: Turn): Promise<Buffer> {
  const silences = innerSilences(turn);
  const parts: Buffer[] = [];
  for (const [i, u] of turn.utterances.entries()) {
    if (silences[i] > 0) parts.push(silence16k(silences[i]));
    parts.push(await readFile(u.file));
  }
  return Buffer.concat(parts);
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await fn(items[index], index);
    }
  });
  await Promise.all(workers);
}

/** Retry transient API failures (rate limits, timeouts, 5xx) with exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = (error as { status?: number }).status;
      const retryable = status === undefined || status === 408 || status === 429 || status >= 500;
      if (!retryable || attempt === attempts - 1) break;
      const delayMs = 1000 * 2 ** attempt + Math.random() * 500;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}
