import { describe, it, expect, beforeEach, vi } from 'vitest'

// Reset the module cache before every test so _config starts as null
beforeEach(() => {
  vi.resetModules()
})

describe('getConfig', () => {
  it('returns all defaults when BOT_CONFIG_JSON is not set', async () => {
    const { getConfig } = await import('../src/config.js')
    const config = getConfig({})
    expect(config.botName).toBe('Assistant')
    expect(config.ownerName).toBe('the professional')
    expect(config.tone).toBe('professional')
    expect(config.maxAnswerWords).toBe(80)
    expect(config.historyTurns).toBe(4)
    expect(config.security.rateLimitRpm).toBe(10)
    expect(config.security.maxMessageLength).toBe(500)
    expect(config.security.maxSessionMessages).toBe(20)
    expect(config.llm.provider).toBe('openai')
  })

  it('merges user-provided values with defaults', async () => {
    const { getConfig } = await import('../src/config.js')
    const config = getConfig({
      BOT_CONFIG_JSON: JSON.stringify({ botName: 'MyBot', ownerName: 'Jane' }),
    })
    expect(config.botName).toBe('MyBot')
    expect(config.ownerName).toBe('Jane')
    expect(config.maxAnswerWords).toBe(80) // default preserved
  })

  it('falls back to defaults silently when BOT_CONFIG_JSON is invalid JSON', async () => {
    const { getConfig } = await import('../src/config.js')
    const config = getConfig({ BOT_CONFIG_JSON: 'not valid json {{' })
    expect(config.botName).toBe('Assistant')
  })

  it('caches the config after first call (same object reference)', async () => {
    const { getConfig } = await import('../src/config.js')
    const first  = getConfig({ BOT_CONFIG_JSON: JSON.stringify({ botName: 'FirstBot' }) })
    const second = getConfig({ BOT_CONFIG_JSON: JSON.stringify({ botName: 'SecondBot' }) })
    expect(first).toBe(second)
    expect(second.botName).toBe('FirstBot')
  })

  it('replaces the default blockedTopics array entirely (not concatenated)', async () => {
    const { getConfig } = await import('../src/config.js')
    const config = getConfig({
      BOT_CONFIG_JSON: JSON.stringify({ blockedTopics: ['cars', 'sports'] }),
    })
    expect(config.blockedTopics).toEqual(['cars', 'sports'])
    expect(config.blockedTopics).not.toContain('politics')
  })

  it('deep-merges nested security settings, preserving unspecified defaults', async () => {
    const { getConfig } = await import('../src/config.js')
    const config = getConfig({
      BOT_CONFIG_JSON: JSON.stringify({ security: { rateLimitRpm: 20 } }),
    })
    expect(config.security.rateLimitRpm).toBe(20)
    expect(config.security.maxMessageLength).toBe(500) // default preserved
    expect(config.security.maxSessionMessages).toBe(20) // default preserved
  })

  it('sets a nested null value directly without throwing', async () => {
    const { getConfig } = await import('../src/config.js')
    const config = getConfig({
      BOT_CONFIG_JSON: JSON.stringify({ llm: { provider: null } }),
    })
    expect(config.llm.provider).toBeNull()
    expect(config.llm.model).toBeNull() // other defaults inside llm preserved
  })
})
