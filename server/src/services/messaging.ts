/**
 * Messaging providers (real HTTP integrations; credentials per restaurant, encrypted at rest).
 *  - SMS:       Twilio Programmable Messaging   (POST /2010-04-01/Accounts/{sid}/Messages.json)
 *  - WhatsApp:  Twilio WhatsApp sender (same account; WhatsApp requires approved templates outside a
 *               24-hour customer session — Twilio rejects free-form marketing text otherwise)
 *  - Email:     SendGrid v3 mail/send
 *  - Push:      not implemented (needs Web Push subscriptions + VAPID keys)
 * "sent" means the provider ACCEPTED the message. "delivered" is only recorded from a provider status
 * callback (Twilio status webhook, signature-verified). SendGrid delivery events are not processed.
 */
import crypto from 'node:crypto';
import type { Types } from 'mongoose';
import { Tenant } from '../models/platform';
import { decryptSecret } from '../lib/crypto';
import { env } from '../config/env';

export type Channel = 'sms' | 'whatsapp' | 'email';
export class ProviderError extends Error {
  constructor(message: string, public retryable: boolean, public status?: number) {
    super(message);
  }
}
export interface OutboundMessage {
  to: string;
  subject?: string;
  body: string;
}
export interface Provider {
  name: string;
  send(m: OutboundMessage): Promise<{ providerMessageId: string; providerStatus: string }>;
  verify(): Promise<void>;
}

async function http(url: string, init: RequestInit) {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new ProviderError('Messaging provider unreachable', true);
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const msg = json?.message ?? json?.errors?.[0]?.message ?? `HTTP ${res.status}`;
    throw new ProviderError(`Provider rejected the request: ${msg}`, res.status === 429 || res.status >= 500, res.status);
  }
  return { res, json };
}

export function twilioStatusCallbackUrl(tenantId: string) {
  return `${env.PUBLIC_API_URL}/api/webhooks/twilio/${tenantId}`;
}

function twilio(accountSid: string, authToken: string, from: string, tenantId: string, whatsapp: boolean): Provider {
  const auth = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  return {
    name: whatsapp ? 'twilio-whatsapp' : 'twilio',
    async send(m) {
      const body = new URLSearchParams({ To: whatsapp ? `whatsapp:${m.to}` : m.to, From: whatsapp ? `whatsapp:${from}` : from, Body: m.body, StatusCallback: twilioStatusCallbackUrl(tenantId) });
      const { json } = await http(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      if (!json?.sid) throw new ProviderError('Provider response had no message id', false);
      return { providerMessageId: json.sid, providerStatus: json.status ?? 'queued' };
    },
    async verify() {
      await http(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}.json`, { headers: { Authorization: auth } });
    },
  };
}

function sendgrid(apiKey: string, from: string): Provider {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  return {
    name: 'sendgrid',
    async send(m) {
      const { res } = await http('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers,
        body: JSON.stringify({ personalizations: [{ to: [{ email: m.to }] }], from: { email: from }, subject: m.subject ?? '', content: [{ type: 'text/plain', value: m.body }] }),
      });
      return { providerMessageId: res.headers.get('x-message-id') ?? `sendgrid-${crypto.randomUUID()}`, providerStatus: 'accepted' };
    },
    async verify() {
      await http('https://api.sendgrid.com/v3/scopes', { headers });
    },
  };
}

/** The configured provider for a channel, or null when the restaurant has not set one up. */
export async function providerFor(tenantId: Types.ObjectId | string, channel: Channel): Promise<Provider | null> {
  const t = await Tenant.findById(tenantId).select('+messaging.sms.authTokenEnc +messaging.email.apiKeyEnc').lean();
  const m: any = t?.messaging ?? {};
  if (channel === 'sms' || channel === 'whatsapp') {
    const sms = m.sms ?? {};
    if (sms.provider !== 'twilio' || !sms.accountSid || !sms.authTokenEnc) return null;
    const from = channel === 'sms' ? sms.from : m.whatsapp?.provider === 'twilio' ? m.whatsapp.from : null;
    if (!from) return null;
    return twilio(sms.accountSid, decryptSecret(sms.authTokenEnc, env.ENCRYPTION_KEY), from, String(tenantId), channel === 'whatsapp');
  }
  const e = m.email ?? {};
  if (e.provider !== 'sendgrid' || !e.apiKeyEnc || !e.from) return null;
  return sendgrid(decryptSecret(e.apiKeyEnc, env.ENCRYPTION_KEY), e.from);
}

export async function twilioAuthToken(tenantId: string) {
  const t = await Tenant.findById(tenantId).select('+messaging.sms.authTokenEnc').lean();
  const enc = (t as any)?.messaging?.sms?.authTokenEnc;
  return enc ? decryptSecret(enc, env.ENCRYPTION_KEY) : null;
}

/** Twilio request validation: base64(HMAC-SHA1(authToken, url + Σ sorted(key + value))). */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}
export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string | undefined) {
  if (!signature) return false;
  const expected = twilioSignature(authToken, url, params);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** E.164 phone for a customer number; local numbers need the restaurant's country code (e.g. +92). */
export function toE164(phone: string | undefined, countryCode?: string) {
  if (!phone) return null;
  const p = phone.replace(/[^\d+]/g, '');
  if (/^\+[1-9]\d{6,14}$/.test(p)) return p;
  if (countryCode && /^\+\d{1,4}$/.test(countryCode) && /^0\d{6,14}$/.test(p)) return countryCode + p.slice(1);
  return null;
}
