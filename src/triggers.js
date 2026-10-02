'use strict';

const path = require('path');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');

const PROJECT_ROOT = path.join(__dirname, '..');

const MATCH_TYPES = ['exact', 'contains', 'startsWith', 'endsWith', 'regex'];

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function compileRegex(match) {
  return new RegExp(match.pattern, match.flags ?? 'i');
}

function matches(trigger, content) {
  const match = typeof trigger.match === 'string'
    ? { type: 'contains', pattern: trigger.match }
    : trigger.match;

  const text = content.trim();
  const pattern = match.pattern;

  switch (match.type) {
    case 'exact':
      return match.caseSensitive
        ? text === pattern
        : text.toLowerCase() === pattern.toLowerCase();
    case 'contains':
      return match.caseSensitive
        ? text.includes(pattern)
        : text.toLowerCase().includes(pattern.toLowerCase());
    case 'startsWith':
      return match.caseSensitive
        ? text.startsWith(pattern)
        : text.toLowerCase().startsWith(pattern.toLowerCase());
    case 'endsWith':
      return match.caseSensitive
        ? text.endsWith(pattern)
        : text.toLowerCase().endsWith(pattern.toLowerCase());
    case 'regex':
      return compileRegex(match).test(text);
    default:
      console.warn(`[config] trigger "${trigger.name}" has unknown match type "${match.type}"`);
      return false;
  }
}

// Optional per-trigger user restriction: when `users` is a nonempty array of
// user IDs, only those people can fire the stim; everyone else falls through.
function userAllowed(trigger, userId) {
  return !(Array.isArray(trigger.users) && trigger.users.length > 0
    && !trigger.users.includes(userId));
}

// ---------------------------------------------------------------------------
// Response building
// ---------------------------------------------------------------------------

// Simple placeholders usable in "content" and embed strings.
function interpolate(text, message) {
  if (typeof text !== 'string') return text;
  return text
    .replaceAll('{user}', `${message.author}`)
    .replaceAll('{username}', message.author.username)
    .replaceAll('{channel}', `${message.channel}`)
    .replaceAll('{server}', message.guild ? message.guild.name : 'DM')
    .replaceAll('{message}', message.content);
}

function buildEmbed(definition, message) {
  const d = typeof definition === 'string'
    ? { description: definition }
    : definition;

  const embed = new EmbedBuilder();
  if (d.title) embed.setTitle(interpolate(d.title, message));
  if (d.description) embed.setDescription(interpolate(d.description, message));
  if (d.url) embed.setURL(d.url);
  if (d.color) embed.setColor(d.color);
  if (d.image) embed.setImage(d.image);
  if (d.thumbnail) embed.setThumbnail(d.thumbnail);
  if (d.footer) embed.setFooter({ text: interpolate(d.footer, message) });
  if (typeof d.author === 'string' && d.author) embed.setAuthor({ name: interpolate(d.author, message) });
  if (Array.isArray(d.fields)) {
    embed.addFields(
      d.fields.slice(0, 25).map((f) => ({
        name: interpolate(f.name, message),
        value: interpolate(f.value, message),
        inline: !!f.inline,
      })),
    );
  }
  return embed;
}

// `image` accepts a URL string or { file: '<path relative to project root>' } for
// uploaded media — local files are attached to each response and referenced via
// attachment:// so they survive Discord's expiring CDN links.
function buildPayload(response, message) {
  if (typeof response === 'string') {
    return { content: interpolate(response, message) };
  }

  const payload = {};
  if (response.content) payload.content = interpolate(response.content, message);

  // Clone embed definitions — they live in the shared config object and must
  // not be mutated across firings.
  const embedDefs = [];
  if (response.embed) embedDefs.push(structuredClone(response.embed));
  if (Array.isArray(response.embeds)) {
    for (const e of response.embeds) embedDefs.push(structuredClone(e));
  }

  if (response.image) {
    if (!embedDefs[0]) embedDefs.push({});
    embedDefs[0].image = response.image;
  }

  const files = [];
  for (const embed of embedDefs) {
    for (const field of ['image', 'thumbnail']) {
      const media = embed[field];
      if (media && typeof media === 'object' && media.file) {
        const name = encodeURIComponent(path.basename(media.file));
        files.push(new AttachmentBuilder(path.join(PROJECT_ROOT, media.file), { name }));
        embed[field] = `attachment://${name}`;
      }
    }
  }

  if (embedDefs.length > 0) {
    payload.embeds = embedDefs.slice(0, 10).map((e) => buildEmbed(e, message));
  }

  if (Array.isArray(response.files)) {
    for (const f of response.files) {
      if (typeof f === 'string' && /^https?:\/\//i.test(f)) files.push(f);
      else if (typeof f === 'string') {
        files.push(new AttachmentBuilder(path.join(PROJECT_ROOT, f)));
      }
    }
  }

  if (files.length > 0) payload.files = files.slice(0, 10);

  return payload;
}

async function sendResponse(message, response) {
  const payload = buildPayload(response, message);
  if (!payload.content && !payload.embeds && !payload.files) return;

  if (response.reply === false) {
    await message.channel.send(payload);
  } else {
    await message.reply(payload);
  }
}

// ---------------------------------------------------------------------------
// Validation (shared by the store loader and the /stim commands)
// ---------------------------------------------------------------------------

function isHttpUrl(v) {
  return typeof v === 'string' && /^https:\/\/\S+$/i.test(v);
}

function validateImage(image, where, errors) {
  if (typeof image === 'string') {
    if (!isHttpUrl(image)) errors.push(`${where} must be an https URL`);
  } else if (image && typeof image === 'object' && typeof image.file === 'string' && image.file) {
    // uploaded media file — ok
  } else {
    errors.push(`${where} must be an https URL or an uploaded file`);
  }
}

function validateEmbed(e, where, errors) {
  if (typeof e !== 'object' || e === null || Array.isArray(e)) {
    errors.push(`${where} must be an object`);
    return;
  }
  if (e.title != null && (typeof e.title !== 'string' || e.title.length > 256)) {
    errors.push(`${where}.title must be a string of at most 256 characters`);
  }
  if (e.description != null && (typeof e.description !== 'string' || e.description.length > 4096)) {
    errors.push(`${where}.description must be at most 4096 characters`);
  }
  for (const key of ['url', 'image', 'thumbnail']) {
    if (e[key] != null) validateImage(e[key], `${where}.${key}`, errors);
  }
  if (e.footer != null && typeof e.footer !== 'string') {
    errors.push(`${where}.footer must be a string`);
  }
  if (e.fields != null) {
    if (!Array.isArray(e.fields) || e.fields.length > 25) {
      errors.push(`${where}.fields must be an array of at most 25 entries`);
    } else {
      e.fields.forEach((f, i) => {
        if (!f || typeof f.name !== 'string' || !f.name || f.name.length > 256) {
          errors.push(`${where}.fields[${i}].name must be 1-256 characters`);
        }
        if (!f || typeof f.value !== 'string' || !f.value || f.value.length > 1024) {
          errors.push(`${where}.fields[${i}].value must be 1-1024 characters`);
        }
      });
    }
  }
}

function validateResponse(r, where, errors) {
  if (typeof r === 'string') {
    if (!r.trim()) errors.push(`${where} is empty`);
    else if (r.length > 2000) errors.push(`${where} exceeds 2000 characters`);
    return;
  }
  if (typeof r !== 'object' || r === null || Array.isArray(r)) {
    errors.push(`${where} must be a string or an object`);
    return;
  }
  if (r.content != null) {
    if (typeof r.content !== 'string') errors.push(`${where}.content must be a string`);
    else if (r.content.length > 2000) errors.push(`${where}.content exceeds 2000 characters`);
  }
  if (r.image != null) validateImage(r.image, `${where}.image`, errors);
  if (r.reply != null && typeof r.reply !== 'boolean') {
    errors.push(`${where}.reply must be a boolean`);
  }
  if (r.files != null && !Array.isArray(r.files)) {
    errors.push(`${where}.files must be an array`);
  }

  const embeds = [...(r.embed ? [r.embed] : []), ...(Array.isArray(r.embeds) ? r.embeds : [])];
  if (embeds.length > 10) errors.push(`${where} has more than 10 embeds`);
  embeds.forEach((e, i) => validateEmbed(e, `${where}.embeds[${i}]`, errors));

  const hasSomething =
    (typeof r.content === 'string' && r.content.length > 0) ||
    r.embed || embeds.length > 0 || r.image ||
    (Array.isArray(r.files) && r.files.length > 0);
  if (!hasSomething) {
    errors.push(`${where} has nothing to send (add content, an embed, an image or files)`);
  }
}

function validateTrigger(trigger) {
  const errors = [];

  if (typeof trigger.name !== 'string' || !trigger.name.trim() || trigger.name.length > 100) {
    errors.push('name must be a string of 1-100 characters');
  }

  const m = trigger.match;
  if (typeof m === 'string') {
    if (!m) errors.push('match pattern must not be empty');
    else if (m.length > 500) errors.push('match pattern exceeds 500 characters');
  } else if (typeof m === 'object' && m !== null) {
    if (!MATCH_TYPES.includes(m.type)) {
      errors.push(`match.type must be one of: ${MATCH_TYPES.join(', ')}`);
    }
    if (typeof m.pattern !== 'string' || !m.pattern) {
      errors.push('match.pattern must be a non-empty string');
    } else if (m.pattern.length > 500) {
      errors.push('match.pattern exceeds 500 characters');
    } else if (m.type === 'regex') {
      try {
        compileRegex(m);
      } catch (err) {
        errors.push(`invalid regex: ${err.message}`);
      }
    }
  } else {
    errors.push('match must be a string or an object');
  }

  const responses = Array.isArray(trigger.responses)
    ? trigger.responses
    : trigger.responses != null
      ? [trigger.responses]
      : [];
  if (responses.length === 0) {
    errors.push('responses must contain at least one response');
  } else if (responses.length > 10) {
    errors.push('responses must contain at most 10 responses');
  }
  responses.forEach((r, i) => validateResponse(r, `responses[${i}]`, errors));

  if (trigger.cooldownSeconds != null) {
    if (typeof trigger.cooldownSeconds !== 'number' || trigger.cooldownSeconds < 0 || trigger.cooldownSeconds > 86400) {
      errors.push('cooldownSeconds must be a number between 0 and 86400');
    }
  }
  if (trigger.pick != null && trigger.pick !== 'all') {
    errors.push('pick must be "all" or omitted');
  }

  if (trigger.users != null) {
    if (!Array.isArray(trigger.users) || trigger.users.length > 25) {
      errors.push('users must be an array of at most 25 user IDs');
    } else {
      trigger.users.forEach((id, i) => {
        if (typeof id !== 'string' || !/^\d{15,22}$/.test(id)) {
          errors.push(`users[${i}] must be a Discord user ID (15-22 digits)`);
        }
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  MATCH_TYPES,
  compileRegex,
  matches,
  userAllowed,
  interpolate,
  buildEmbed,
  buildPayload,
  sendResponse,
  validateTrigger,
};
