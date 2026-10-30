import { mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type VoiceConnection,
} from '@discordjs/voice';
import prism from 'prism-media';
import type { Guild, SendableChannels, VoiceBasedChannel } from 'discord.js';
import { downsample48kTo16k, pcm16kDurationMs } from './audio.js';
import { transcribeMeeting } from './transcribe.js';
import { writeMinutes } from './minutes.js';
import { postMinutes, postNothingRecorded } from './post.js';
import type { UtteranceMeta } from './transcript.js';
import type { Config } from './config.js';

/** A clip ends after this much silence. Shorter = more, smaller clips. */
const SILENCE_END_MS = 1_000;
/** Clips shorter than this are coughs, clicks and keyboard noise. */
const MIN_UTTERANCE_MS = 400;

export type StopReason = 'command' | 'empty-channel' | 'time-limit' | 'disconnected' | 'shutdown';

export interface SessionOptions {
  config: Config;
  guild: Guild;
  voiceChannel: VoiceBasedChannel;
  /** Where the recording notice goes (the channel /notes start was run in). */
  announceChannel: SendableChannels;
  /** Where the minutes go. */
  notesChannel: SendableChannels;
  title: string;
  startedBy: string;
  /** Called once the session has fully finished, so the manager can forget it. */
  onFinished: () => void;
}

export class RecordingSession {
  readonly id = randomUUID();
  readonly startedAt = new Date();
  readonly title: string;
  readonly voiceChannel: VoiceBasedChannel;
  readonly startedBy: string;

  private readonly options: SessionOptions;
  private readonly dir: string;
  private connection?: VoiceConnection;
  private readonly utterances: UtteranceMeta[] = [];
  private readonly pendingWrites = new Set<Promise<void>>();
  private readonly optedOut = new Set<string>();
  private readonly speakers = new Set<string>();
  private maxTimer?: NodeJS.Timeout;
  private emptyTimer?: NodeJS.Timeout;
  private stopping = false;

  constructor(options: SessionOptions) {
    this.options = options;
    this.title = options.title;
    this.voiceChannel = options.voiceChannel;
    this.startedBy = options.startedBy;
    this.dir = path.resolve(options.config.workDir, this.id);
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt.getTime();
  }

  get speakerCount(): number {
    return this.speakers.size;
  }

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true });

    const connection = joinVoiceChannel({
      channelId: this.voiceChannel.id,
      guildId: this.options.guild.id,
      adapterCreator: this.options.guild.voiceAdapterCreator,
      selfDeaf: false, // must hear the channel to record it
      selfMute: true,
    });
    this.connection = connection;

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (error) {
      connection.destroy();
      await rm(this.dir, { recursive: true, force: true });
      throw new Error('Could not connect to the voice channel within 20 seconds.', { cause: error });
    }

    // Recover from brief network blips; give up if Discord really kicked us out.
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        void this.stop('disconnected');
      }
    });

    connection.receiver.speaking.on('start', (userId: string) => this.captureUtterance(userId));

    this.maxTimer = setTimeout(
      () => void this.stop('time-limit'),
      this.options.config.maxMeetingMinutes * 60_000,
    );
  }

  private captureUtterance(userId: string): void {
    const receiver = this.connection?.receiver;
    if (!receiver || this.stopping || this.optedOut.has(userId)) return;
    if (receiver.subscriptions.has(userId)) return; // already capturing this person

    const startMs = this.elapsedMs;
    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_END_MS },
    });
    const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 1, frameSize: 960 });
    const chunks: Buffer[] = [];
    let failed = false;

    const onError = () => {
      failed = true;
      opusStream.destroy();
    };
    opusStream.on('error', onError);
    decoder.on('error', onError);
    decoder.on('data', (chunk: Buffer) => chunks.push(chunk));
    decoder.on('end', () => {
      if (failed || this.optedOut.has(userId)) return;
      const pcm = downsample48kTo16k(Buffer.concat(chunks));
      const durationMs = pcm16kDurationMs(pcm);
      if (durationMs < MIN_UTTERANCE_MS) return;

      const file = path.join(this.dir, `${startMs}-${userId}.pcm`);
      const write = writeFile(file, pcm)
        .then(() => {
          this.utterances.push({ userId, startMs, durationMs, file });
          this.speakers.add(userId);
        })
        .catch((error) => console.error('Failed to save audio clip', error))
        .finally(() => this.pendingWrites.delete(write));
      this.pendingWrites.add(write);
    });

    opusStream.pipe(decoder);
  }

  /** Exclude someone from this meeting and delete anything already captured from them. */
  async optOut(userId: string): Promise<void> {
    this.optedOut.add(userId);
    this.connection?.receiver.subscriptions.get(userId)?.destroy();
    await Promise.all([...this.pendingWrites]);
    const theirs = this.utterances.filter((u) => u.userId === userId);
    for (const u of theirs) {
      this.utterances.splice(this.utterances.indexOf(u), 1);
      await unlink(u.file).catch(() => {});
    }
    this.speakers.delete(userId);
  }

  optIn(userId: string): void {
    this.optedOut.delete(userId);
  }

  isOptedOut(userId: string): boolean {
    return this.optedOut.has(userId);
  }

  /** Called on every voice state change in the channel: leave once nobody is left. */
  checkOccupancy(): void {
    if (this.stopping) return;
    const humans = this.voiceChannel.members.filter((m) => !m.user.bot).size;
    if (humans === 0 && !this.emptyTimer) {
      this.emptyTimer = setTimeout(
        () => void this.stop('empty-channel'),
        this.options.config.emptyChannelGraceSeconds * 1000,
      );
    } else if (humans > 0 && this.emptyTimer) {
      clearTimeout(this.emptyTimer);
      this.emptyTimer = undefined;
    }
  }

  /** Stop recording, then transcribe, summarize, post, and delete the audio. */
  async stop(reason: StopReason): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this.maxTimer);
    clearTimeout(this.emptyTimer);

    const endedAt = new Date();
    const durationMs = endedAt.getTime() - this.startedAt.getTime();

    // End any clips still in progress so their audio is saved, then hang up.
    for (const stream of this.connection?.receiver.subscriptions.values() ?? []) stream.push(null);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await Promise.all([...this.pendingWrites]);
    this.connection?.destroy();

    const { config, notesChannel } = this.options;
    let status: Awaited<ReturnType<SendableChannels['send']>> | undefined;
    try {
      if (this.utterances.length === 0) {
        await postNothingRecorded(notesChannel, this.title);
        return;
      }

      status = await notesChannel
        .send(`⏳ Writing up minutes for **${this.title}**… (${describeReason(reason)})`)
        .catch(() => undefined);

      const names = await this.resolveNames();
      const transcript = await transcribeMeeting(config, this.utterances, names);

      if (!transcript.text.trim()) {
        await postNothingRecorded(notesChannel, this.title);
        return;
      }

      const minutes = await writeMinutes(config, {
        title: this.title,
        date: this.startedAt,
        transcript: transcript.text,
      });

      await postMinutes(notesChannel, {
        title: this.title,
        startedAt: this.startedAt,
        durationMs,
        minutes,
        transcript: transcript.text,
      });
      console.log(
        `Session ${this.id}: ${this.utterances.length} clips, ${Math.round(transcript.audioSeconds)}s of speech transcribed`,
      );
    } catch (error) {
      console.error(`Session ${this.id} failed during processing`, error);
      await notesChannel
        .send(
          `⚠️ Something went wrong writing up **${this.title}**: ${(error as Error).message}\n` +
            'The audio has been deleted. Check the bot logs for details.',
        )
        .catch(() => {});
    } finally {
      await status?.delete().catch(() => {});
      // Raw audio is never kept, whether or not processing succeeded.
      await rm(this.dir, { recursive: true, force: true }).catch(() => {});
      this.options.onFinished();
    }
  }

  private async resolveNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const userId of this.speakers) {
      const member = await this.options.guild.members.fetch(userId).catch(() => undefined);
      names.set(userId, member?.displayName ?? `User ${userId.slice(-4)}`);
    }
    return names;
  }
}

function describeReason(reason: StopReason): string {
  switch (reason) {
    case 'command':
      return 'stopped by command';
    case 'empty-channel':
      return 'everyone left the channel';
    case 'time-limit':
      return 'hit the maximum meeting length';
    case 'disconnected':
      return 'lost the voice connection';
    case 'shutdown':
      return 'the bot is restarting';
  }
}
