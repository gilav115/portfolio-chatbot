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

const INJECTION_PATTERNS = [
  /ignore (previous|above|all) instructions/i,
  /\byou are now (?:an? )?(?:unrestricted|uncensored|unfiltered|jailbroken|evil|dan\b|in (?:developer|god|dan) mode|a different (?:ai|assistant|bot|model)|a new (?:ai|assistant|bot|model)|no longer)/i,
  /\bfrom now on,? (?:you are|you will|you must|act|respond)\b/i,
  /forget (everything|all|your instructions)/i,
  /\bsystem prompt\b/i,
  /reveal (your|the) (prompt|instructions|rules|context|knowledge)/i,
  /act as (a different|an unrestricted|a new)/i,
  /\bjailbreak\b/i,
  /pretend (you are|to be)/i,
  /override (your|the) (rules|instructions)/i,
  /disregard (your|the|previous)/i,
  /what (are|were) your instructions/i,
];

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
  if (sent !== expected) {
    console.warn('[guard:token] Invalid or missing widget token');
    return 'Unauthorized.';
  }
  return null;
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

// Assistant turns in the history are checked only for attempts to override the
// rules. The bot's own real replies can say things like "I can't share my system
// prompt", and that must not block the rest of the conversation.
const ASSISTANT_TURN_PATTERNS = [
  /ignore (previous|above|all) instructions/i,
  /forget (everything|all|your instructions)/i,
  /override (your|the) (rules|instructions)/i,
  /disregard (your|the|previous)/i,
];

// Blocks common prompt injection attempts: phrases visitors use to try to
// override the system prompt, extract instructions, or change the bot's identity.
// Checks the new message and the history, because the browser sends the history
// and can put anything in it, including made-up "assistant" turns.
// This is a pre-filter; the system prompt itself also enforces the hierarchy as a second layer.
export function guardInjection(message, history = []) {
  const checks = [[message, INJECTION_PATTERNS]];
  for (const item of history) {
    checks.push([item?.content, item?.role === 'assistant' ? ASSISTANT_TURN_PATTERNS : INJECTION_PATTERNS]);
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
