/**
 * index.js: Main Cloudflare Worker handler.
 *
 * Routes:
 *   OPTIONS  *              → CORS preflight
 *   GET  /health            → Liveness check (returns { status: 'ok' })
 *   GET  /widget-config     → Public widget settings (name, welcome message, accent colour)
 *   POST /chat              → Main chat endpoint (guarded, calls LLM, returns reply + CTAs)
 *
 * /chat guard order (each guard returns null on pass, string on fail):
 *   1. guardOrigin      : request must come from an allowedOrigins domain
 *   2. guardWidgetToken : X-Widget-Token header must match WIDGET_TOKEN secret
 *   3. guardRateLimit   : enforces rateLimitRpm per IP
 *   4. guardMessageSize : message must be a non-empty string under maxMessageLength
 *   5. guardSessionLength: history must not exceed maxSessionMessages
 *   6. guardInjection   : blocks prompt injection phrases
 *   7. guardTopic       : blocks off-topic messages based on keyword lists
 */

import { getConfig } from './config.js';
import { buildSystemPrompt } from './prompt.js';
import {
  guardOrigin, guardWidgetToken, guardRateLimit,
  guardMessageSize, guardSessionLength, guardInjection,
  guardTopic, guardOutput,
} from './guards.js';

const LEAD_INTENT_KEYWORDS = [
  'hire', 'work with', 'work together', 'pricing', 'price', 'cost', 'rate',
  'book a call', 'get in touch', 'reach out', 'quote', 'available for',
  'interested in working', 'engage', 'start a project', 'consult',
  'how much', 'what do you charge',
  'contact', 'how can i reach', 'how to reach', 'reach you', 'your email',
  'email address', 'connect with you', 'how do i message', 'linkedin',
  'whatsapp', 'drop you', 'send you',
];

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      console.error('[worker] Unhandled error:', err);
      const config = getConfig(env);
      return buildResponse({ error: 'Internal server error.' }, 500, request, config);
    }
  },
};

async function handleRequest(request, env) {
  const config = getConfig(env);
  const url    = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return buildResponse(null, 204, request, config);
  }

  if (url.pathname === '/health' && request.method === 'GET') {
    return buildResponse({ status: 'ok' }, 200, request, config);
  }

  // Returns public widget config (bot name, welcome message, accent, suggested questions).
  // Checked by origin: safe to call without a widget token.
  if (url.pathname === '/widget-config' && request.method === 'GET') {
    const originError = guardOrigin(request, config);
    if (originError) return buildResponse({ error: originError }, 403, request, config);
    return buildResponse({
      botName:            config.botName,
      welcomeMessage:     config.ui?.welcomeMessage ?? `Hi! I'm ${config.botName}. How can I help?`,
      accentColor:        config.ui?.accentColor ?? '#0055ff',
      suggestedQuestions: config.ui?.suggestedQuestions ?? [],
    }, 200, request, config);
  }

  if (url.pathname === '/chat' && request.method === 'POST') {
    return await handleChat(request, env, config);
  }

  return buildResponse({ error: 'Not found.' }, 404, request, config);
}

async function handleChat(request, env, config) {
  const originError = guardOrigin(request, config);
  if (originError) return buildResponse({ error: originError }, 403, request, config);

  const tokenError = guardWidgetToken(request, env);
  if (tokenError) return buildResponse({ error: tokenError }, 401, request, config);

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const rateLimitError = guardRateLimit(ip, config);
  if (rateLimitError) return buildResponse({ error: rateLimitError }, 429, request, config);

  let body;
  try {
    body = await request.json();
  } catch {
    return buildResponse({ error: 'Invalid JSON.' }, 400, request, config);
  }

  const { message, history = [] } = body;

  const sizeError    = guardMessageSize(message, config);
  if (sizeError) return buildResponse({ error: sizeError }, 400, request, config);

  const sessionError = guardSessionLength(history, config);
  if (sessionError) return buildResponse({ error: sessionError }, 400, request, config);

  const injectionError = guardInjection(message);
  if (injectionError) return buildResponse({ error: injectionError }, 400, request, config);

  const topicError = guardTopic(message, config);
  if (topicError) return buildResponse({ reply: topicError }, 200, request, config);

  const profileText = (env.PROFILE_TEXT_1 ?? env.PROFILE_TEXT ?? '')
    + (env.PROFILE_TEXT_2 ?? '')
    + (env.PROFILE_TEXT_3 ?? '')
    + (env.PROFILE_TEXT_4 ?? '');
  const systemPrompt = buildSystemPrompt(config, profileText);
  const trimmedHistory = trimHistory(history, config);

  let reply;
  try {
    reply = await callLLM(systemPrompt, trimmedHistory, message, env, config);
  } catch (err) {
    console.error('[worker] LLM call failed:', err);
    return buildResponse(
      { error: 'Could not reach the assistant. Please try again.' },
      502, request, config
    );
  }

  reply = guardOutput(reply, config.ownerName);

  const cta = detectLeadIntent(message)
    ? buildCTAs(config.contactMethods)
    : [];

  return buildResponse({ reply, ...(cta.length && { cta }) }, 200, request, config);
}

function trimHistory(history, config) {
  const turns = config.historyTurns ?? 4;
  return history.slice(-(turns * 2));
}

function detectLeadIntent(message) {
  return LEAD_INTENT_KEYWORDS.some(kw => message.toLowerCase().includes(kw));
}

function buildCTAs(contactMethods) {
  if (!contactMethods) return [];
  const ctas = [];
  if (contactMethods.email)    ctas.push({ type: 'email',    label: 'Email',        href: `mailto:${contactMethods.email}` });
  if (contactMethods.linkedin) ctas.push({ type: 'linkedin', label: 'LinkedIn',     href: contactMethods.linkedin });
  if (contactMethods.whatsapp) ctas.push({ type: 'whatsapp', label: 'WhatsApp',     href: `https://wa.me/${contactMethods.whatsapp.replace(/\D/g, '')}` });
  if (contactMethods.sms)      ctas.push({ type: 'sms',      label: 'SMS',          href: `sms:${contactMethods.sms}` });
  if (contactMethods.calendar) ctas.push({ type: 'calendar', label: 'Book a call',  href: contactMethods.calendar });
  if (contactMethods.github)   ctas.push({ type: 'github',   label: 'GitHub',       href: contactMethods.github });
  for (const c of (contactMethods.custom ?? [])) {
    if (c.label && c.href) ctas.push({ type: 'custom', label: c.label, href: c.href });
  }
  return ctas;
}

// Routes to the correct LLM provider based on config.llm.provider.
// Supported: 'openai' (default), 'anthropic'.
// Set LLM_API_KEY as a Cloudflare secret (npx wrangler secret put LLM_API_KEY).
async function callLLM(systemPrompt, history, message, env, config) {
  const provider = config.llm?.provider ?? 'openai';
  if (provider === 'anthropic') {
    return callAnthropic(systemPrompt, history, message, env, config);
  }
  return callOpenAI(systemPrompt, history, message, env, config);
}

// OpenAI Chat Completions API.
// Default model: gpt-4o-mini (cheap, fast, good quality for this use case).
// Override via llm.model in bot.config.json (e.g. "gpt-4o", "gpt-4-turbo").
async function callOpenAI(systemPrompt, history, message, env, config) {
  const maxTokens = Math.ceil((config.maxAnswerWords ?? 80) * 1.5) + 50;
  const model     = config.llm?.model ?? 'gpt-4o-mini';
  const messages  = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user',   content: message },
  ];

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${env.LLM_API_KEY}`,
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.4 }),
    signal: AbortSignal.timeout(25000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// Anthropic Messages API.
// Default model: claude-haiku-4-5-20251001 (cheap, fast).
// Override via llm.model in bot.config.json (e.g. "claude-sonnet-4-6").
// Note: Anthropic uses a separate 'system' field instead of a system message in the array.
async function callAnthropic(systemPrompt, history, message, env, config) {
  const maxTokens = Math.ceil((config.maxAnswerWords ?? 80) * 1.5) + 50;
  const model     = config.llm?.model ?? 'claude-haiku-4-5-20251001';
  const messages  = [...history, { role: 'user', content: message }];

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         env.LLM_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, system: systemPrompt, messages, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(25000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text ?? '';
}

function buildResponse(body, status, request, config) {
  const allowedOrigins = config?.security?.allowedOrigins ?? [];
  const origin         = request?.headers?.get('Origin') ?? '*';
  const corsOrigin     = (!allowedOrigins.length || allowedOrigins.includes(origin))
    ? origin
    : '';

  const headers = {
    'Content-Type':                     'application/json',
    'Access-Control-Allow-Origin':      corsOrigin || '*',
    'Access-Control-Allow-Methods':     'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers':     'Content-Type, X-Widget-Token',
    'X-Content-Type-Options':           'nosniff',
  };

  if (status === 204 || body === null) {
    return new Response(null, { status, headers });
  }
  return new Response(JSON.stringify(body), { status, headers });
}
