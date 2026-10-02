'use strict';

const fsp = require('fs').promises;
const path = require('path');
const { randomBytes } = require('crypto');
const {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  SlashCommandStringOption,
  SlashCommandAttachmentOption,
  SlashCommandBooleanOption,
} = require('discord.js');
const store = require('../store');
const { buildPayload, MATCH_TYPES, validateTrigger } = require('../triggers');

const EPHEMERAL = MessageFlags.Ephemeral;
const MEDIA_DIR = path.join(__dirname, '..', '..', 'media');
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// Errors that are the user's fault — shown to them verbatim, ephemerally.
class CommandError extends Error {}

// ---------------------------------------------------------------------------
// Slash command definition
// ---------------------------------------------------------------------------

function stringOption(name, description, extra = {}) {
  const o = new SlashCommandStringOption().setName(name).setDescription(description);
  if (extra.required) o.setRequired(true);
  if (extra.maxLength) o.setMaxLength(extra.maxLength);
  if (extra.autocomplete) o.setAutocomplete(true);
  if (extra.choices) o.addChoices(...extra.choices);
  return o;
}

function attachmentOption(name, description) {
  return new SlashCommandAttachmentOption().setName(name).setDescription(description);
}

function booleanOption(name, description) {
  return new SlashCommandBooleanOption().setName(name).setDescription(description);
}

function nameOption(description, { autocomplete = false } = {}) {
  return stringOption('name', description, { required: true, maxLength: 100, autocomplete });
}

const MATCH_TYPE_CHOICES = [
  { name: 'contains (default)', value: 'contains' },
  { name: 'exact message', value: 'exact' },
  { name: 'starts with', value: 'startsWith' },
  { name: 'ends with', value: 'endsWith' },
  { name: 'regex', value: 'regex' },
];

// Appends the shared response-building options to a subcommand builder.
function responseOptions(sc) {
  sc.addStringOption(stringOption('content',
    'Text the bot replies with. Placeholders: {user} {username} {channel} {server} {message}',
    { maxLength: 2000 }));
  sc.addAttachmentOption(attachmentOption('image',
    'Image or GIF file the bot replies with (uploaded, permanent)'));
  sc.addStringOption(stringOption('image_url',
    'Image or GIF URL the bot replies with (gifs included)'));
  sc.addStringOption(stringOption('embed_title',
    'Title of an embed (makes the reply a rich embed)', { maxLength: 256 }));
  sc.addStringOption(stringOption('embed_description',
    'Description of the embed', { maxLength: 4000 }));
  sc.addStringOption(stringOption('embed_url',
    'Link the embed points to (the title becomes clickable)'));
  sc.addBooleanOption(booleanOption('reply',
    'Reply directly to the sender (default: yes)'));
  return sc;
}

const commandBuilder = new SlashCommandBuilder()
  .setName('stim')
  .setDescription('Manage vocal stims — trigger phrases the bot reacts to');

commandBuilder.addSubcommand((sc) => {
  sc.setName('add').setDescription('Create a new stim for this server');
  sc.addStringOption(nameOption('Unique name for this stim'));
  sc.addStringOption(stringOption('match_type', 'How the trigger phrase is matched',
    { required: true, choices: MATCH_TYPE_CHOICES }));
  sc.addStringOption(stringOption('pattern', 'Trigger phrase or regex pattern',
    { required: true, maxLength: 500 }));
  sc.addStringOption(stringOption('cooldown_seconds',
    'Minimum seconds between firings in a channel (default 3)'));
  return responseOptions(sc);
});

commandBuilder.addSubcommand((sc) => {
  sc.setName('edit').setDescription('Edit an existing stim — only the options you pass change');
  sc.addStringOption(nameOption('Name of the stim to edit', { autocomplete: true }));
  sc.addStringOption(stringOption('match_type', 'New match type',
    { choices: MATCH_TYPES.map((t) => ({ name: t, value: t })) }));
  sc.addStringOption(stringOption('pattern', 'New trigger phrase or regex pattern', { maxLength: 500 }));
  sc.addStringOption(stringOption('cooldown_seconds', 'New cooldown in seconds'));
  return responseOptions(sc);
});

commandBuilder.addSubcommand((sc) => {
  sc.setName('delete').setDescription('Delete a stim');
  sc.addStringOption(nameOption('Name of the stim to delete', { autocomplete: true }));
  return sc;
});
commandBuilder.addSubcommand((sc) => sc.setName('list').setDescription('List the stims in this server'));
commandBuilder.addSubcommand((sc) => {
  sc.setName('show').setDescription('Show the full config of a stim');
  sc.addStringOption(nameOption('Name of the stim to show', { autocomplete: true }));
  return sc;
});
commandBuilder.addSubcommand((sc) => {
  sc.setName('test').setDescription('Preview what a stim replies — only you see it');
  sc.addStringOption(nameOption('Name of the stim to test', { autocomplete: true }));
  sc.addStringOption(stringOption('message', 'A pretend chat message to run against the stim',
    { required: true, maxLength: 500 }));
  return sc;
});

const commandDefinition = commandBuilder.toJSON();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function reply(interaction, payload) {
  return interaction.reply({ ...payload, flags: EPHEMERAL });
}

function replyError(interaction, message) {
  return reply(interaction, { content: `⚠️ ${message}`, embeds: [], files: [] });
}

async function saveMedia(attachment, guildId) {
  if (!attachment.contentType?.startsWith('image/')) {
    throw new CommandError('The image attachment must be an image or GIF.');
  }
  if (attachment.size > MAX_IMAGE_BYTES) {
    throw new CommandError('Images must be 8 MB or smaller.');
  }
  const dir = path.join(MEDIA_DIR, String(guildId));
  await fsp.mkdir(dir, { recursive: true });
  const safe = attachment.name.replace(/[^\w.-]+/g, '_').match(/[\w.-]{1,64}$/)?.[0] ?? 'image';
  const fileName = `${Date.now()}-${randomBytes(4).toString('hex')}-${safe}`;
  const res = await fetch(attachment.url);
  if (!res.ok) throw new CommandError('Could not download the attached image.');
  await fsp.writeFile(path.join(dir, fileName), Buffer.from(await res.arrayBuffer()));
  // Path relative to the project root — this is what gets stored in the config.
  return { file: path.join('media', String(guildId), fileName) };
}

// Builds the single response object a stim replies with, from the command
// options plus (for /stim edit) the existing response. Provided options win.
async function responseFromOptions(options, existing, guildId) {
  const r = {};
  const content = options.getString('content');
  const attachment = options.getAttachment('image');
  const imageUrl = options.getString('image_url');
  const embedTitle = options.getString('embed_title');
  const embedDescription = options.getString('embed_description');
  const embedUrl = options.getString('embed_url');
  const reply = options.getBoolean('reply');

  const provided = {
    content: content !== null,
    image: attachment !== null || imageUrl !== null,
    embed: embedTitle !== null || embedDescription !== null || embedUrl !== null,
  };
  if (!provided.content && !provided.image && !provided.embed && !existing) {
    throw new CommandError('Add something for the bot to send: content, an image, or embed fields.');
  }

  if (provided.content || existing?.content) {
    r.content = content ?? existing?.content;
  }

  let image;
  if (attachment) image = await saveMedia(attachment, guildId);
  else if (imageUrl !== null) image = imageUrl;
  else image = existing?.image ?? null;

  const src = existing?.embed ?? {};
  const embed = {};
  if (embedTitle ?? src.title) embed.title = embedTitle ?? src.title;
  if (embedDescription ?? src.description) embed.description = embedDescription ?? src.description;
  if (embedUrl ?? src.url) embed.url = embedUrl ?? src.url;
  const hadEmbed = Object.keys(src).length > 0;

  if (Object.keys(embed).length > 0 || (image && hadEmbed)) {
    // Image lives inside the embed (gifs render inline there).
    if (image) embed.image = image;
    r.embed = embed;
  } else if (image) {
    r.image = image;
  }

  if (reply === false) r.reply = false;

  if (!r.content && !r.embed && !r.image) {
    throw new CommandError('The stim would send nothing — add content, an image, or embed fields.');
  }
  return r;
}

function matchSummary(trigger) {
  const m = typeof trigger.match === 'string'
    ? { type: 'contains', pattern: trigger.match }
    : trigger.match;
  return `\`${m.type}\` — \`${m.pattern.slice(0, 200)}\``;
}

function responseSummary(r, i) {
  if (typeof r === 'string') return `${i}. text: ${r.slice(0, 100)}`;
  const parts = [];
  if (r.content) parts.push(`text: "${r.content.slice(0, 100)}"`);
  if (r.image) {
    parts.push(typeof r.image === 'string' ? `image: ${r.image}` : `image: uploaded (\`${r.image.file}\`)`);
  }
  if (r.embed) {
    if (r.embed.title) parts.push(`embed: "${r.embed.title}"`);
    if (r.embed.description) parts.push(`description: "${r.embed.description.slice(0, 80)}"`);
    if (r.embed.url) parts.push(`link: ${r.embed.url}`);
  }
  if (r.reply === false) parts.push('standalone (no reply)');
  return `${i}. ${parts.join(' · ')}`;
}

function renderTriggerEmbed(trigger) {
  const responses = Array.isArray(trigger.responses) ? trigger.responses : [trigger.responses];
  const embed = new EmbedBuilder()
    .setTitle(`Stim: ${trigger.name}`)
    .setColor(0x5865f2)
    .addFields(
      { name: 'Match', value: matchSummary(trigger) },
      {
        name: `Responses (${responses.length})`,
        value: responses
          .slice(0, 10)
          .map((r, i) => responseSummary(r, i + 1))
          .join('\n')
          .slice(0, 1024) || '—',
      },
    );
  const meta = [
    trigger.createdBy && `created by ${trigger.createdBy}`,
    trigger.updatedBy && `last edited by ${trigger.updatedBy}`,
  ].filter(Boolean).join(' · ');
  if (meta) embed.setFooter({ text: meta });
  return embed;
}

function getTriggerOr404(interaction) {
  const name = interaction.options.getString('name', true).trim();
  const trigger = store.findTrigger(interaction.guildId, name);
  if (!trigger) {
    throw new CommandError(`No stim named "${name}" — try /stim list.`);
  }
  return trigger;
}

function parseCooldown(interaction) {
  const raw = interaction.options.getString('cooldown_seconds');
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 86400) {
    throw new CommandError('cooldown_seconds must be a number between 0 and 86400.');
  }
  return n;
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

async function handleAdd(interaction) {
  const name = interaction.options.getString('name', true).trim();
  const trigger = {
    name,
    match: {
      type: interaction.options.getString('match_type', true),
      pattern: interaction.options.getString('pattern', true),
    },
    responses: [await responseFromOptions(interaction.options, null, interaction.guildId)],
    createdBy: interaction.user.tag,
    createdAt: new Date().toISOString(),
  };
  const cooldown = parseCooldown(interaction);
  if (cooldown !== undefined) trigger.cooldownSeconds = cooldown;

  const { ok, errors } = validateTrigger(trigger);
  if (!ok) throw new CommandError(`Validation failed:\n- ${errors.join('\n- ')}`);

  await store.addTrigger(interaction.guildId, trigger);
  await reply(interaction, {
    content: `✅ Stim **${name}** created. It's live immediately.`,
    embeds: [renderTriggerEmbed(trigger)],
  });
}

async function handleEdit(interaction) {
  const existing = getTriggerOr404(interaction);
  const next = structuredClone(existing);

  const matchType = interaction.options.getString('match_type');
  const pattern = interaction.options.getString('pattern');
  if (matchType !== null || pattern !== null) {
    const prev = typeof next.match === 'string'
      ? { type: 'contains', pattern: next.match }
      : next.match;
    next.match = {
      type: matchType ?? prev.type,
      pattern: pattern ?? prev.pattern,
    };
  }

  const touchedResponseOption = ['content', 'image', 'image_url', 'embed_title', 'embed_description', 'embed_url', 'reply']
    .some((n) => interaction.options.get(n)?.value != null);
  if (touchedResponseOption) {
    // Rebuild only the first response; extra variants (hand-edited in the JSON)
    // must survive the edit untouched.
    next.responses = [
      await responseFromOptions(interaction.options, existing.responses[0], interaction.guildId),
      ...existing.responses.slice(1),
    ];
  }

  const cooldown = parseCooldown(interaction);
  if (cooldown !== undefined) next.cooldownSeconds = cooldown;

  next.updatedBy = interaction.user.tag;
  next.updatedAt = new Date().toISOString();

  const { ok, errors } = validateTrigger(next);
  if (!ok) throw new CommandError(`Validation failed:\n- ${errors.join('\n- ')}`);

  await store.replaceTrigger(interaction.guildId, existing.name, next);
  await reply(interaction, {
    content: `✅ Stim **${existing.name}** updated.`,
    embeds: [renderTriggerEmbed(next)],
  });
}

async function handleDelete(interaction) {
  const trigger = getTriggerOr404(interaction);
  await store.deleteTrigger(interaction.guildId, trigger.name);
  await reply(interaction, { content: `🗑️ Stim **${trigger.name}** deleted.` });
}

async function handleList(interaction) {
  const triggers = store.getTriggersForGuild(interaction.guildId);
  if (triggers.length === 0) {
    return reply(interaction, {
      content: 'No stims in this server yet — create one with `/stim add`.',
    });
  }
  const embed = new EmbedBuilder()
    .setTitle(`Vocal stims (${triggers.length})`)
    .setColor(0x5865f2)
    .addFields(
      triggers.slice(0, 25).map((t) => ({
        name: t.name,
        value: matchSummary(t).slice(0, 1024),
      })),
    );
  if (triggers.length > 25) {
    embed.setFooter({ text: `…and ${triggers.length - 25} more` });
  }
  await reply(interaction, { embeds: [embed] });
}

async function handleShow(interaction) {
  const trigger = getTriggerOr404(interaction);
  await reply(interaction, { embeds: [renderTriggerEmbed(trigger)] });
}

async function handleTest(interaction) {
  const trigger = getTriggerOr404(interaction);
  const responses = Array.isArray(trigger.responses) ? trigger.responses : [trigger.responses];
  const chosen = trigger.pick === 'all'
    ? responses
    : [responses[Math.floor(Math.random() * responses.length)]];

  // Synthetic "message" so placeholders resolve like a real firing would.
  const synthetic = {
    author: interaction.user,
    channel: interaction.channel,
    guild: interaction.guild,
    content: interaction.options.getString('message', true),
  };

  const payload = { content: '', embeds: [], files: [] };
  for (const response of chosen) {
    const built = buildPayload(response, synthetic);
    if (built.content) payload.content += (payload.content ? '\n' : '') + built.content;
    if (built.embeds) payload.embeds.push(...built.embeds.slice(0, 10 - payload.embeds.length));
    if (built.files) payload.files.push(...built.files.slice(0, 10 - payload.files.length));
  }
  if (!payload.content && payload.embeds.length === 0 && payload.files.length === 0) {
    return reply(interaction, { content: 'This stim is configured to send nothing.' });
  }
  await reply(interaction, {
    content: payload.content || undefined,
    embeds: payload.embeds.length > 0 ? payload.embeds : undefined,
    files: payload.files.length > 0 ? payload.files : undefined,
  });
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const handlers = {
  add: handleAdd,
  edit: handleEdit,
  delete: handleDelete,
  list: handleList,
  show: handleShow,
  test: handleTest,
};

async function handleInteraction(interaction) {
  if (!interaction.inGuild()) {
    return replyError(interaction, 'Use this command inside a server — stims are per-server.');
  }
  const handler = handlers[interaction.options.getSubcommand()];
  if (!handler) return;

  try {
    await handler(interaction);
  } catch (err) {
    if (err instanceof CommandError) {
      console.log(`[stim] rejected: ${err.message.split('\n')[0]}`);
      await replyError(interaction, err.message);
    } else {
      console.error('[stim] command failed:', err);
      await replyError(interaction, 'Something went wrong running that command. Check the bot logs.');
    }
  }
}

async function handleAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'name' || !interaction.guildId) {
    return interaction.respond([]);
  }
  const needle = focused.value.toLowerCase();
  await interaction.respond(
    store
      .getTriggersForGuild(interaction.guildId)
      .filter((t) => t.name.toLowerCase().includes(needle))
      .slice(0, 25)
      .map((t) => ({ name: t.name, value: t.name })),
  );
}

module.exports = { commandDefinition, handleInteraction, handleAutocomplete };
