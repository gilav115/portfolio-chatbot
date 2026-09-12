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

// Each pattern is a phrase people actually type when trying to override or
// extract the prompt. They are deliberately specific: a customer asking "can
// you ignore the onions" or "what are your opening rules" must never match.
const INJECTION_PATTERNS = [
  // Overriding the rules
  /\bignore (the |all |any |your )?(previous|above|prior|earlier|all|these|your|my) (instructions|rules|prompts?|guidelines|directions)\b/i,
  /\b(forget|disregard|discard|bypass|override|overrule) (everything|all( of)? (your|the|previous|prior|above)|(the |your |all |any |previous |prior |above |earlier |system |hidden |original )+(instructions|rules|prompts?|guidelines|context|training|programming))\b/i,
  /\byou are now (a|an|the|my|in|going)\b/i,
  /\bfrom now on,? (you|act|behave|respond|pretend|ignore|answer)\b/i,
  /\byour (instructions|rules|prompt) (are|is) (now|cancelled|void|overridden|replaced)\b/i,
  /\b(new|updated|revised|real|true) (instructions|persona|identity|system prompt)\b/i,
  // Extracting the prompt
  /\b(system|developer|hidden|secret|initial|original|internal) (prompt|instructions?|message|directives?)\b/i,
  /\b(reveal|show|print|display|output|repeat|recite|dump|leak|paste|tell me|give me|send me|what (is|was)) (me )?(your|the|its)( (full|complete|entire|exact|hidden|secret|system|initial|original|above|previous))? ?(prompt|instructions?|context window|knowledge base|configuration|config|directives?|training data)\b/i,
  /\bwhat (are|were) your (instructions|directives|guidelines)\b/i,
  /\b(repeat|print|output|echo) (the|all|everything)( (text|words|content))? (above|before|prior)\b/i,
  /\b(translate|encode|write|output|repeat) (your|the) (instructions|prompt) (in|into|as|to)\b/i,
  /\bbase64\b.*\b(prompt|instructions)\b|\b(prompt|instructions)\b.*\bbase64\b/i,
  // Changing identity
  /\bact as (a different|an unrestricted|a new|an? (unfiltered|uncensored|evil|jailbroken))\b/i,
  /\b(jailbreak|jailbroken|do anything now|developer mode|god mode|unrestricted mode|no restrictions mode)\b/i,
  /\bpretend (that )?(you are|you're|to be|you have no)\b/i,
  /\b(roleplay|role-play|role play) as\b/i,
  /\b(admin|administrator|root|sudo|maintenance|debug) (mode|access|override)\b/i,
  /\b(this is|i am|i'm) (your|the) (developer|creator|admin|administrator|programmer|engineer who built you)\b/i,
];

// Text that should never appear in a reply. If the model quotes its own
// instructions, these headings are what would leak; the output guard swaps the
// reply for a fallback instead.
const LEAK_MARKERS = [
  /\bSAFETY RULES\b/i, /\bTHIS IS A DEMO\b/i, /\bFACTS AND HONESTY\b/i, /\bSESSION STATUS\b/i,
  /\bWHAT YOU KNOW ABOUT\b/i, /\bBLOCKED TOPICS\b/i, /\bCONTACT METHODS AVAILABLE\b/i,
  /\bRULES: follow these\b/i, /\bPASSING ON A MESSAGE\b/i, /\bREAL VERSION \(/i,
  /\bKNOWLEDGE \(your only source\b/i, /\bLINKS AVAILABLE AS BUTTONS\b/i,
  /\bsystem prompt\b/i, /\bmy instructions (say|state|tell)\b/i,
];

// Removes control characters and invisible Unicode that are sometimes used to
// hide instructions from pattern checks, and collapses runs of whitespace.
// Non-strings are returned unchanged so the size guard can reject them.
export function normaliseMessage(message) {
  if (typeof message !== 'string') return message;
  return message
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// In-memory rate limit store (per-isolate lifetime: see wrangler.toml note)
const rateLimitStore = new Map();

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
  const origin = request.headers.get('Origin') ?? '';
  if (!allowedOrigins.includes(origin)) {
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

// Sliding-window rate limit: allows up to security.rateLimitRpm requests per IP per minute.
// State is in-memory per Cloudflare isolate: under high traffic multiple isolates may run,
// so limits are approximate rather than exact. See wrangler.toml for a note on this.
export function guardRateLimit(ip, config) {
  const limit = config.security?.rateLimitRpm ?? 10;
  const now   = Date.now();
  const windowMs = 60_000;
  const entry = rateLimitStore.get(ip) ?? { count: 0, windowStart: now };
  if (now - entry.windowStart > windowMs) {
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
// This is a pre-filter; the system prompt itself also enforces the hierarchy as a second layer.
export function guardInjection(message) {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(message)) {
      console.warn('[guard:injection] Injection attempt blocked.');
      return 'That kind of message cannot be processed.';
    }
  }
  return null;
}

// Pre-filters messages against the blockedTopics phrase list only.
// There is deliberately no allowlist gate here: visitors describe real problems in
// their own words ("our deploys keep breaking"), and a keyword allowlist rejects
// exactly those high-intent messages. Topic scope is enforced by the system prompt,
// which can judge intent rather than match substrings.
// Short messages (< 30 chars) are always allowed: they are likely greetings or follow-ups.
export function guardTopic(message, config) {
  if (message.length < 30) return null;
  const { blockedTopics = [], ownerName = 'the professional' } = config;
  const lower = message.toLowerCase();

  const isBlocked = blockedTopics.some(t => lower.includes(t.toLowerCase()));
  if (isBlocked) {
    return `I can only answer questions about ${ownerName} and their work.`;
  }

  return null;
}

// Sanitises and caps the LLM reply before sending it to the visitor.
// Trims at a sentence boundary (. ! ?) to avoid mid-sentence cuts.
// Returns a safe fallback string if the reply is missing, empty, or looks like
// it is quoting the instructions (see LEAK_MARKERS). customFallback overrides
// the default wording, which is written for Gil Bot's contact buttons.
// Hard cap: 1500 characters: well above the maxAnswerWords limit in practice.
export function guardOutput(reply, ownerName, customFallback) {
  const fallback = customFallback
    ?? `That's not something I can help with here, but you can reach ${ownerName ?? 'me'} directly using the contact buttons below.`;

  if (typeof reply !== 'string' || reply.trim().length === 0) return fallback;

  if (LEAK_MARKERS.some(p => p.test(reply))) {
    console.warn('[guard:output] Reply looked like quoted instructions: replaced with fallback.');
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
