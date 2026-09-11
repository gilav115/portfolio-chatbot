/**
 * demo/handlers.js: routes for the private business demos.
 *
 *   POST /demo/<slug>/auth    { password }            → { token, expiresAt } | 401
 *   GET  /demo/<slug>/config  Authorization: Bearer   → public branding/config
 *   POST /demo/<slug>/chat    Authorization: Bearer   → { reply, usage, cta? }
 *
 * Guard order for /chat (each returns null on pass):
 *   origin → session token → per-visitor rate limit → per-demo daily cap →
 *   JSON shape → message size → history shape/length → injection → blocked topic
 * then the model, then the output guard (length + instruction-leak check).
 *
 * Everything the browser sees about a demo comes from publicConfig() and
 * only after the token check, so an unauthenticated visitor learns nothing
 * beyond "this slug exists".
 */

import {
  guardOrigin, guardRateLimit, guardMessageSize, guardSessionLength,
  guardInjection, guardTopic, guardOutput, normaliseMessage,
} from '../guards.js';
import {
  checkPassword, issueToken, verifyToken, bearerToken,
  guardAuthAttempts, recordFailedAttempt, clearAttempts,
} from './auth.js';
import { getDemo, publicConfig, guardConfigFor } from './registry.js';
import { buildDemoPrompt } from './prompt.js';

// Per-demo, per-day message counter. In memory per isolate (approximate),
// which is enough as a backstop behind the password gate and the spend cap.
const dailyStore = new Map();

export function guardDailyCap(slug, cap, now = Date.now()) {
  const day   = new Date(now).toISOString().slice(0, 10);
  const key   = `${slug}:${day}`;
  const count = (dailyStore.get(key) ?? 0) + 1;
  dailyStore.set(key, count);
  if (count > cap) return "This preview has used today's message allowance. It resets tomorrow, and the allowance is a setting the real version would control.";
  return null;
}

export function _resetDailyStore() { dailyStore.clear(); sessionStore.clear(); }

// Per-session message counter keyed by the token's nonce, so the conversation
// limit holds even if a caller sends an empty history every time. In memory
// per isolate, like the other counters; the token expiry bounds its lifetime.
// Allows a little headroom over maxMessages for "New conversation" restarts.
const sessionStore = new Map();
const SESSION_RESTARTS = 3;

export function guardSessionCount(nonce, maxMessages) {
  if (!nonce) return null;
  const count = (sessionStore.get(nonce) ?? 0) + 1;
  sessionStore.set(nonce, count);
  if (count > maxMessages * SESSION_RESTARTS) {
    return 'This preview session has used its messages. Enter the password again to start afresh.';
  }
  return null;
}

// deps: { bundle, callModel, respond } are injected so tests can run the
// handlers without the generated bundle or a real model.
export async function handleDemoRequest(request, env, config, url, deps) {
  const { bundle, callModel, respond } = deps;

  const parts = url.pathname.split('/').filter(Boolean); // ['demo', slug, action]
  const slug   = parts[1] ?? '';
  const action = parts[2] ?? '';

  const originError = guardOrigin(request, config);
  if (originError) return respond({ error: originError }, 403);

  const demo = getDemo(bundle, slug);
  if (!demo) return respond({ error: 'This preview does not exist.' }, 404);

  const secret = env.DEMO_SESSION_SECRET;
  if (!secret) {
    console.error('[demo] DEMO_SESSION_SECRET is not set: gate is closed.');
    return respond({ error: 'This preview is not available right now.' }, 503);
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';

  if (action === 'auth' && request.method === 'POST') {
    return handleAuth(request, demo, secret, ip, respond);
  }

  if (action === 'config' && request.method === 'GET') {
    const session = await verifyToken(bearerToken(request), slug, secret);
    if (!session.ok) return respond({ error: sessionMessage(session.reason) }, 401);
    return respond(publicConfig(demo), 200);
  }

  if (action === 'chat' && request.method === 'POST') {
    const session = await verifyToken(bearerToken(request), slug, secret);
    if (!session.ok) return respond({ error: sessionMessage(session.reason) }, 401);
    const usedUp = guardSessionCount(session.nonce, demo.limits.maxMessages);
    if (usedUp) return respond({ error: usedUp }, 401);
    return handleDemoChat(request, env, demo, ip, callModel, respond);
  }

  return respond({ error: 'Not found.' }, 404);
}

async function handleAuth(request, demo, secret, ip, respond) {
  const lockout = guardAuthAttempts(ip);
  if (lockout) return respond({ error: lockout }, 429);

  let body;
  try {
    body = await request.json();
  } catch {
    return respond({ error: 'Invalid request.' }, 400);
  }

  const ok = await checkPassword(body?.password, demo);
  if (!ok) {
    recordFailedAttempt(ip);
    console.warn(`[demo:${demo.slug}] wrong password from ${ip}`);
    return respond({ error: 'That password is not right.' }, 401);
  }

  clearAttempts(ip);
  const ttlMs = (demo.limits.sessionHours ?? 2) * 60 * 60 * 1000;
  const { token, expiresAt } = await issueToken(demo.slug, secret, ttlMs);
  return respond({ token, expiresAt }, 200);
}

async function handleDemoChat(request, env, demo, ip, callModel, respond) {
  const gcfg = guardConfigFor(demo);
  const name = demo.business?.name ?? 'the business';

  const rateError = guardRateLimit(`demo:${demo.slug}:${ip}`, gcfg);
  if (rateError) return respond({ error: rateError }, 429);

  const capError = guardDailyCap(demo.slug, demo.limits.dailyMessageCap);
  if (capError) return respond({ error: capError }, 429);

  let body;
  try {
    body = await request.json();
  } catch {
    return respond({ error: 'Invalid JSON.' }, 400);
  }

  const message = normaliseMessage(body?.message);
  const history = body?.history ?? [];

  const sizeError = guardMessageSize(message, gcfg);
  if (sizeError) return respond({ error: sizeError }, 400);

  const sessionError = guardSessionLength(history, gcfg);
  if (sessionError) {
    return respond({
      error: `This preview conversation has reached its ${demo.limits.maxMessages} message limit. Start a new conversation to carry on.`,
      limitReached: true,
    }, 400);
  }

  const injectionError = guardInjection(message);
  if (injectionError) {
    return respond({ reply: `I can only help with questions about ${name}. What would you like to know?`, usage: usageFor(history, demo) }, 200);
  }

  const topicError = guardTopic(message, gcfg);
  if (topicError) {
    return respond({ reply: topicError, usage: usageFor(history, demo) }, 200);
  }

  const usage        = usageFor(history, demo);
  const systemPrompt = buildDemoPrompt(demo, usage);
  const turns        = demo.bot?.historyTurns ?? 5;
  const trimmed      = history.slice(-(turns * 2));

  let text;
  try {
    text = await callModel(systemPrompt, trimmed, message, env, {
      maxAnswerWords: demo.bot?.maxAnswerWords ?? 90,
      llm: demo.llm ?? {},
    });
  } catch (err) {
    console.error(`[demo:${demo.slug}] model call failed:`, err);
    return respond({ error: 'The assistant could not answer just now. Please try again.' }, 502);
  }

  const fallback = demo.bot?.fallback
    ?? `I can't help with that one here, but the ${name} team can: their details are in the buttons below.`;
  const reply = guardOutput(text, name, fallback);
  const cta   = matchLinks(demo.links ?? [], message, reply);

  return respond({ reply, usage, ...(cta.length && { cta }) }, 200);
}

// Visitor messages so far, counting the one being answered now.
export function usageFor(history, demo) {
  const priorUserMessages = Array.isArray(history)
    ? history.filter(m => m?.role === 'user').length
    : 0;
  return { used: priorUserMessages + 1, max: demo.limits.maxMessages };
}

// Picks the links whose keywords appear in the visitor's message or the reply.
// Keywords are whole-word, case-insensitive. At most three buttons per reply.
export function matchLinks(links, message, reply) {
  const haystack = `${message}\n${reply}`.toLowerCase();
  const out = [];
  for (const link of links) {
    if (!link?.label || !link?.href || !Array.isArray(link.keywords)) continue;
    const hit = link.keywords.some(kw => {
      const k = String(kw).toLowerCase().trim();
      if (!k) return false;
      return new RegExp(`(^|[^a-z0-9])${escapeRegex(k)}([^a-z0-9]|$)`, 'i').test(haystack);
    });
    if (hit) out.push({ label: link.label, href: link.href, type: link.type ?? 'link' });
    if (out.length === 3) break;
  }
  return out;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sessionMessage(reason) {
  if (reason === 'expired') return 'Your preview session has expired. Enter the password again to continue.';
  return 'Please enter the password to use this preview.';
}
