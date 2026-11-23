import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../src/prompt.js'

const base = {
  ownerName:      'Alice',
  tone:           'professional',
  maxAnswerWords: 80,
  contactMethods: {},
  blockedTopics:  [],
  allowedTopics:  [],
}

describe('buildSystemPrompt', () => {
  it('includes ownerName in the output', () => {
    const p = buildSystemPrompt({ ...base, ownerName: 'Alice Smith' }, 'profile')
    expect(p).toMatch(/Alice Smith/)
  })

  it('uses the correct tone fragment for every known tone', () => {
    const tones = {
      professional: /business-oriented/i,
      casual:       /conversational/i,
      direct:       /brief and direct/i,
      warm:         /friendly/i,
      technical:    /precise technical/i,
      formal:       /formal language/i,
      founder:      /founder/i,
    }
    for (const [tone, pattern] of Object.entries(tones)) {
      expect(buildSystemPrompt({ ...base, tone }, 'profile')).toMatch(pattern)
    }
  })

  it('falls back to professional tone for an unknown tone value', () => {
    expect(buildSystemPrompt({ ...base, tone: 'funky-unknown' }, 'profile'))
      .toMatch(/business-oriented/i)
  })

  it('includes maxAnswerWords in the output', () => {
    expect(buildSystemPrompt({ ...base, maxAnswerWords: 120 }, 'profile')).toMatch(/120/)
  })

  it('lists each blocked topic', () => {
    const p = buildSystemPrompt({ ...base, blockedTopics: ['cars', 'politics'] }, 'profile')
    expect(p).toMatch(/cars/)
    expect(p).toMatch(/politics/)
  })

  it('describes scope around the owner instead of listing keywords', () => {
    const p = buildSystemPrompt({ ...base, ownerName: 'Alice' }, 'profile')
    expect(p).toMatch(/SCOPE/)
    expect(p).toMatch(/visitors describing their own software quality/i)
  })

  it('instructs the model to bridge rather than refuse near-miss questions', () => {
    const p = buildSystemPrompt(base, 'profile')
    expect(p).toMatch(/BRIDGE, do not refuse/)
    expect(p).toMatch(/Never claim experience with a tool the profile does not mention/)
  })

  it('enforces British English', () => {
    expect(buildSystemPrompt(base, 'profile')).toMatch(/British English/)
  })

  it('tells the model to close problem conversations with the intro call', () => {
    expect(buildSystemPrompt(base, 'profile')).toMatch(/30 minute introductory call/)
  })

  it('mentions contact buttons for each configured contact method', () => {
    const config = {
      ...base,
      contactMethods: {
        email:    'a@b.com',
        linkedin: 'https://linkedin.com/in/alice',
        calendar: 'https://cal.com/alice',
      },
    }
    const p = buildSystemPrompt(config, 'profile')
    expect(p).toMatch(/Email/)
    expect(p).toMatch(/LinkedIn/)
    expect(p).toMatch(/Calendar/)
  })

  it('uses fallback contact text when no methods are configured', () => {
    expect(buildSystemPrompt({ ...base, contactMethods: {} }, 'profile'))
      .toMatch(/No contact methods/i)
  })

  it('includes profile text in the output', () => {
    const profile = 'I am a software engineer with 10 years experience.'
    expect(buildSystemPrompt(base, profile)).toMatch(/software engineer with 10 years/)
  })

  it('uses fallback profile message when profileText is empty', () => {
    expect(buildSystemPrompt(base, '')).toMatch(/profile not loaded/i)
  })

  it('uses fallback profile message when profileText is null', () => {
    expect(buildSystemPrompt(base, null)).toMatch(/profile not loaded/i)
  })

  it('does not write raw contact details (email/URL) into the prompt reply text', () => {
    const config = {
      ...base,
      contactMethods: { email: 'secret@example.com' },
    }
    const p = buildSystemPrompt(config, 'profile')
    expect(p).not.toMatch(/secret@example\.com/)
  })
})
