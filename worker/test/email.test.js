import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateLead, guardSendRate, sendOwnerEmail } from '../src/email.js';

const config = {
  botName: 'Gil Bot',
  ownerName: 'Gil Avraham',
  contactMethods: { email: 'hello@squarenumbers.co.uk' },
  leadCapture: {
    enabled: true,
    notifyEmail: 'hello@squarenumbers.co.uk',
    fromAddress: 'bot@send.squarenumbers.co.uk',
    fromName: 'Gil Bot',
  },
};

const ok = extra => ({ email: 'sam@acme.com', reason: 'Please call me back.', confirmed: true, ...extra });

describe('validateLead: explicit approval', () => {
  it.each([
    ['confirmed missing',   undefined],
    ['confirmed false',     false],
    ['confirmed as string', 'yes'],
    ['confirmed as 1',      1],
  ])('refuses to send when %s', (_label, confirmed) => {
    const r = validateLead(ok({ confirmed }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not confirmed');
  });

  it('sends only when the visitor explicitly agreed', () => {
    expect(validateLead(ok()).ok).toBe(true);
  });
});

describe('validateLead: contact route', () => {
  it('accepts a complete lead and trims the fields', () => {
    const r = validateLead({ name: '  Sam  ', email: ' sam@acme.com ', reason: '  Please call me back.  ', confirmed: true });
    expect(r.ok).toBe(true);
    expect(r.lead.name).toBe('Sam');
    expect(r.lead.email).toBe('sam@acme.com');
    expect(r.lead.reason).toBe('Please call me back.');
  });

  it('leaves the name empty rather than inventing a placeholder', () => {
    expect(validateLead(ok()).lead.name).toBe('');
  });

  it('accepts a phone number on its own', () => {
    const r = validateLead({ phone: '+44 7700 900123', reason: 'Please call me back.', confirmed: true });
    expect(r.ok).toBe(true);
    expect(r.lead.phone).toBe('+44 7700 900123');
    expect(r.lead.email).toBe('');
  });

  it('accepts a LinkedIn profile on its own', () => {
    const r = validateLead({ linkedin: 'https://www.linkedin.com/in/sam-jones', reason: 'Please call me back.', confirmed: true });
    expect(r.ok).toBe(true);
    expect(r.lead.linkedin).toBe('https://www.linkedin.com/in/sam-jones');
  });

  it.each([
    ['no contact at all',      { reason: 'Please call me back.', confirmed: true }, 'missing contact'],
    ['malformed email',        ok({ email: 'not-an-address' }), 'invalid contact'],
    ['email with no at sign',  ok({ email: 'sam.acme.com' }), 'invalid contact'],
    ['phone that is words',    { phone: 'call me', reason: 'Please call me back.', confirmed: true }, 'invalid contact'],
    ['phone too short',        { phone: '12345', reason: 'Please call me back.', confirmed: true }, 'invalid contact'],
    ['phone too long',         { phone: '1234567890123456789', reason: 'Please call me back.', confirmed: true }, 'invalid contact'],
    ['linkedin without path',  { linkedin: 'linkedin.com', reason: 'Please call me back.', confirmed: true }, 'invalid contact'],
    ['the word linkedin',      { linkedin: 'my linkedin', reason: 'Please call me back.', confirmed: true }, 'invalid contact'],
  ])('rejects %s', (_label, input, expected) => {
    const r = validateLead(input);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(expected);
  });

  it('drops an unusable route but still sends on a valid one', () => {
    const r = validateLead({ email: 'rubbish', phone: '+44 7700 900123', reason: 'Please call me back.', confirmed: true });
    expect(r.ok).toBe(true);
    expect(r.lead.email).toBe('');
    expect(r.lead.phone).toBe('+44 7700 900123');
  });
});

describe('validateLead: reason for contact', () => {
  it.each([
    ['missing', undefined],
    ['blank',   '   '],
    ['too short', 'hi'],
  ])('rejects a reason that is %s', (_label, reason) => {
    const r = validateLead(ok({ reason }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('reason too short');
  });

  it('caps an overlong reason rather than rejecting it', () => {
    const r = validateLead(ok({ reason: 'x'.repeat(5000) }));
    expect(r.ok).toBe(true);
    expect(r.lead.reason.length).toBe(1500);
  });
});

describe('guardSendRate', () => {
  it('allows the first three sends from an address and blocks the fourth', () => {
    const ip = `1.2.3.${Math.random()}`;
    expect(guardSendRate(ip)).toBeNull();
    expect(guardSendRate(ip)).toBeNull();
    expect(guardSendRate(ip)).toBeNull();
    expect(guardSendRate(ip)).not.toBeNull();
  });

  it('tracks each address separately', () => {
    const a = `a.${Math.random()}`;
    const b = `b.${Math.random()}`;
    guardSendRate(a); guardSendRate(a); guardSendRate(a); guardSendRate(a);
    expect(guardSendRate(b)).toBeNull();
  });
});

describe('sendOwnerEmail', () => {
  const lead = { name: 'Sam', email: 'sam@acme.com', phone: '', linkedin: '', reason: 'Please call me back.' };

  beforeEach(() => { global.fetch = vi.fn(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('posts to Resend with the visitor as reply-to and reports success', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ id: 'x' }) });

    expect(await sendOwnerEmail(lead, { RESEND_API_KEY: 'key' }, config)).toBe(true);

    const [url, opts] = global.fetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(url).toBe('https://api.resend.com/emails');
    expect(opts.headers.Authorization).toBe('Bearer key');
    expect(body.from).toBe('Gil Bot <bot@send.squarenumbers.co.uk>');
    expect(body.to).toEqual(['hello@squarenumbers.co.uk']);
    expect(body.reply_to).toBe('sam@acme.com');
    expect(body.text).toContain('Please call me back.');
    expect(body.text).toContain('sam@acme.com');
    expect(body.subject).toBe('New enquiry from Sam');
    expect(body.html).toContain('Sam got in touch through the website');
    expect(body.html).toContain('mailto:sam@acme.com');
  });

  it('names no one when the visitor did not give a name', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ id: 'x' }) });
    const anon = { ...lead, name: '' };

    await sendOwnerEmail(anon, { RESEND_API_KEY: 'key' }, config);

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.subject).toBe('New enquiry from the website');
    expect(body.html).toContain('Someone got in touch');
    expect(body.html).not.toContain('Not given');
    expect(body.text).not.toContain('Not given');
  });

  it('escapes anything the visitor typed so it cannot become markup', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ id: 'x' }) });
    const nasty = { ...lead, name: '<script>alert(1)</script>', reason: 'a & b <b>bold</b>' };

    await sendOwnerEmail(nasty, { RESEND_API_KEY: 'key' }, config);

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.html).not.toContain('<script>');
    expect(body.html).toContain('&lt;script&gt;');
    expect(body.html).toContain('a &amp; b');
  });

  it('omits reply-to and names the route when there is no email address', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ id: 'x' }) });
    const phoneOnly = { name: 'Sam', email: '', phone: '+44 7700 900123', linkedin: '', reason: 'Please call me back.' };

    expect(await sendOwnerEmail(phoneOnly, { RESEND_API_KEY: 'key' }, config)).toBe(true);

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.reply_to).toBeUndefined();
    expect(body.text).toContain('+44 7700 900123');
    expect(body.text).toContain('did not leave an email address');
  });

  it('fails cleanly when the key is missing, without calling out', async () => {
    expect(await sendOwnerEmail(lead, {}, config)).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fails cleanly when the sending address is not configured', async () => {
    const bare = { ...config, leadCapture: { enabled: true } };
    expect(await sendOwnerEmail(lead, { RESEND_API_KEY: 'key' }, bare)).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('reports failure when Resend rejects the request', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 422, text: async () => 'domain not verified' });
    expect(await sendOwnerEmail(lead, { RESEND_API_KEY: 'key' }, config)).toBe(false);
  });

  it('reports failure when the request throws', async () => {
    global.fetch.mockRejectedValue(new Error('timeout'));
    expect(await sendOwnerEmail(lead, { RESEND_API_KEY: 'key' }, config)).toBe(false);
  });
});
