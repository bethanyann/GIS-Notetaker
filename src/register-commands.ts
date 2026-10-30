/**
 * Registers the /notes slash command with Discord. Run once after setup and
 * again whenever commands change:  npm run register
 */
import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';
import { loadDiscordConfig } from './config.js';

const { token, clientId, guildId } = loadDiscordConfig();
const rest = new REST().setToken(token);

if (guildId) {
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  console.log(`Registered ${commands.length} command(s) to server ${guildId} (available immediately).`);
} else {
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log(`Registered ${commands.length} command(s) globally (can take up to an hour to appear).`);
}
