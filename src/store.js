'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { validateTrigger } = require('./triggers');

const DEFAULT_PATH = path.join(__dirname, '..', 'config', 'triggers.json');

function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('config must be an object');
  }
  if (raw.cooldownSeconds != null &&
      (!Number.isFinite(raw.cooldownSeconds) || raw.cooldownSeconds < 0 || raw.cooldownSeconds > 86400)) {
    throw new Error('cooldownSeconds must be between 0 and 86400');
  }
  if (raw.triggers != null && !Array.isArray(raw.triggers)) {
    throw new Error('legacy triggers must be an array');
  }
  if (raw.defaults != null && !Array.isArray(raw.defaults)) {
    throw new Error('defaults must be an array');
  }
  if (raw.guilds != null && (typeof raw.guilds !== 'object' || raw.guilds === null || Array.isArray(raw.guilds))) {
    throw new Error('guilds must be an object');
  }
  if (raw.triggers == null && raw.defaults == null && raw.guilds == null) {
    throw new Error('config must contain triggers, defaults, or guilds');
  }

  const config = {
    cooldownSeconds: raw.cooldownSeconds ?? 3,
    defaults: raw.defaults ?? raw.triggers ?? [],
    guilds: raw.guilds ?? {},
  };

  function checkTriggers(triggers, label) {
    if (!Array.isArray(triggers)) throw new Error(`${label}.triggers must be an array`);
    const names = new Set();
    for (const trigger of triggers) {
      const { ok, errors } = validateTrigger(trigger);
      if (!ok) throw new Error(`${label}: ${errors.join('; ')}`);
      const key = trigger.name.toLowerCase();
      if (names.has(key)) throw new Error(`${label}: duplicate stim name "${trigger.name}"`);
      names.add(key);
    }
  }

  checkTriggers(config.defaults, 'defaults');
  for (const [id, entry] of Object.entries(config.guilds)) {
    if (!/^\d{15,22}$/.test(id)) throw new Error(`invalid guild ID: ${id}`);
    checkTriggers(entry?.triggers, `guild ${id}`);
    if (entry.hidden != null && (!Array.isArray(entry.hidden) ||
        entry.hidden.some((name) => typeof name !== 'string'))) {
      throw new Error(`guild ${id}.hidden must be an array of stim names`);
    }
  }
  return config;
}

function createStore(configPath = DEFAULT_PATH, { watch = true } = {}) {
  let config = { cooldownSeconds: 3, defaults: [], guilds: {} };
  let saveChain = Promise.resolve();
  let reloadTimer;
  let watcher;

  function load() {
    try {
      config = validateConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
      const count = Object.values(config.guilds).reduce((n, g) => n + g.triggers.length, 0);
      console.log(`[store] loaded ${count} server stim(s), ${config.defaults.length} default(s)`);
      return true;
    } catch (err) {
      console.error(`[store] config unavailable or invalid (${err.message}); keeping last-good config`);
      return false;
    }
  }

  function effectiveTriggers(source, guildId) {
    const guild = source.guilds[guildId];
    const local = guild?.triggers ?? [];
    const hidden = new Set((guild?.hidden ?? []).map((n) => n.toLowerCase()));
    const overridden = new Set(local.map((t) => t.name.toLowerCase()));
    return [
      ...local,
      ...source.defaults.filter((t) => !overridden.has(t.name.toLowerCase()) &&
        !hidden.has(t.name.toLowerCase())),
    ];
  }

  function persist(mutator) {
    const op = saveChain.then(async () => {
      const next = structuredClone(config);
      const result = mutator(next);
      validateConfig(next);
      const tmp = `${configPath}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
      try {
        await fsp.rename(tmp, configPath); // atomic replacement on the same filesystem
      } catch (err) {
        await fsp.rm(tmp, { force: true });
        throw err;
      }
      config = next; // do not expose a mutation that failed to persist
      return result;
    });
    // A rejected mutation must not block later ones.
    saveChain = op.catch(() => {});
    return op;
  }

  function getTriggersForGuild(guildId) {
    return effectiveTriggers(config, guildId);
  }

  function findTrigger(guildId, name) {
    return getTriggersForGuild(guildId).find((t) =>
      t.name.toLowerCase() === name.toLowerCase()) ?? null;
  }

  function addTrigger(guildId, trigger) {
    return persist((next) => {
      if (effectiveTriggers(next, guildId).some((t) => t.name.toLowerCase() === trigger.name.toLowerCase())) {
        throw new Error(`a stim named "${trigger.name}" already exists — try /stim edit or /stim list`);
      }
      const guild = (next.guilds[guildId] ??= { triggers: [], hidden: [] });
      guild.triggers.push(trigger);
    });
  }

  function replaceTrigger(guildId, name, newTrigger) {
    return persist((next) => {
      const guild = (next.guilds[guildId] ??= { triggers: [], hidden: [] });
      const index = guild.triggers.findIndex((t) => t.name.toLowerCase() === name.toLowerCase());
      if (index !== -1) {
        guild.triggers[index] = newTrigger;
      } else if (effectiveTriggers(next, guildId).some((t) => t.name.toLowerCase() === name.toLowerCase())) {
        guild.triggers.push(newTrigger); // local override of a built-in stim
      } else {
        throw new Error(`no stim named "${name}" — try /stim list`);
      }
    });
  }

  function deleteTrigger(guildId, name) {
    return persist((next) => {
      const guild = (next.guilds[guildId] ??= { triggers: [], hidden: [] });
      const index = guild.triggers.findIndex((t) => t.name.toLowerCase() === name.toLowerCase());
      let removed;
      if (index !== -1) {
        [removed] = guild.triggers.splice(index, 1);
      } else {
        removed = effectiveTriggers(next, guildId).find((t) => t.name.toLowerCase() === name.toLowerCase());
      }
      if (!removed) throw new Error(`no stim named "${name}" — try /stim list`);
      if (next.defaults.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
        (guild.hidden ??= []).push(name.toLowerCase());
      }
      return removed;
    });
  }

  load();
  if (watch) {
    // Watch the directory, not the file: atomic renames replace the file inode.
    watcher = fs.watch(path.dirname(configPath), (_event, file) => {
      if (file && String(file) !== path.basename(configPath)) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(load, 300);
    });
    watcher.on('error', (err) => console.error('[store] watcher error:', err));
  }

  return {
    load,
    getTriggersForGuild,
    findTrigger,
    addTrigger,
    replaceTrigger,
    deleteTrigger,
    getCooldownSeconds: () => config.cooldownSeconds,
    idle: () => saveChain,
    close: () => { clearTimeout(reloadTimer); watcher?.close(); },
  };
}

const store = createStore(process.env.STIM_CONFIG_PATH || DEFAULT_PATH);
module.exports = { ...store, createStore, validateConfig };
