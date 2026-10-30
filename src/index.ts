import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ChatInputCommandInteraction,
  type GuildMember,
  type SendableChannels,
} from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import { loadConfig, validateConfig } from './config.js';
import { RecordingSession } from './session.js';
import { formatTimestamp } from './transcript.js';

const config = loadConfig();
validateConfig(config);

/** Discord allows one voice connection per server, so one session per server. */
const sessions = new Map<string, RecordingSession>();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, (ready) => {
  console.log(`Logged in as ${ready.user.tag}`);
  if (process.env.DEBUG_VOICE) console.log(generateDependencyReport());
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'notes') return;
  try {
    await handleNotes(interaction);
  } catch (error) {
    console.error('Command failed', error);
    const content = `⚠️ ${(error as Error).message}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(content).catch(() => {});
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const session = sessions.get(newState.guild.id);
  if (!session) return;
  const channelId = session.voiceChannel.id;
  if (oldState.channelId === channelId || newState.channelId === channelId) session.checkOccupancy();
});

async function handleNotes(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: 'Use this command in a server.', flags: MessageFlags.Ephemeral });
    return;
  }
  const sub = interaction.options.getSubcommand();
  const session = sessions.get(interaction.guildId);
  const member = interaction.member;

  switch (sub) {
    case 'start': {
      if (!canControl(member)) {
        await replyPrivately(interaction, `You need the <@&${config.allowedRoleId}> role to start notes.`);
        return;
      }
      if (session) {
        await replyPrivately(
          interaction,
          `Already taking notes for **${session.title}** in ${session.voiceChannel}. Run \`/notes stop\` first.`,
        );
        return;
      }
      const voiceChannel = member.voice.channel;
      if (!voiceChannel) {
        await replyPrivately(interaction, 'Join the voice channel you want recorded, then run this again.');
        return;
      }
      const me = interaction.guild.members.me;
      const perms = me ? voiceChannel.permissionsFor(me) : null;
      if (!perms?.has(['ViewChannel', 'Connect'])) {
        await replyPrivately(interaction, `I don't have permission to join ${voiceChannel}.`);
        return;
      }

      const announceChannel = interaction.channel;
      if (!announceChannel?.isSendable()) {
        await replyPrivately(interaction, "I can't post in this channel. Try running the command somewhere else.");
        return;
      }
      const notesChannel = await resolveNotesChannel(interaction, announceChannel);

      await interaction.deferReply();
      const title =
        interaction.options.getString('title')?.trim() ||
        `${voiceChannel.name} meeting – ${new Date().toISOString().slice(0, 10)}`;

      const newSession = new RecordingSession({
        config,
        guild: interaction.guild,
        voiceChannel,
        announceChannel,
        notesChannel,
        title,
        startedBy: member.id,
        onFinished: () => sessions.delete(interaction.guildId),
      });
      sessions.set(interaction.guildId, newSession);
      try {
        await newSession.start();
      } catch (error) {
        sessions.delete(interaction.guildId);
        throw error;
      }

      await interaction.editReply(
        `🔴 **Recording started** in ${voiceChannel} by ${member}: **${title}**\n` +
          `What's said here will be transcribed and turned into minutes in ${notesChannel}. ` +
          'Raw audio is deleted as soon as the minutes are posted.\n' +
          "Don't want to be included? Run `/notes optout`. Run `/notes stop` when the meeting ends.",
      );
      newSession.checkOccupancy();
      return;
    }

    case 'stop': {
      if (!session) {
        await replyPrivately(interaction, "There's no meeting being recorded right now.");
        return;
      }
      const inChannel = member.voice.channelId === session.voiceChannel.id;
      if (!canControl(member) || (!inChannel && member.id !== session.startedBy)) {
        await replyPrivately(interaction, 'Only someone in the meeting (or who started it) can stop the notes.');
        return;
      }
      if (session.isStopping) {
        await replyPrivately(interaction, 'Already wrapping up. The minutes are on their way.');
        return;
      }
      await interaction.reply(
        `⏹️ **Recording stopped** after ${formatTimestamp(session.elapsedMs)}. Minutes for **${session.title}** will be posted shortly.`,
      );
      void session.stop('command');
      return;
    }

    case 'status': {
      if (!session) {
        await replyPrivately(interaction, 'Not recording. Start with `/notes start` from inside a voice channel.');
        return;
      }
      await replyPrivately(
        interaction,
        `🔴 Recording **${session.title}** in ${session.voiceChannel} for ${formatTimestamp(session.elapsedMs)} ` +
          `(${session.speakerCount} speaker${session.speakerCount === 1 ? '' : 's'} so far).` +
          (session.isOptedOut(member.id) ? '\nYou are opted out of this meeting.' : ''),
      );
      return;
    }

    case 'optout': {
      if (!session) {
        await replyPrivately(interaction, "There's no meeting being recorded right now.");
        return;
      }
      await session.optOut(member.id);
      await replyPrivately(
        interaction,
        "✅ You're opted out. Your voice won't be recorded for the rest of this meeting, " +
          'and anything already captured from you has been deleted. Run `/notes optin` to rejoin.',
      );
      return;
    }

    case 'optin': {
      if (!session) {
        await replyPrivately(interaction, "There's no meeting being recorded right now.");
        return;
      }
      session.optIn(member.id);
      await replyPrivately(interaction, "✅ You're back in. Your voice will be included from now on.");
      return;
    }
  }
}

function canControl(member: GuildMember): boolean {
  return !config.allowedRoleId || member.roles.cache.has(config.allowedRoleId);
}

async function resolveNotesChannel(
  interaction: ChatInputCommandInteraction<'cached'>,
  fallback: SendableChannels,
): Promise<SendableChannels> {
  if (!config.notesChannelId) return fallback;
  const channel = await interaction.guild.channels.fetch(config.notesChannelId).catch(() => null);
  if (channel && channel.type !== ChannelType.GuildCategory && channel.isSendable()) return channel;
  console.warn(`NOTES_CHANNEL_ID ${config.notesChannelId} isn't a channel I can post in; using the command channel.`);
  return fallback;
}

async function replyPrivately(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

// On redeploy or shutdown, finish any meeting in progress so its notes aren't lost.
async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, wrapping up ${sessions.size} active session(s)…`);
  await Promise.allSettled([...sessions.values()].map((s) => s.stop('shutdown')));
  await client.destroy();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await client.login(config.discord.token);
