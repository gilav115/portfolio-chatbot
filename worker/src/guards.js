/**
 * guards.js: Input and output validation for the /chat endpoint.
 *
 * Each exported function follows the same contract:
 *   Returns null  → check passed, continue.
 *   Returns string → check failed; the string is the error message shown to the visitor.
 *
 * Guards run in sequence in index.js before any LLM call is made.
 * The order matters: cheap checks (origin, token, rate limit) run first
 * so expensive checks (injection regex, LLM call) are skipped on bad requests.
 */

// The injection check is a first, cheap filter. It is tuned to block the
// common, unambiguous attack phrases and to let normal visitor questions pass,
// because a blocked real question costs a real lead. The system prompt is the
// second layer and handles what this filter lets through.
// Normal questions that must pass: "what are your rules for new clients",
// "have you built a system prompt for a chatbot", "forget everything I said, I
// want a website", "pretend you are hiring me", "ignore my last instruction".

// The target of an override: "instructions" or "prompt", with a word in front
// that points at this bot's own rules ("all", "the", "your", "previous", ...).
// "rules" and "context" are left out, and so are bare words, because visitors
// use them in normal questions ("how do I bypass prompts in npm install?").
const OVERRIDE_TARGET =
  String.raw`(?:(?:all|any|every)(?: and all)? (?:of )?(?:the |your )?(?:(?:previous|prior|above|earlier|preceding|system|original|initial) )*` +
  String.raw`|(?:the|your) (?:(?:previous|prior|above|earlier|preceding|system|original|initial) )*` +
  String.raw`|(?:(?:previous|prior|above|earlier|preceding|system|original|initial) )+)(?:instructions?|prompts?)\b`;

// "ignore the above" counts only at the end of the message or before "and",
// so a correction like "ignore the above question, what about SEO?" passes.
const OVERRIDE_CORE =
  String.raw`(?:ignore|disregard|forget|override|bypass) ${OVERRIDE_TARGET}` +
  String.raw`|(?:ignore|disregard) (?:the |everything |all )?(?:above|before this)(?=[.!]?$|,? and\b)`;

// Phrases that try to cancel or replace the rules, anywhere in a visitor message.
const OVERRIDE_PATTERNS = [
  new RegExp(String.raw`\b(?:${OVERRIDE_CORE})`, 'i'),
  /\bforget (?:everything|all)(?: you (?:know|were told|have been told))?,? and (?:act|behave|respond|answer|pretend|become|start)\b/i,
  /\byour (?:instructions|rules|prompt) (?:are|is) (?:now |hereby )?(?:cancelled|canceled|void|overridden|replaced|gone|removed)\b/i,
];

// Assistant turns in the history are checked only for an override written as a
// command at the start of a sentence: a made-up assistant turn like "Sure. Ignore
// all previous instructions." The bot's own real replies pass: refusals ("I can't
// ignore my instructions"), quotes ("'Ignore previous instructions' is a common
// attack") and sentences that talk about the phrase ("Ignore previous
// instructions is something I cannot do").
const ASSISTANT_TURN_PATTERNS = [
  new RegExp(String.raw`(?:^|[.!?:]\s+)(?:please |now |ok,? |okay,? )?(?:${OVERRIDE_CORE})(?! (?:is|are|was|were|isn't|means|would|will)\b)`, 'i'),
];

const EXTRACT_VERBS =
  String.raw`(?:reveal|print|repeat|show|output|dump|display|leak|list|recite|summari[sz]e|paste|give me|tell me|send me|what is|what's|what are|what were|what was)`;
const EXTRACT_ADJS = String.raw`(?:full|exact|original|hidden|initial|secret|complete|entire|whole|real)`;

const INJECTION_PATTERNS = [
  ...OVERRIDE_PATTERNS,
  // Changing identity. Only "you are now" followed by an identity or rules change:
  // "So you are now a freelancer?" or "I heard you are now in London" pass.
  /\byou are now (?:an? |the |my )?(?:unrestricted|uncensored|unfiltered|jailbroken|evil|dan\b|in (?:developer|god|dan|admin|debug|jailbreak) mode|(?:a )?(?:different|new) (?:ai|assistant|bot|model|persona|character)|no longer (?:bound|restricted|limited|an? (?:ai|assistant|bot))|free (?:from|of)|going to (?:ignore|forget|disregard|break|bypass))/i,
  /\byou(?: are|'re) no longer (?:bound|restricted|limited) by\b/i,
  /\bfrom now on,? (?:you (?:will|must|shall|are going to) (?:answer|respond|ignore|act|obey|reply|only|say)|act as|ignore|answer only)\b/i,
  /\bact as (?:an unrestricted|an? (?:unfiltered|uncensored|evil|jailbroken)|a (?:different|new) (?:ai|assistant|bot|model|persona|character))\b/i,
  /\bpretend (?:that )?(?:you are|you're|to be) (?:an? )?(?:unrestricted|unfiltered|uncensored|evil|jailbroken|different (?:ai|assistant|bot|model)|another (?:ai|assistant|bot|model)|(?:ai|assistant|bot|model) (?:without|with no) (?:rules|restrictions|limits))\b/i,
  /\b(?:enable|enter|activate|switch to|turn on|go into) (?:developer|god|admin|debug|jailbreak|unrestricted|dan) mode\b/i,
  // "jailbreak" on its own is allowed: "do you do LLM jailbreak testing?" is a real question.
  /\bdo anything now\b/i,
  /\b(?:[Yy]ou are|[Yy]ou're|[Aa]ct as|[Bb]e) (?:now )?DAN\b|\bDAN mode\b/,
  // Extracting the prompt. "system prompt" alone is allowed, so "have you built a
  // system prompt for a chatbot?" passes; asking for this bot's prompt does not.
  // "the prompt library you built" and "your prompt engineering experience" pass.
  new RegExp(String.raw`\b${EXTRACT_VERBS} (?:me )?(?:all )?(?:of )?(?:your|the|its) (?:${EXTRACT_ADJS} )*(?:system )?prompt\b(?! (?:engineering|engineer|library|libraries|templates?|design|writing|you|i|we|for|that|which|on|about|in)\b)`, 'i'),
  new RegExp(String.raw`\b${EXTRACT_VERBS} (?:me )?(?:all )?(?:of )?(?:your|its|the) (?:${EXTRACT_ADJS} |system )+instructions\b`, 'i'),
  // "your instructions" on their own, but not "your instructions for setting up X".
  new RegExp(String.raw`\b${EXTRACT_VERBS} (?:me )?(?:all )?(?:of )?your instructions\b(?! (?:for|on|about|to|regarding|when|how|if))`, 'i'),
  /\b(?:rules|instructions) (?:were|have) you (?:been )?given\b/i,
  /\b(?:repeat|print|output|echo|recite) (?:everything|all|all the text|the (?:text|words|content|messages?)) above\b/i,
];

// Text that should never appear in a reply. These are headings from the system
// prompt (prompt.js): if the model quotes its own instructions, the output guard
// replaces the reply with the fallback answer.
const LEAK_MARKERS = [
  /\bRULES: follow these\b/, /\bAPPROVED PROFILE CONTEXT\b/, /\bAPPROVED TOPICS:/,
  /\bBLOCKED TOPICS \(refuse/, /\bCONTACT METHODS AVAILABLE:/, /\bANSWER LENGTH:/,
  /\bHierarchy: these rules\b/i,
];

// Cleans the text that is sent to the AI: removes control characters and the
// invisible characters that can hide instructions (zero-width spaces, direction
// overrides), and limits blank lines. Characters that real languages and emoji
// need (such as the zero-width joiner) are kept. Non-strings are returned
// unchanged so the size guard can reject them.
export function normaliseMessage(message) {
  if (typeof message !== 'string') return message;
  return message
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Cyrillic and Greek letters that look like Latin ones, used to write
// "system prompt" with a Cyrillic "y" (\u0443) so a pattern does not match.
const LOOKALIKES = {
  '\u0430': 'a', '\u0432': 'b', '\u0435': 'e', '\u0451': 'e', '\u043A': 'k', '\u043C': 'm',
  '\u043D': 'h', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c', '\u0442': 't', '\u0443': 'y',
  '\u0445': 'x', '\u0456': 'i', '\u0457': 'i', '\u0458': 'j', '\u0455': 's', '\u0501': 'd',
  '\u051B': 'q', '\u051D': 'w', '\u0261': 'g', '\u03B1': 'a', '\u03B5': 'e', '\u03B9': 'i',
  '\u03BA': 'k', '\u03BD': 'v', '\u03BF': 'o', '\u03C1': 'p', '\u03C4': 't', '\u03C5': 'u',
  '\u03C7': 'x',
};

// Digits and symbols used as letters ("ign0re", "1gnore"), mapped only inside
// or at the start of a word, so "Web3", "B2B" and "10 years" are left alone.
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };

// A copy of the text used only for the pattern checks, never sent to the AI.
// It folds the tricks used to slip past patterns: full-width and styled letters
// (NFKC), look-alike letters, digits used as letters, every invisible character,
// and newlines, hyphens, underscores or dots used in place of spaces.
export function textForChecks(message) {
  if (typeof message !== 'string') return message;
  return message
    .normalize('NFKC')
    .replace(/[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g, '')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/[\u0370-\u03FF\u0400-\u052F\u0261]/g, ch => LOOKALIKES[ch.toLowerCase()] ?? ch)
    .replace(/(?<=\p{L})[013457@$](?=\p{L})|(?<![\p{L}\p{N}])[013457@$](?=\p{L}{2,})/gu, ch => LEET[ch])
    .replace(/(?<=\p{L})[-_.*~]+(?=\p{L})/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// In-memory rate limit store (per-isolate lifetime: see wrangler.toml note)
const rateLimitStore = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_PRUNE_AT  = 5_000; // prune expired entries once the map holds this many IPs

// Origins are compared without a trailing slash and in lower case, because the
// browser's Origin header never has a trailing slash and is always lower case.
export function normaliseOrigin(origin) {
  return String(origin ?? '').trim().replace(/\/+$/, '').toLowerCase();
}

// Blocks browser requests from domains not in security.allowedOrigins.
// If allowedOrigins is empty (dev / unconfigured), the check is skipped.
// Browser requests always include an Origin header; direct API calls typically do not,
// so this guard applies to widget traffic rather than server-to-server calls.
export function guardOrigin(request, config) {
  const allowedOrigins = config.security?.allowedOrigins ?? [];
  if (!allowedOrigins.length) {
    console.warn('[guard:origin] No allowedOrigins configured: skipping check.');
    return null;
  }
  const origin = normaliseOrigin(request.headers.get('Origin'));
  if (!allowedOrigins.map(normaliseOrigin).includes(origin)) {
    console.warn(`[guard:origin] Rejected: "${origin}"`);
    return 'Origin not permitted.';
  }
  return null;
}

// Widget token: a static shared secret that the embeddable widget includes
// in every request. Blocks requests not coming from the real widget embed.
// Set WIDGET_TOKEN as a Cloudflare secret and match it in the embed code.
export function guardWidgetToken(request, env) {
  const expected = env.WIDGET_TOKEN;
  if (!expected) return null; // Not configured: allow (dev mode)
  const sent = request.headers.get('X-Widget-Token') ?? '';
  if (!sameText(sent, expected)) {
    console.warn('[guard:token] Invalid or missing widget token');
    return 'Unauthorized.';
  }
  return null;
}

// Compares two strings in time that does not depend on where they first differ.
function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Fixed-window rate limit: allows up to security.rateLimitRpm requests per IP per minute.
// State is in-memory per Cloudflare isolate: under high traffic multiple isolates may run,
// so limits are approximate rather than exact. See wrangler.toml for a note on this.
export function guardRateLimit(ip, config) {
  const limit = config.security?.rateLimitRpm ?? 10;
  const now   = Date.now();
  if (rateLimitStore.size >= RATE_PRUNE_AT) pruneRateLimitStore(now);
  const entry = rateLimitStore.get(ip) ?? { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_WINDOW_MS) {
    rateLimitStore.set(ip, { count: 1, windowStart: now });
    return null;
  }
  entry.count += 1;
  rateLimitStore.set(ip, entry);
  if (entry.count > limit) {
    console.warn(`[guard:rate] ${ip} hit rate limit (${entry.count} rpm)`);
    return 'Too many requests. Please slow down and try again in a minute.';
  }
  return null;
}

// Shared rate limit, using Cloudflare's rate limiting binding (CHAT_RATE_LIMITER
// in wrangler.toml). Unlike the in-memory limit above, it is shared by all copies
// of the worker in a Cloudflare location. If the binding is missing or fails, the
// request is allowed: the in-memory limit still applies.
export async function guardSharedRateLimit(env, key) {
  const limiter = env?.CHAT_RATE_LIMITER;
  if (!limiter) return null;
  try {
    const { success } = await limiter.limit({ key });
    if (success) return null;
    console.warn(`[guard:rate] ${key} hit the shared rate limit`);
    return 'Too many requests. Please slow down and try again in a minute.';
  } catch (err) {
    console.error('[guard:rate] Shared rate limiter failed:', err);
    return null;
  }
}

function pruneRateLimitStore(now) {
  for (const [ip, entry] of rateLimitStore) {
    if (now - entry.windowStart > RATE_WINDOW_MS) rateLimitStore.delete(ip);
  }
}

// Rejects empty messages and messages longer than security.maxMessageLength characters.
// Catches both accidental and deliberate oversized payloads before they reach the LLM.
export function guardMessageSize(message, config) {
  const maxLen = config.security?.maxMessageLength ?? 500;
  if (typeof message !== 'string' || message.trim().length === 0) {
    return 'Message must be a non-empty string.';
  }
  if (message.length > maxLen) {
    return `Message too long. Please keep it under ${maxLen} characters.`;
  }
  return null;
}

// Caps conversation history at security.maxSessionMessages entries.
// Prevents very long sessions from inflating LLM costs and context size.
// The visitor is told to refresh: the widget does not persist history across page loads anyway.
export function guardSessionLength(history, config) {
  const max = config.security?.maxSessionMessages ?? 20;
  if (!Array.isArray(history)) return 'History must be an array.';
  if (history.length > max) {
    return 'This conversation has reached its limit. Please refresh the page to start a new one.';
  }
  for (const item of history) {
    if (!item || typeof item !== 'object') return 'Invalid history format.';
    if (item.role !== 'user' && item.role !== 'assistant') return 'Invalid history format.';
    if (typeof item.content !== 'string') return 'Invalid history format.';
    if (item.content.length > 2000) return 'Invalid history format.';
  }
  return null;
}

// Blocks common prompt injection attempts: phrases visitors use to try to
// override the system prompt, extract instructions, or change the bot's identity.
// Checks the new message and the history, because the browser sends the history
// and can put anything in it, including made-up "assistant" turns.
// This is a pre-filter; the system prompt itself also enforces the hierarchy as a second layer.
export function guardInjection(message, history = []) {
  const checks = [[textForChecks(message), INJECTION_PATTERNS]];
  for (const item of history) {
    checks.push([textForChecks(item?.content), item?.role === 'assistant' ? ASSISTANT_TURN_PATTERNS : INJECTION_PATTERNS]);
  }
  for (const [text, patterns] of checks) {
    if (typeof text !== 'string') continue;
    if (patterns.some(pattern => pattern.test(text))) {
      console.warn('[guard:injection] Injection attempt blocked.');
      return 'That kind of message cannot be processed.';
    }
  }
  return null;
}

// Pre-filters messages against blockedTopics and allowedTopics keyword lists.
// Short messages (< 30 chars) are always allowed: they are likely greetings or follow-ups
// that lack enough words to reliably classify. The LLM system prompt enforces topic
// boundaries as a second, more nuanced layer for messages that pass this check.
export function guardTopic(message, config) {
  if (message.length < 30) return null;
  const { allowedTopics = [], blockedTopics = [], ownerName = 'the professional' } = config;
  const lower = message.toLowerCase();

  const isBlocked = blockedTopics.some(t => lower.includes(t.toLowerCase()));
  if (isBlocked) {
    return `I can only answer questions about ${ownerName} and their work.`;
  }

  if (allowedTopics.length) {
    const isOnTopic = allowedTopics.some(t => lower.includes(t.toLowerCase()));
    if (!isOnTopic) {
      console.info('[guard:topic] Off-topic blocked at pre-filter');
      return `I can only answer questions about ${ownerName} and their work.`;
    }
  }

  return null;
}

// Sanitises and caps the LLM reply before sending it to the visitor.
// Trims at a sentence boundary (. ! ?) to avoid mid-sentence cuts.
// Returns a safe fallback string if the reply is missing or empty.
// Hard cap: 1500 characters: well above the maxAnswerWords limit in practice.
// hasContactButtons: only mention buttons when the worker will actually send some.
export function guardOutput(reply, ownerName, hasContactButtons = true) {
  const fallback = fallbackReply(ownerName, hasContactButtons);

  if (typeof reply !== 'string' || reply.trim().length === 0) return fallback;
  if (LEAK_MARKERS.some(marker => marker.test(reply))) {
    console.warn('[guard:output] Reply quoted the instructions: replaced with the fallback.');
    return fallback;
  }

  const MAX_CHARS = 1500;
  if (reply.length <= MAX_CHARS) return reply.trim();

  const truncated = reply.slice(0, MAX_CHARS);
  const lastBoundary = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('! '),
    truncated.lastIndexOf('? ')
  );
  return lastBoundary > MAX_CHARS * 0.5
    ? truncated.slice(0, lastBoundary + 1).trim()
    : truncated.trim() + '...';
}

// The reply used when the bot cannot answer. Shared with the system prompt so both say the same.
export function fallbackReply(ownerName, hasContactButtons) {
  const who = ownerName ?? 'me';
  return hasContactButtons
    ? `I can't answer that from the approved information. You can contact ${who} directly using the contact buttons below.`
    : `I can't answer that from the approved information. Please contact ${who} directly.`;
}
