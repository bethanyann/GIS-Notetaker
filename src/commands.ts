import { SlashCommandBuilder } from 'discord.js';

export const notesCommand = new SlashCommandBuilder()
  .setName('notes')
  .setDescription('Record this voice channel and post meeting minutes')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('start')
      .setDescription('Start taking notes in the voice channel you are in')
      .addStringOption((opt) =>
        opt.setName('title').setDescription('Meeting name, e.g. "Sprint 14 planning"').setMaxLength(100),
      ),
  )
  .addSubcommand((sub) => sub.setName('stop').setDescription('Stop recording and post the minutes'))
  .addSubcommand((sub) => sub.setName('status').setDescription('Show whether a meeting is being recorded'))
  .addSubcommand((sub) =>
    sub
      .setName('optout')
      .setDescription("Don't record me in this meeting, and delete anything already captured from me"),
  )
  .addSubcommand((sub) => sub.setName('optin').setDescription('Include me in this meeting again'));

export const commands = [notesCommand.toJSON()];
