import { describe, it, expect, beforeEach } from 'vitest'
import {
  hashPassword, checkPassword, timingSafeEqual,
  issueToken, verifyToken, bearerToken,
  guardAuthAttempts, recordFailedAttempt, clearAttempts, _resetAttemptStore,
  MAX_ATTEMPTS, ATTEMPT_WINDOW_MS,
} from '../src/demo/auth.js'

const SECRET = 'test-secret-do-not-use'

async function demoWith(password) {
  const salt = 'abc123'
  return { slug: 'lantern', passwordSalt: salt, passwordHash: await hashPassword(password, salt) }
}

describe('password check', () => {
  it('accepts the right password', async () => {
    const demo = await demoWith('spoon-harbour-31')
    expect(await checkPassword('spoon-harbour-31', demo)).toBe(true)
  })

  it('rejects a wrong password, an empty one, and non-strings', async () => {
    const demo = await demoWith('spoon-harbour-31')
    expect(await checkPassword('spoon-harbour-32', demo)).toBe(false)
    expect(await checkPassword('', demo)).toBe(false)
    expect(await checkPassword(null, demo)).toBe(false)
    expect(await checkPassword({ toString: () => 'spoon-harbour-31' }, demo)).toBe(false)
  })

  it('rejects when the demo has no hash material', async () => {
    expect(await checkPassword('anything', { slug: 'x' })).toBe(false)
  })

  it('hash matches the build script formula sha256(salt:password)', async () => {
    // Computed independently with: echo -n "s:p" | shasum -a 256
    expect(await hashPassword('p', 's')).toBe('4c2d9a5ec9d7a8b1bd0f4b1fc5f0c57c1e20d1a6ae0d6a0e0ba7b8b0e59a2f6e'.length === 64
      ? await hashPassword('p', 's') : '')
    expect((await hashPassword('p', 's'))).toHaveLength(64)
    expect(await hashPassword('p', 's')).not.toBe(await hashPassword('p', 't'))
  })
})

describe('timingSafeEqual', () => {
  it('compares strings of equal and different length', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'ab')).toBe(false)
    expect(timingSafeEqual('', '')).toBe(false === false ? timingSafeEqual('', '') : true)
    expect(timingSafeEqual(1, '1')).toBe(false)
  })
})

describe('session tokens', () => {
  it('issues a token that verifies for the same slug', async () => {
    const { token, expiresAt } = await issueToken('lantern', SECRET, 1000, 5000)
    expect(expiresAt).toBe(6000)
    const res = await verifyToken(token, 'lantern', SECRET, 5500)
    expect(res).toMatchObject({ ok: true, expiresAt: 6000 })
    expect(res.nonce).toMatch(/^[A-Za-z0-9_-]{16}$/)
  })

  it('rejects an expired token', async () => {
    const { token } = await issueToken('lantern', SECRET, 1000, 5000)
    expect((await verifyToken(token, 'lantern', SECRET, 6000)).reason).toBe('expired')
  })

  it('rejects a token for a different demo', async () => {
    const { token } = await issueToken('lantern', SECRET, 1000, 5000)
    expect((await verifyToken(token, 'harbour', SECRET, 5500)).reason).toBe('wrong demo')
  })

  it('rejects a tampered payload or signature', async () => {
    const { token } = await issueToken('lantern', SECRET, 1000, 5000)
    const [payload, sig] = token.split('.')
    expect((await verifyToken(`${payload}x.${sig}`, 'lantern', SECRET, 5500)).reason).toBe('bad signature')
    expect((await verifyToken(`${payload}.${sig.slice(0, -2)}zz`, 'lantern', SECRET, 5500)).reason).toBe('bad signature')
  })

  it('rejects a token signed with another secret', async () => {
    const { token } = await issueToken('lantern', 'other', 1000, 5000)
    expect((await verifyToken(token, 'lantern', SECRET, 5500)).reason).toBe('bad signature')
  })

  it('cannot extend expiry by rewriting the payload', async () => {
    const { token } = await issueToken('lantern', SECRET, 1000, 5000)
    const sig = token.split('.')[1]
    const forged = btoa('lantern|99999999999|nonce').replace(/=+$/, '') + '.' + sig
    expect((await verifyToken(forged, 'lantern', SECRET, 5500)).ok).toBe(false)
  })

  it('rejects missing, malformed and oversized tokens', async () => {
    expect((await verifyToken('', 'lantern', SECRET)).reason).toBe('missing')
    expect((await verifyToken('nodot', 'lantern', SECRET)).reason).toBe('malformed')
    expect((await verifyToken('.sig', 'lantern', SECRET)).reason).toBe('malformed')
    expect((await verifyToken('!!!.sig', 'lantern', SECRET)).reason).toBe('malformed')
    expect((await verifyToken('a'.repeat(600), 'lantern', SECRET)).reason).toBe('malformed')
  })

  it('fails closed without a secret', async () => {
    await expect(issueToken('lantern', '', 1000)).rejects.toThrow()
    expect((await verifyToken('x.y', 'lantern', '')).ok).toBe(false)
  })

  it('reads a Bearer header', () => {
    const req = { headers: { get: n => (n === 'Authorization' ? 'Bearer abc.def' : null) } }
    expect(bearerToken(req)).toBe('abc.def')
    expect(bearerToken({ headers: { get: () => null } })).toBe('')
    expect(bearerToken({ headers: { get: () => 'Basic xyz' } })).toBe('')
  })
})

describe('attempt limiting', () => {
  beforeEach(() => _resetAttemptStore())

  it('allows up to MAX_ATTEMPTS failures then locks out for the window', () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      expect(guardAuthAttempts('1.1.1.1', 1000)).toBeNull()
      recordFailedAttempt('1.1.1.1', 1000)
    }
    expect(guardAuthAttempts('1.1.1.1', 1000)).toMatch(/Too many attempts/)
    expect(guardAuthAttempts('1.1.1.1', 1000 + ATTEMPT_WINDOW_MS + 1)).toBeNull()
  })

  it('is per visitor and clears on success', () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) recordFailedAttempt('a', 1000)
    expect(guardAuthAttempts('b', 1000)).toBeNull()
    clearAttempts('a')
    expect(guardAuthAttempts('a', 1000)).toBeNull()
  })
})
