/**
 * demo/registry.js: looks up demos from the generated bundle.
 *
 * The bundle (worker/src/demo/bundle.generated.js) is written by
 * scripts/demo-build.js from the gitignored setup/demos/ folder. Its shape:
 *
 *   {
 *     "<slug>": {
 *       slug, business, bot, branding, links, limits, demo, llm,
 *       passwordHash, passwordSalt, knowledge, logoDataUri
 *     }
 *   }
 *
 * Only the fields under publicConfig() are ever sent to a browser, and only
 * after the password has been accepted.
 */

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/;

export const DEFAULT_LIMITS = {
  maxMessages:      15,   // visitor messages per conversation
  maxMessageLength: 400,  // characters per visitor message
  rateLimitRpm:     8,    // chat requests per visitor per minute
  dailyMessageCap:  300,  // chat requests per demo per day (all visitors)
  sessionHours:     2,    // token lifetime
};

export function isValidSlug(slug) {
  return typeof slug === 'string' && SLUG_PATTERN.test(slug);
}

export function getDemo(bundle, slug) {
  if (!isValidSlug(slug)) return null;
  const demo = bundle?.[slug];
  if (!demo || typeof demo !== 'object') return null;
  return { ...demo, limits: { ...DEFAULT_LIMITS, ...(demo.limits ?? {}) } };
}

// The part of a demo the browser is allowed to see once authenticated.
// No password material, no knowledge, no model settings.
export function publicConfig(demo) {
  const bot = demo.bot ?? {};
  return {
    slug:               demo.slug,
    businessName:       demo.business?.name ?? '',
    botName:            bot.name ?? `${demo.business?.name ?? 'Our'} assistant`,
    welcomeMessage:     bot.welcomeMessage ?? `Hi, I'm the ${demo.business?.name ?? ''} assistant. How can I help?`,
    suggestedQuestions: Array.isArray(bot.suggestedQuestions) ? bot.suggestedQuestions.slice(0, 6) : [],
    inputPlaceholder:   bot.inputPlaceholder ?? 'Ask about the menu, opening hours, or anything else',
    branding:           demo.branding ?? {},
    logoDataUri:        demo.logoDataUri ?? null,
    builtBy:            demo.demo?.builtBy ?? 'Square Numbers',
    builderSite:        demo.demo?.builderSite ?? 'https://squarenumbers.co.uk',
    limits: {
      maxMessages:      demo.limits.maxMessages,
      maxMessageLength: demo.limits.maxMessageLength,
    },
  };
}

// Converts the demo's limits into the shape the shared guards expect.
export function guardConfigFor(demo) {
  const name = demo.business?.name ?? 'the business';
  return {
    ownerName:     name,
    blockedTopics: demo.blockedTopics ?? [],
    security: {
      maxMessageLength:   demo.limits.maxMessageLength,
      rateLimitRpm:       demo.limits.rateLimitRpm,
      // history holds user+assistant pairs for every earlier visitor message
      maxSessionMessages: (demo.limits.maxMessages - 1) * 2,
    },
  };
}
