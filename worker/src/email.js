/**
 * email.js: Sends a visitor's message to the owner via Resend.
 *
 * Used by the lead-capture tool call in index.js. The visitor never sees the
 * owner's inbox and the owner never sees a raw LLM payload: everything that
 * reaches the email body is validated and length-capped here first.
 *
 * Envelope:
 *   From:     the configured sending identity on the verified Resend domain
 *   To:       leadCapture.notifyEmail (falls back to contactMethods.email)
 *   Reply-To: the visitor's own address, so replying goes straight back to them
 *
 * Requires the RESEND_API_KEY secret. If it is missing, sending fails cleanly
 * and the visitor is told to use the contact buttons instead.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// Deliberately loose: it rejects obvious rubbish without bouncing real,
// unusual addresses. The real validation is that a reply has to reach them.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

// A usable phone number: 7 to 15 digits once punctuation is stripped, which is
// the international range. Rejects "call me" and "12345".
const PHONE_DIGITS_MIN = 7;
const PHONE_DIGITS_MAX = 15;

// Must be a real LinkedIn profile or company URL, not just the word "linkedin".
const LINKEDIN_PATTERN = /^(https?:\/\/)?([a-z]{2,3}\.)?linkedin\.com\/(in|company|pub)\/[^\s/]+/i;

const MAX_NAME_CHARS    = 80;
const MAX_EMAIL_CHARS   = 254;
const MAX_PHONE_CHARS   = 32;
const MAX_MESSAGE_CHARS = 1500;

// Per-IP cap on how many messages can actually be sent, so a single visitor
// cannot use the bot as a mail relay. In-memory per isolate, like the chat
// rate limit: approximate under load, which is fine for this purpose.
const sendStore = new Map();
const SEND_WINDOW_MS = 60 * 60 * 1000; // one hour
const MAX_SENDS_PER_WINDOW = 3;

// Checks and normalises what the model collected from the visitor.
// Returns { ok: true, lead } or { ok: false, reason } — reason drives which
// follow-up question the visitor is asked, and is also written to the logs.
//
// Three things must hold before anything is sent:
//   confirmed  the visitor explicitly agreed to it being sent
//   contact    at least one contact route that passes its own format check
//   reason     why they want to be contacted, in their own words
export function validateLead({ name, email, phone, linkedin, reason, confirmed }) {
  const clean = v => (typeof v === 'string' ? v.trim() : '');

  const cleanName     = clean(name).slice(0, MAX_NAME_CHARS);
  const cleanEmail    = clean(email).slice(0, MAX_EMAIL_CHARS);
  const cleanPhone    = clean(phone).slice(0, MAX_PHONE_CHARS);
  const cleanLinkedin = clean(linkedin);
  const cleanReason   = clean(reason).slice(0, MAX_MESSAGE_CHARS);

  if (confirmed !== true) return { ok: false, reason: 'not confirmed' };

  // Each route is kept only if it actually validates, so a malformed entry is
  // dropped rather than passed on as if it were usable.
  const validEmail    = EMAIL_PATTERN.test(cleanEmail) ? cleanEmail : '';
  const digits        = cleanPhone.replace(/\D/g, '');
  const validPhone    = digits.length >= PHONE_DIGITS_MIN && digits.length <= PHONE_DIGITS_MAX ? cleanPhone : '';
  const validLinkedin = LINKEDIN_PATTERN.test(cleanLinkedin) ? cleanLinkedin : '';

  if (!validEmail && !validPhone && !validLinkedin) {
    // Distinguish "gave nothing" from "gave something unusable": the visitor
    // who mistyped an address should be told, not asked as if they said nothing.
    const attempted = cleanEmail || cleanPhone || cleanLinkedin;
    return { ok: false, reason: attempted ? 'invalid contact' : 'missing contact' };
  }

  if (cleanReason.length < 5) return { ok: false, reason: 'reason too short' };

  return {
    ok: true,
    lead: {
      // Empty rather than a placeholder: the email templates simply leave the
      // name out when it is missing, which reads better than "Not given".
      name:     cleanName,
      email:    validEmail,
      phone:    validPhone,
      linkedin: validLinkedin,
      reason:   cleanReason,
    },
  };
}

// Returns null when this IP may still send, or a reason string when it may not.
export function guardSendRate(ip) {
  const now   = Date.now();
  const entry = sendStore.get(ip);

  if (!entry || now - entry.windowStart > SEND_WINDOW_MS) {
    sendStore.set(ip, { count: 1, windowStart: now });
    return null;
  }

  entry.count += 1;
  sendStore.set(ip, entry);

  if (entry.count > MAX_SENDS_PER_WINDOW) {
    console.warn(`[email] ${ip} exceeded the send limit (${entry.count} in the window)`);
    return 'send limit reached';
  }
  return null;
}

// Sends the message. Returns true on success, false on any failure: the caller
// decides what the visitor is told, so a provider outage never leaks upstream
// error text into a reply.
export async function sendOwnerEmail(lead, env, config) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[email] RESEND_API_KEY is not set: cannot send.');
    return false;
  }

  const capture   = config.leadCapture ?? {};
  const to        = capture.notifyEmail ?? config.contactMethods?.email;
  const fromName  = capture.fromName    ?? config.botName ?? 'Website assistant';
  const fromEmail = capture.fromAddress;

  if (!to || !fromEmail) {
    console.error('[email] leadCapture.notifyEmail or leadCapture.fromAddress is not configured.');
    return false;
  }

  const payload = {
    from:    `${fromName} <${fromEmail}>`,
    to:      [to],
    subject: lead.name ? `New enquiry from ${lead.name}` : 'New enquiry from the website',
    html:    buildHtmlBody(lead, config),
    text:    buildTextBody(lead, config),
  };

  // Only set reply-to when there is an address to reply to. A visitor who left
  // only a phone number or LinkedIn gets those in the body instead.
  if (lead.email) payload.reply_to = lead.email;

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body:   JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      console.error(`[email] Resend returned ${response.status}: ${await response.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[email] Send failed:', err);
    return false;
  }
}

// Plain text only: it renders identically everywhere and there is no markup for
// a visitor's wording to break out of.
// Opening line, written the way an assistant would introduce the enquiry.
// Shared by both versions so the two never say different things.
function buildIntro(lead) {
  const who = lead.name ? lead.name : 'Someone';
  return `${who} got in touch through the website. Their enquiry is below.`;
}

// Closing line: how to get back to them, given what they actually left.
function buildClosing(lead) {
  return lead.email
    ? 'Replying to this email goes straight to them.'
    : 'They did not leave an email address, so use the details above to reach them.';
}

// The contact rows, in the order they are most useful.
function contactRows(lead) {
  const rows = [];
  if (lead.name)     rows.push(['Name',     lead.name,     null]);
  if (lead.email)    rows.push(['Email',    lead.email,    `mailto:${lead.email}`]);
  if (lead.phone)    rows.push(['Phone',    lead.phone,    `tel:${lead.phone.replace(/[^\d+]/g, '')}`]);
  if (lead.linkedin) rows.push(['LinkedIn', lead.linkedin, absoluteUrl(lead.linkedin)]);
  return rows;
}

function absoluteUrl(url) {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

// Escapes anything a visitor typed before it goes near the HTML version, so
// their wording is shown as text and can never become markup.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Plain-text version, sent alongside the HTML for clients that prefer it.
function buildTextBody(lead, config) {
  const lines = [buildIntro(lead), ''];

  for (const [label, value] of contactRows(lead)) {
    lines.push(`${label.padEnd(9)} ${value}`);
  }

  lines.push('', 'Enquiry', lead.reason, '', buildClosing(lead), '', `Sent by ${config.botName ?? 'your assistant'}, ${config.ownerName ?? ''}'s website assistant.`.replace(' ,', ','));

  return lines.join('\n');
}

// HTML version. Deliberately restrained: system fonts, one accent rule, generous
// spacing, no images or external stylesheets. Every style is inline because mail
// clients strip stylesheets, and the layout is a single column so it holds up on
// a phone.
function buildHtmlBody(lead, config) {
  const accent  = config.ui?.accentColor ?? '#0055ff';
  const botName = escapeHtml(config.botName ?? 'Website assistant');
  const owner   = escapeHtml(config.ownerName ?? '');

  const rows = contactRows(lead).map(([label, value, href]) => {
    const shown = href
      ? `<a href="${escapeHtml(href)}" style="color:${accent};text-decoration:none;">${escapeHtml(value)}</a>`
      : escapeHtml(value);
    return `
        <tr>
          <td style="padding:6px 24px 6px 0;color:#6b7280;font-size:14px;white-space:nowrap;vertical-align:top;">${label}</td>
          <td style="padding:6px 0;color:#111827;font-size:14px;vertical-align:top;">${shown}</td>
        </tr>`;
  }).join('');

  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">
      <tr>
        <td style="padding:32px 32px 8px 32px;">
          <p style="margin:0 0 24px 0;color:#111827;font-size:15px;line-height:1.6;">${escapeHtml(buildIntro(lead))}</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">${rows}
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:24px 32px 8px 32px;">
          <p style="margin:0 0 8px 0;color:#6b7280;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;">Enquiry</p>
          <div style="border-left:3px solid ${accent};padding:2px 0 2px 16px;color:#111827;font-size:15px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(lead.reason)}</div>
        </td>
      </tr>
      <tr>
        <td style="padding:24px 32px 32px 32px;">
          <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.6;">${escapeHtml(buildClosing(lead))}</p>
          <p style="margin:20px 0 0 0;padding-top:16px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;line-height:1.6;">
            Sent by ${botName}, ${owner}'s website assistant.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
