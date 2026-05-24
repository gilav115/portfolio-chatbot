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
  leadCapture: { enabled: false, trigger: 'on_intent' },
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
  _config = deepMerge(DEFAULTS, parsed);
  return _config;
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
