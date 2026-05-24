(function () {
  'use strict';

  // Config from script tag
  const script       = document.currentScript || document.querySelector('[data-worker]');
  const WORKER_URL   = (script && script.dataset.worker)  || '';
  const WIDGET_TOKEN = (script && script.dataset.token)   || '';
  const BOT_NAME     = (script && script.dataset.name)    || 'Assistant';
  const ACCENT       = (script && script.dataset.accent)  || '#0055ff';
  const WELCOME      = (script && script.dataset.welcome) || 'Hi! Ask me anything.';
  const MAX_LENGTH   = 500;
  const TIMEOUT_MS   = 30000;

  if (!WORKER_URL) {
    console.error('[portfolio-chatbot] data-worker attribute is required.');
    return;
  }

  // State
  const history     = [];
  let isOpen        = false;
  let isWaiting     = false;
  let configFetched = false;
  let suggestionsEl = null;
  const ctasShown   = new Set();

  const AVATAR_LETTER = (BOT_NAME.trim()[0] || 'A').toUpperCase();

  // Mount host element
  const host = document.createElement('div');
  host.setAttribute('id', 'prb-host');
  host.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:2147483647;';
  document.body.appendChild(host);

  // Shadow DOM isolates widget styles from the host page completely.
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  #toggle {
    width: 52px; height: 52px; border-radius: 50%;
    background: ${ACCENT}; border: none; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 2px 12px rgba(0,0,0,0.18);
    transition: transform 0.15s ease, box-shadow 0.15s ease;
    color: #fff;
  }
  #toggle:hover { transform: scale(1.06); box-shadow: 0 4px 20px rgba(0,0,0,0.22); }
  #toggle:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }
  #toggle svg { width: 23px; height: 23px; pointer-events: none; }

  #panel {
    position: absolute; bottom: 64px; right: 0;
    width: 380px;
    background: #fff;
    border-radius: 16px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06);
    display: flex; flex-direction: column; overflow: hidden;
    opacity: 0; transform: translateY(10px) scale(0.98);
    pointer-events: none;
    transition: opacity 0.2s ease, transform 0.2s ease;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  }
  #panel.open { opacity: 1; transform: none; pointer-events: all; }

  #panel-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 16px; background: ${ACCENT}; flex-shrink: 0;
  }
  #header-left { display: flex; align-items: center; gap: 10px; }
  #avatar {
    width: 36px; height: 36px; border-radius: 50%;
    background: rgba(255,255,255,0.2);
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; font-weight: 700; color: #fff;
    flex-shrink: 0;
  }
  #header-info { display: flex; flex-direction: column; gap: 3px; }
  #header-name { font-size: 14px; font-weight: 600; color: #fff; line-height: 1; }
  #header-status {
    display: flex; align-items: center; gap: 5px;
    font-size: 11px; color: rgba(255,255,255,0.78); line-height: 1;
  }
  #header-status::before {
    content: ''; width: 6px; height: 6px;
    background: #4ade80; border-radius: 50%; flex-shrink: 0;
  }
  #close-btn {
    width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
    background: rgba(255,255,255,0.15); border: none; color: #fff;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; transition: background 0.14s;
  }
  #close-btn:hover { background: rgba(255,255,255,0.28); }
  #close-btn:focus-visible { outline: 2px solid rgba(255,255,255,0.6); border-radius: 50%; }
  #close-btn svg { width: 14px; height: 14px; pointer-events: none; }

  #messages {
    flex: 1; min-height: 280px; max-height: 380px;
    overflow-y: auto; padding: 16px;
    display: flex; flex-direction: column; gap: 8px;
    color: #111;
    scrollbar-width: thin; scrollbar-color: #ddd transparent;
  }
  #messages::-webkit-scrollbar { width: 4px; }
  #messages::-webkit-scrollbar-track { background: transparent; }
  #messages::-webkit-scrollbar-thumb { background: #ddd; border-radius: 4px; }

  .msg {
    max-width: 82%; padding: 10px 14px;
    line-height: 1.52; word-break: break-word; font-size: 14px;
  }
  .msg.user {
    align-self: flex-end; background: ${ACCENT}; color: #fff;
    border-radius: 18px 18px 4px 18px;
  }
  .msg.bot {
    align-self: flex-start; background: #f4f4f5; color: #111;
    border-radius: 4px 18px 18px 18px;
  }
  .msg.error {
    align-self: flex-start; background: #fef2f2; color: #b91c1c;
    border-radius: 4px 18px 18px 18px; font-size: 13px;
  }
  .msg a { color: ${ACCENT}; text-decoration: underline; }
  .msg.user a { color: rgba(255,255,255,0.85); }

  .typing {
    align-self: flex-start; display: flex; gap: 4px; align-items: center;
    padding: 12px 16px; background: #f4f4f5;
    border-radius: 4px 18px 18px 18px;
  }
  .typing span {
    width: 6px; height: 6px; border-radius: 50%;
    background: #bbb; animation: bounce 1.3s infinite;
  }
  .typing span:nth-child(2) { animation-delay: 0.18s; }
  .typing span:nth-child(3) { animation-delay: 0.36s; }
  @keyframes bounce {
    0%, 60%, 100% { transform: translateY(0); opacity: 1; }
    30% { transform: translateY(-5px); opacity: 0.55; }
  }

  .cta-row { align-self: flex-start; display: flex; gap: 6px; padding: 2px 0 4px; }
  .cta-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 36px; height: 36px; border-radius: 50%;
    background: #f4f4f5; border: none;
    text-decoration: none; cursor: pointer;
    transition: background 0.14s, transform 0.12s; color: #444;
  }
  .cta-btn:hover { background: #e8e8ea; transform: scale(1.1); }
  .cta-btn:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: 2px; }
  .cta-btn svg { width: 18px; height: 18px; pointer-events: none; }
  .cta-btn[data-type="linkedin"] { color: #0077b5; }
  .cta-btn[data-type="github"]   { color: #24292e; }
  .cta-btn[data-type="whatsapp"] { color: #22c55e; }
  .cta-btn[data-type="calendar"] { color: #ef4444; }

  #input-area {
    display: flex; align-items: flex-end; gap: 8px;
    padding: 12px 14px; border-top: 1px solid #f0f0f0; flex-shrink: 0;
  }
  #input {
    flex: 1; padding: 10px 14px;
    background: #f4f4f5; border: none; border-radius: 22px;
    font-family: inherit; font-size: 14px;
    resize: none; outline: none;
    min-height: 40px; max-height: 120px;
    color: #111; line-height: 1.45;
    transition: background 0.14s;
  }
  #input::placeholder { color: #aaa; }
  #input:focus { background: #ececed; }

  #send-btn {
    width: 38px; height: 38px; flex-shrink: 0;
    background: ${ACCENT}; color: #fff;
    border: none; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    transition: opacity 0.14s, transform 0.12s;
  }
  #send-btn:hover:not(:disabled) { transform: scale(1.08); }
  #send-btn:disabled { opacity: 0.32; cursor: not-allowed; }
  #send-btn:focus-visible { outline: 2px solid #fff; outline-offset: -3px; }
  #send-btn svg { width: 16px; height: 16px; pointer-events: none; margin-left: 2px; }

  #char-hint {
    font-size: 11px; color: #f97316; text-align: right;
    padding: 0 14px 6px; flex-shrink: 0; display: none;
  }
  #char-hint.visible { display: block; }
  #char-hint.over { color: #ef4444; font-weight: 600; }

  .suggestions { align-self: flex-start; display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 0 6px; }
  .suggestion-btn {
    background: none; border: 1px solid ${ACCENT}; color: ${ACCENT};
    border-radius: 20px; padding: 5px 12px;
    font-family: inherit; font-size: 13px; cursor: pointer;
    transition: background 0.14s, color 0.14s; white-space: nowrap;
  }
  .suggestion-btn:hover { background: ${ACCENT}; color: #fff; }
  .suggestion-btn:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: 2px; }

  @media (max-width: 440px) {
    #panel { width: calc(100vw - 32px); right: -8px; bottom: 68px; }
  }
</style>

<button id="toggle" aria-label="Open chat" aria-expanded="false" aria-controls="panel">
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>
  </svg>
</button>

<div id="panel" role="dialog" aria-label="${BOT_NAME} chat" aria-modal="false">
  <div id="panel-header">
    <div id="header-left">
      <div id="avatar" aria-hidden="true">${AVATAR_LETTER}</div>
      <div id="header-info">
        <div id="header-name">${BOT_NAME}</div>
        <div id="header-status">Online</div>
      </div>
    </div>
    <button id="close-btn" aria-label="Close chat">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
      </svg>
    </button>
  </div>
  <div id="messages" role="log" aria-live="polite" aria-label="Chat messages"></div>
  <div id="char-hint" aria-live="polite"></div>
  <div id="input-area">
    <textarea
      id="input"
      placeholder="Ask me anything..."
      rows="1"
      aria-label="Type your message"
      aria-multiline="true"
    ></textarea>
    <button id="send-btn" aria-label="Send message">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
      </svg>
    </button>
  </div>
</div>`;

  // Element refs
  const toggleBtn  = shadow.getElementById('toggle');
  const panel      = shadow.getElementById('panel');
  const closeBtn   = shadow.getElementById('close-btn');
  const messagesEl = shadow.getElementById('messages');
  const inputEl    = shadow.getElementById('input');
  const sendBtn    = shadow.getElementById('send-btn');
  const charHint   = shadow.getElementById('char-hint');

  // Panel open / close
  function openPanel() {
    isOpen = true;
    panel.classList.add('open');
    toggleBtn.setAttribute('aria-expanded', 'true');
    toggleBtn.setAttribute('aria-label', 'Close chat');
    inputEl.focus();
    fetchWidgetConfig();
  }

  function closePanel() {
    isOpen = false;
    panel.classList.remove('open');
    toggleBtn.setAttribute('aria-expanded', 'false');
    toggleBtn.setAttribute('aria-label', 'Open chat');
    toggleBtn.focus();
  }

  toggleBtn.addEventListener('click', () => isOpen ? closePanel() : openPanel());
  closeBtn.addEventListener('click', closePanel);

  shadow.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) { e.preventDefault(); closePanel(); }
  });

  // Input behaviour
  sendBtn.addEventListener('click', handleSend);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });
  inputEl.addEventListener('input', () => {
    const len = inputEl.value.length;
    const nearLimit = len > MAX_LENGTH * 0.8;
    charHint.textContent = `${len} / ${MAX_LENGTH}`;
    charHint.classList.toggle('visible', nearLimit);
    charHint.classList.toggle('over', len > MAX_LENGTH);
    inputEl.style.height = 'auto';
    inputEl.style.height = inputEl.scrollHeight + 'px';
  });

  // Fetch suggested questions from worker on first open
  async function fetchWidgetConfig() {
    if (configFetched) return;
    configFetched = true;
    try {
      const resp = await fetch(`${WORKER_URL}/widget-config`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return;
      const cfg = await resp.json();
      if (history.length > 0) return;
      if (Array.isArray(cfg.suggestedQuestions) && cfg.suggestedQuestions.length) {
        showSuggestions(cfg.suggestedQuestions);
      }
    } catch {
      // non-critical: silently ignore
    }
  }

  function showSuggestions(questions) {
    if (suggestionsEl) { suggestionsEl.remove(); suggestionsEl = null; }
    const row = document.createElement('div');
    row.className = 'suggestions';
    for (const q of questions) {
      if (typeof q !== 'string' || !q.trim()) continue;
      const btn = document.createElement('button');
      btn.className = 'suggestion-btn';
      btn.textContent = q;
      btn.addEventListener('click', () => {
        if (suggestionsEl) { suggestionsEl.remove(); suggestionsEl = null; }
        inputEl.value = q;
        inputEl.dispatchEvent(new Event('input'));
        handleSend();
      });
      row.appendChild(btn);
    }
    if (row.childElementCount === 0) return;
    suggestionsEl = row;
    messagesEl.appendChild(row);
    scrollToBottom();
  }

  // Send flow
  async function handleSend() {
    if (isWaiting) return;
    const message = inputEl.value.trim();
    if (!message) return;
    if (message.length > MAX_LENGTH) {
      showError(`Please keep your message under ${MAX_LENGTH} characters.`);
      return;
    }

    if (suggestionsEl) { suggestionsEl.remove(); suggestionsEl = null; }
    setWaiting(true);
    appendMessage('user', message);
    clearInput();
    const typingEl = showTyping();

    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const { reply, cta } = await sendToWorker(message, controller.signal);
      history.push({ role: 'user',      content: message });
      history.push({ role: 'assistant', content: reply });
      appendMessage('bot', reply);
      if (cta?.length) {
        const unseen = cta.filter(c => !ctasShown.has(c.href));
        if (unseen.length) { appendCTAs(unseen); unseen.forEach(c => ctasShown.add(c.href)); }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        showError('The request timed out. Please try again.');
      } else {
        showError(err.message || 'Something went wrong. Please try again.');
      }
    } finally {
      clearTimeout(timeout);
      typingEl.remove();
      setWaiting(false);
      inputEl.focus();
    }
  }

  async function sendToWorker(message, signal) {
    const headers = { 'Content-Type': 'application/json' };
    if (WIDGET_TOKEN) headers['X-Widget-Token'] = WIDGET_TOKEN;

    const response = await fetch(`${WORKER_URL}/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message, history }),
      signal,
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return { reply: data.reply, cta: data.cta ?? null };
  }

  // UI helpers
  function appendMessage(role, text) {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    el.appendChild(linkify(text));
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function showError(text) { appendMessage('error', text); }

  function showTyping() {
    const el = document.createElement('div');
    el.className = 'typing';
    el.setAttribute('aria-label', 'Assistant is typing');
    el.setAttribute('role', 'status');
    el.innerHTML = '<span></span><span></span><span></span>';
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function appendCTAs(ctas) {
    const row = document.createElement('div');
    row.className = 'cta-row';
    for (const item of ctas) {
      const icon = CTA_ICONS[item.type] || CTA_ICONS.custom;
      if (!icon) continue;
      const a = document.createElement('a');
      a.className = 'cta-btn';
      a.dataset.type = item.type;
      a.href   = item.href;
      a.target = '_blank';
      a.rel    = 'noopener noreferrer';
      a.setAttribute('aria-label', item.label);
      a.title     = item.label;
      a.innerHTML = icon;
      row.appendChild(a);
    }
    messagesEl.appendChild(row);
    scrollToBottom();
  }

  // No innerHTML on user-supplied text: only on known SVG strings.
  function linkify(text) {
    const fragment = document.createDocumentFragment();
    const pattern  = /(\bhttps?:\/\/[^\s]+|\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g;
    let last = 0, match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > last) {
        fragment.appendChild(document.createTextNode(text.slice(last, match.index)));
      }
      const a   = document.createElement('a');
      const raw = match[0];
      a.href   = raw.includes('@') && !raw.startsWith('http') ? `mailto:${raw}` : raw;
      a.textContent = raw;
      a.target = '_blank';
      a.rel    = 'noopener noreferrer';
      fragment.appendChild(a);
      last = pattern.lastIndex;
    }
    if (last < text.length) fragment.appendChild(document.createTextNode(text.slice(last)));
    return fragment;
  }

  function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

  function clearInput() {
    inputEl.value = '';
    inputEl.style.height = 'auto';
    charHint.textContent = '';
    charHint.classList.remove('visible', 'over');
  }

  function setWaiting(state) {
    isWaiting        = state;
    sendBtn.disabled = state;
    inputEl.disabled = state;
  }

  // CTA icons (SVG strings: not user input, safe to use as innerHTML)
  const CTA_ICONS = {
    email:    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>',
    linkedin: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>',
    github:   '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.51 11.51 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/></svg>',
    whatsapp: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>',
    sms:      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg>',
    calendar: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z"/></svg>',
    custom:   '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>',
  };

  // Init
  appendMessage('bot', WELCOME);
})();
