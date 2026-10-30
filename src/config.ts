import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function number(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number, got "${raw}"`);
  }
  return parsed;
}

/** Discord-only settings, needed by both the bot and the command registration script. */
export function loadDiscordConfig() {
  return {
    token: required('DISCORD_TOKEN'),
    clientId: required('DISCORD_CLIENT_ID'),
    /** When set, commands register to this one server instantly instead of globally. */
    guildId: optional('DISCORD_GUILD_ID'),
  };
}

export type SummaryProvider = 'anthropic' | 'openai';

export function loadConfig() {
  const summaryProvider = (optional('SUMMARY_PROVIDER') ?? 'anthropic').toLowerCase();
  if (summaryProvider !== 'anthropic' && summaryProvider !== 'openai') {
    throw new Error(`SUMMARY_PROVIDER must be "anthropic" or "openai", got "${summaryProvider}"`);
  }

  return {
    discord: loadDiscordConfig(),

    /** Speech-to-text. Any OpenAI-compatible transcription endpoint. */
    transcription: {
      apiKey: required('TRANSCRIPTION_API_KEY'),
      /** Leave unset for OpenAI. For Groq: https://api.groq.com/openai/v1 */
      baseUrl: optional('TRANSCRIPTION_BASE_URL'),
      model: optional('TRANSCRIPTION_MODEL') ?? 'gpt-transcribe',
      /** ISO-639-1 code, e.g. "en". Leave unset to auto-detect. */
      language: optional('TRANSCRIPTION_LANGUAGE'),
    },

    /** The LLM that writes the minutes. */
    summary: {
      /** "anthropic" for Claude, "openai" for OpenAI or any OpenAI-compatible API. */
      provider: summaryProvider as SummaryProvider,
      apiKey: required('SUMMARY_API_KEY'),
      /** Only for the openai provider: point at OpenRouter, Gemini's OpenAI endpoint, etc. */
      baseUrl: optional('SUMMARY_BASE_URL'),
      model: optional('SUMMARY_MODEL') ?? (summaryProvider === 'anthropic' ? 'claude-sonnet-5-5' : ''),
    },

    /** Comma-separated words speech-to-text often gets wrong: product names, repos, teammates. */
    glossary: optional('GLOSSARY'),

    /** Where minutes are posted. Falls back to the channel /notes start was run in. */
    notesChannelId: optional('NOTES_CHANNEL_ID'),
    /** If set, only members with this role can start or stop recording. */
    allowedRoleId: optional('ALLOWED_ROLE_ID'),

    /** Hard stop so a forgotten session can't run (and bill) forever. */
    maxMeetingMinutes: number('MAX_MEETING_MINUTES', 180),
    /** Stop this long after the last person leaves the voice channel. */
    emptyChannelGraceSeconds: number('EMPTY_CHANNEL_GRACE_SECONDS', 60),

    /** Scratch space for audio clips. Each meeting's folder is deleted after processing. */
    workDir: optional('WORK_DIR') ?? './.recordings',
  };
}

export type Config = ReturnType<typeof loadConfig>;

export function validateConfig(config: Config): void {
  if (!config.summary.model) {
    throw new Error('SUMMARY_MODEL is required when SUMMARY_PROVIDER is "openai"');
  }
}
