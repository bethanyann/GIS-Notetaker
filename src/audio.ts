/**
 * Audio helpers. Discord gives us 48 kHz Opus; we decode it to 48 kHz mono PCM,
 * then downsample to 16 kHz mono, which is what Whisper uses internally anyway.
 * 16 kHz mono 16-bit is ~1.9 MB per minute, so uploads stay small.
 */

export const DISCORD_SAMPLE_RATE = 48_000;
export const WHISPER_SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;

/** Downsample 48 kHz mono s16le PCM to 16 kHz by averaging each group of 3 samples. */
export function downsample48kTo16k(pcm48k: Buffer): Buffer {
  const inSamples = Math.floor(pcm48k.length / BYTES_PER_SAMPLE);
  const outSamples = Math.floor(inSamples / 3);
  const out = Buffer.alloc(outSamples * BYTES_PER_SAMPLE);
  for (let i = 0; i < outSamples; i++) {
    const base = i * 3 * BYTES_PER_SAMPLE;
    const avg =
      (pcm48k.readInt16LE(base) +
        pcm48k.readInt16LE(base + 2) +
        pcm48k.readInt16LE(base + 4)) /
      3;
    out.writeInt16LE(Math.round(avg), i * BYTES_PER_SAMPLE);
  }
  return out;
}

/** Duration in milliseconds of 16 kHz mono s16le PCM. */
export function pcm16kDurationMs(pcm: Buffer): number {
  return (pcm.length / BYTES_PER_SAMPLE / WHISPER_SAMPLE_RATE) * 1000;
}

/** Silent 16 kHz mono PCM of the given length. */
export function silence16k(ms: number): Buffer {
  const samples = Math.round((ms / 1000) * WHISPER_SAMPLE_RATE);
  return Buffer.alloc(samples * BYTES_PER_SAMPLE);
}

/** Wrap 16 kHz mono s16le PCM in a WAV header. */
export function pcm16kToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = WHISPER_SAMPLE_RATE * BYTES_PER_SAMPLE;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(WHISPER_SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
