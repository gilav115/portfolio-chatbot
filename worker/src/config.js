/**
 * config.js: Loads and caches bot configuration for the worker isolate.
 *
 * Configuration is read from the BOT_CONFIG_JSON Cloudflare secret, which is set
 * by the build script from setup/config.json on your machine (gitignored).
 *
 * Any field not present in BOT_CONFIG_JSON falls back to the value in DEFAULTS below.
 * The merged config is cached in _config after the first call so JSON.parse only runs once.
 */

const DEFAULTS = {
  botName: 'Assistant',
  ownerName: 'the professional',
  tone: 'professional',
  maxAnswerWords: 80,
  historyTurns: 4,
  contactMethods: {},
  allowedTopics: [],
  blockedTopics: ['personal life', 'politics', 'medical advice', 'legal advice', 'financial advice'],
  security: {
    allowedOrigins: [],
    maxMessageLength: 500,
    rateLimitRpm: 10,
    maxSessionMessages: 20,
  },
  ui: {
    accentColor: '#0055ff',
    welcomeMessage: null,
    suggestedQuestions: [],
  },
  llm: {
    // provider: 'openai' uses the OpenAI Chat Completions API (default model: gpt-4o-mini)
    // provider: 'anthropic' uses the Anthropic Messages API (default model: claude-haiku-4-5-20251001)
    provider: 'openai',
    model: null, // null = use the provider's recommended default (see index.js)
  },
};

let _config = null;

// Returns the merged config object. Call this once at request time: subsequent calls
// return the cached object from the first parse.
export function getConfig(env) {
  if (_config) return _config;
  let parsed = {};
  if (env.BOT_CONFIG_JSON) {
    try {
      parsed = JSON.parse(env.BOT_CONFIG_JSON);
    } catch {
      console.error('[config] Invalid BOT_CONFIG_JSON: using defaults');
    }
  } else {
    console.warn('[config] BOT_CONFIG_JSON not set: using defaults. Run the build script to set it.');
  }
  _config = normalise(deepMerge(DEFAULTS, parsed));
  return _config;
}

// config.json is edited by hand, so fix the types the code relies on here, once,
// instead of crashing mid-request (for example a WhatsApp number typed without quotes).
function normalise(config) {
  const strings = (list) => (Array.isArray(list) ? list : [])
    .filter(x => typeof x === 'string' || typeof x === 'number')
    .map(x => String(x).trim())
    .filter(Boolean);

  const contact = config.contactMethods && typeof config.contactMethods === 'object' ? config.contactMethods : {};
  const contactMethods = {};
  for (const key of ['email', 'linkedin', 'whatsapp', 'sms', 'calendar', 'github']) {
    const value = contact[key];
    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value).trim();
      if (text) contactMethods[key] = text;
    }
  }
  contactMethods.custom = (Array.isArray(contact.custom) ? contact.custom : [])
    .filter(c => c && typeof c.label === 'string' && typeof c.href === 'string' && c.label.trim() && c.href.trim());

  return {
    ...config,
    contactMethods,
    allowedTopics: strings(config.allowedTopics),
    blockedTopics: strings(config.blockedTopics),
    security: {
      ...config.security,
      allowedOrigins: strings(config.security?.allowedOrigins),
    },
    ui: {
      ...config.ui,
      suggestedQuestions: strings(config.ui?.suggestedQuestions),
    },
  };
}

// Recursively merges override into base. Arrays are replaced (not concatenated)
// so a user's blockedTopics list fully replaces the default list rather than extending it.
function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override ?? {})) {
    if (
      override[key] !== null &&
      typeof override[key] === 'object' &&
      !Array.isArray(override[key])
    ) {
      result[key] = deepMerge(base[key] ?? {}, override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}
