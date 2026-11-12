import { Router, raw, urlencoded } from 'express';
import { ah, badRequest } from '../lib/errors';
import { verifyStripeSignature } from '../lib/crypto';
import { isOid, oid } from '../models/tenantScope';
import { getOnlineProvider, handleVerifiedProviderEvent } from '../services/paymentService';
import { twilioAuthToken, twilioStatusCallbackUrl, verifyTwilioSignature } from '../services/messaging';
import { applyTwilioStatus } from '../services/marketing';

/**
 * Per-tenant webhook endpoint: POST /api/webhooks/stripe/:tenantId
 * Each tenant configures this URL in THEIR Stripe dashboard and pastes the signing secret in settings.
 * Raw body is required for signature verification, so this router is mounted BEFORE express.json().
 */
export const webhooksRouter = Router();

webhooksRouter.post('/stripe/:tenantId', raw({ type: 'application/json', limit: '1mb' }), ah(async (req, res) => {
  const { tenantId } = req.params;
  if (!isOid(tenantId)) throw badRequest('Invalid tenant');
  const prov = await getOnlineProvider(tenantId);
  if (!prov?.webhookSecret) return void res.status(400).json({ error: { message: 'Webhook not configured' } });
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || !verifyStripeSignature(body, req.get('stripe-signature'), prov.webhookSecret)) {
    return void res.status(400).json({ error: { message: 'Invalid signature' } });
  }
  const event = JSON.parse(body.toString('utf8'));
  const result = await handleVerifiedProviderEvent(oid(tenantId), event);
  res.json({ received: true, result });
}));

/**
 * Twilio message status callback: POST /api/webhooks/twilio/:tenantId (form-encoded).
 * Signed with the tenant's Twilio auth token over the exact callback URL we gave Twilio.
 * This is the ONLY source of "delivered" for SMS/WhatsApp; nothing else marks a message delivered.
 */
webhooksRouter.post('/twilio/:tenantId', urlencoded({ extended: false, limit: '64kb' }), ah(async (req, res) => {
  const { tenantId } = req.params;
  if (!isOid(tenantId)) throw badRequest('Invalid tenant');
  const token = await twilioAuthToken(tenantId);
  if (!token) return void res.status(400).json({ error: { message: 'Twilio not configured' } });
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.body ?? {})) if (typeof v === 'string') params[k] = v;
  if (!verifyTwilioSignature(token, twilioStatusCallbackUrl(tenantId), params, req.get('x-twilio-signature'))) {
    return void res.status(403).json({ error: { message: 'Invalid signature' } });
  }
  if (!params.MessageSid || !params.MessageStatus) throw badRequest('Missing MessageSid/MessageStatus');
  const r = await applyTwilioStatus(oid(tenantId), params.MessageSid, params.MessageStatus, params.ErrorCode);
  res.json({ received: true, ...r });
}));
