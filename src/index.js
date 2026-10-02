'use strict';

require('dotenv').config();

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const store = require('./store');
const { matches, userAllowed, sendResponse } = require('./triggers');
const { commandDefinition, handleInteraction, handleAutocomplete } = require('./commands/stims');

// ---------------------------------------------------------------------------
// Discord client
// ---------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged: must be enabled in the dev portal
  ],
  partials: [Partials.Channel],
});

// Register /stim per guild — guild-scoped commands are available instantly,
// with no global propagation delay.
async function registerCommands(guild) {
  try {
    await guild.commands.set([commandDefinition]);
  } catch (err) {
    console.error(`[bot] failed to register commands in guild ${guild.id}:`, err.message);
  }
}

const cooldowns = new Map(); // `${triggerName}:${channelId}` -> last fired ms

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot || !message.content || !message.guild) return;

    // This guild's stims first, then built-in defaults that haven't been hidden.
    const triggers = store.getTriggersForGuild(message.guild.id);

    for (const trigger of triggers) {
      if (!matches(trigger, message.content)) continue;
      if (!userAllowed(trigger, message.author.id)) continue;

      // Per-trigger, per-channel cooldown to avoid spamming.
      const cooldownSeconds = trigger.cooldownSeconds ?? store.getCooldownSeconds() ?? 3;
      const key = `${message.guild.id}:${trigger.name.toLowerCase()}:${message.channel.id}`;
      const last = cooldowns.get(key) || 0;
      if (Date.now() - last < cooldownSeconds * 1000) return;

      cooldowns.set(key, Date.now());

      const responses = Array.isArray(trigger.responses)
        ? trigger.responses
        : [trigger.responses];
      const chosen = trigger.pick === 'all'
        ? responses
        : [responses[Math.floor(Math.random() * responses.length)]];

      for (const response of chosen) {
        await sendResponse(message, response);
      }
      console.log(`[trigger] "${trigger.name}" fired by ${message.author.tag} in #${message.channel.name}`);

      // One trigger per message, so a response can't re-trigger another rule.
      return;
    }
  } catch (err) {
    console.error('[error] handling message:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'stim') {
      await handleInteraction(interaction);
    } else if (interaction.isAutocomplete() && interaction.commandName === 'stim') {
      await handleAutocomplete(interaction);
    }
  } catch (err) {
    console.error('[error] handling interaction:', err);
  }
});

client.on('clientReady', async () => {
  console.log(`[bot] logged in as ${client.user.tag}`);
  await Promise.all([...client.guilds.cache.values()].map(registerCommands));
});

client.on('guildCreate', registerCommands);

client.on('error', (err) => console.error('[bot] client error:', err));

if (!process.env.DISCORD_TOKEN) {
  console.error('[bot] DISCORD_TOKEN is not set. Copy .env.example to .env and add your token.');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
