/**
 * demo/auth.js: password gate and session tokens for the private demo pages.
 *
 * Passwords
 *   Each demo stores only a salted SHA-256 hash of its password, produced at
 *   build time by scripts/demo-build.js. The check here hashes the submitted
 *   password with the same salt and compares in constant time, so neither the
 *   password nor a timing hint ever leaves the worker.
 *
 * Tokens
 *   A token is  base64url(payload) + '.' + base64url(HMAC-SHA256(payload))
 *   where payload is  slug + '|' + expiresAtMs + '|' + randomNonce.
 *   Nothing is stored: the signature proves the worker issued it and the
 *   expiry inside it is trusted only because the signature checks out.
 *   The key is the DEMO_SESSION_SECRET Cloudflare secret. Without it the gate
 *   fails closed (no tokens issued, none accepted).
 *
 * Attempt limiting
 *   Wrong passwords are counted per visitor IP in memory; after MAX_ATTEMPTS
 *   in ATTEMPT_WINDOW_MS the visitor is locked out for the rest of the window.
 *   Per isolate, like the chat rate limit, so approximate under heavy load.
 *   The passwords themselves are long random phrases, so the lockout is a
 *   nuisance barrier rather than the thing that keeps guessing infeasible.
 */

const encoder = new TextEncoder();

export const MAX_ATTEMPTS      = 5;
export const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
export const DEFAULT_TTL_MS    = 2 * 60 * 60 * 1000;

const attemptStore = new Map();

export function guardAuthAttempts(ip, now = Date.now()) {
  const entry = attemptStore.get(ip);
  if (!entry || now - entry.windowStart > ATTEMPT_WINDOW_MS) return null;
  if (entry.count >= MAX_ATTEMPTS) {
    const minutes = Math.max(1, Math.ceil((ATTEMPT_WINDOW_MS - (now - entry.windowStart)) / 60000));
    return `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
  }
  return null;
}

export function recordFailedAttempt(ip, now = Date.now()) {
  const entry = attemptStore.get(ip);
  if (!entry || now - entry.windowStart > ATTEMPT_WINDOW_MS) {
    attemptStore.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count += 1;
  }
}

export function clearAttempts(ip) {
  attemptStore.delete(ip);
}

// Test hook: wipes the in-memory attempt counters.
export function _resetAttemptStore() {
  attemptStore.clear();
}

// ── Hashing ───────────────────────────────────────────────────────────────────

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return bufferToHex(digest);
}

// Matches scripts/demo-build.js exactly: sha256(salt + ':' + password).
export async function hashPassword(password, salt) {
  return sha256Hex(`${salt}:${password}`);
}

export async function checkPassword(submitted, demo) {
  if (typeof submitted !== 'string' || !submitted || submitted.length > 200) return false;
  if (!demo?.passwordHash || !demo?.passwordSalt) return false;
  const candidate = await hashPassword(submitted, demo.passwordSalt);
  return timingSafeEqual(candidate, demo.passwordHash);
}

// Constant-time string comparison. Always walks the full length of the
// expected value so a mismatch takes the same time wherever it occurs.
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  let diff = aBytes.length ^ bBytes.length;
  const len = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i % aBytes.length] ?? 0) ^ (bBytes[i % bBytes.length] ?? 0);
  }
  return diff === 0;
}

// ── Tokens ────────────────────────────────────────────────────────────────────

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
}

async function sign(payload, secret) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return base64url(new Uint8Array(sig));
}

export async function issueToken(slug, secret, ttlMs = DEFAULT_TTL_MS, now = Date.now()) {
  if (!secret) throw new Error('DEMO_SESSION_SECRET is not set');
  const nonce     = base64url(crypto.getRandomValues(new Uint8Array(12)));
  const expiresAt = now + ttlMs;
  const payload   = `${slug}|${expiresAt}|${nonce}`;
  const signature = await sign(payload, secret);
  return { token: `${base64url(encoder.encode(payload))}.${signature}`, expiresAt };
}

// Returns { ok: true, expiresAt } or { ok: false, reason }.
// reason is one of: 'missing', 'malformed', 'bad signature', 'wrong demo', 'expired'.
export async function verifyToken(token, slug, secret, now = Date.now()) {
  if (!secret) return { ok: false, reason: 'missing' };
  if (typeof token !== 'string' || !token) return { ok: false, reason: 'missing' };
  if (token.length > 512) return { ok: false, reason: 'malformed' };

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'malformed' };

  let payload;
  try {
    payload = new TextDecoder().decode(base64urlDecode(token.slice(0, dot)));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const expected = await sign(payload, secret);
  if (!timingSafeEqual(expected, token.slice(dot + 1))) return { ok: false, reason: 'bad signature' };

  const [tokenSlug, expiresRaw] = payload.split('|');
  const expiresAt = Number(expiresRaw);
  if (tokenSlug !== slug) return { ok: false, reason: 'wrong demo' };
  if (!Number.isFinite(expiresAt) || now >= expiresAt) return { ok: false, reason: 'expired' };

  return { ok: true, expiresAt };
}

// Reads "Authorization: Bearer <token>" and returns the token or ''.
export function bearerToken(request) {
  const header = request.headers.get('Authorization') ?? '';
  const match  = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : '';
}

// ── Encoding helpers ──────────────────────────────────────────────────────────

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('not base64url');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
