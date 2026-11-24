// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WIDGET_SOURCE = readFileSync(join(import.meta.dirname, '..', '..', 'widget', 'widget.js'), 'utf8')

// Loads the widget the way a website does: a script tag with data- attributes.
function loadWidget(attrs = {}, remoteConfig = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(remoteConfig), { status: 200 })))
  const script = document.createElement('script')
  script.dataset.worker = 'https://bot.example.com'
  for (const [key, value] of Object.entries(attrs)) script.dataset[key] = value
  document.body.appendChild(script)
  new Function(WIDGET_SOURCE)()
  const host = document.getElementById('prb-host')
  return { host, shadow: host.shadowRoot }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => { document.body.innerHTML = '' })
afterEach(() => { vi.unstubAllGlobals() })

describe('widget', () => {
  it('shows a bot name with HTML characters as plain text', () => {
    const { shadow } = loadWidget({ name: 'Sam <b>"Q"</b> & Co' })
    expect(shadow.getElementById('header-name').textContent).toBe('Sam <b>"Q"</b> & Co')
    expect(shadow.querySelector('#header-name b')).toBeNull()
    expect(shadow.getElementById('panel').getAttribute('aria-label')).toBe('Sam <b>"Q"</b> & Co chat')
  })

  it('uses white text on the accent colour by default', () => {
    const { host } = loadWidget()
    expect(host.style.getPropertyValue('--prb-accent-text')).toBe('#fff')
  })

  it('takes the accent text and ink colours from the script tag', () => {
    const { host } = loadWidget({ accent: '#2FD08A', accentText: '#0E1B17', accentInk: '#0E1B17' })
    expect(host.style.getPropertyValue('--prb-accent')).toBe('#2FD08A')
    expect(host.style.getPropertyValue('--prb-accent-text')).toBe('#0E1B17')
    expect(host.style.getPropertyValue('--prb-accent-ink')).toBe('#0E1B17')
  })

  it('ignores colour values that are not plain colours', () => {
    const { host } = loadWidget({ accentText: 'red; background: url(x)' })
    expect(host.style.getPropertyValue('--prb-accent-text')).toBe('#fff')
  })

  it('opens when the page sends the open event', () => {
    const { shadow } = loadWidget()
    window.dispatchEvent(new Event('portfolio-chatbot:open'))
    expect(shadow.getElementById('panel').classList.contains('open')).toBe(true)
  })

  it('shows the bot name from the worker as plain text', async () => {
    const { shadow } = loadWidget({}, { botName: '<i>Robo</i>' })
    await flush()
    expect(shadow.getElementById('header-name').textContent).toBe('<i>Robo</i>')
    expect(shadow.getElementById('avatar').textContent).toBe('<')
  })

  it('adds only one chat button when the script loads twice', () => {
    loadWidget()
    new Function(WIDGET_SOURCE)()
    expect(document.querySelectorAll('#prb-host')).toHaveLength(1)
  })

  it('takes the text colour from the worker config when the script tag has none', async () => {
    const { host } = loadWidget({}, { accentColor: '#2FD08A', accentTextColor: '#0E1B17' })
    await flush()
    expect(host.style.getPropertyValue('--prb-accent')).toBe('#2FD08A')
    expect(host.style.getPropertyValue('--prb-accent-text')).toBe('#0E1B17')
  })

  it('keeps the script tag text colour over the worker config', async () => {
    const { host } = loadWidget({ accentText: '#ffffff' }, { accentTextColor: '#0E1B17' })
    await flush()
    expect(host.style.getPropertyValue('--prb-accent-text')).toBe('#ffffff')
  })
})
