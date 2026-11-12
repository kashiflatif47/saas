import { Types } from 'mongoose';
import { env } from '../config/env';
import { Tenant } from '../models/platform';
import { Order, Payment } from '../models/operations';
import { decryptSecret } from '../lib/crypto';
import { derivePaymentStatus } from '../lib/orderState';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import type { AuthUser } from '../types/express';
import { broadcastOrder, withOrderRetry } from './orderService';
import { notify } from './notify';

/* ============================================================================
 * Provider abstraction. Cash is fully functional. Stripe is a REAL integration
 * against the Stripe REST API (no SDK) but requires the tenant to configure
 * their own secret key + webhook secret. Nothing is marked "paid" until either:
 *   - a staff member records cash they physically collected, or
 *   - a signature-verified provider webhook confirms the charge.
 * ==========================================================================*/

export interface OnlineProvider {
  createIntent(args: { amount: number; currency: string; orderId: string; tenantId: string }): Promise<{ ref: string; clientSecret: string }>;
  refund(args: { ref: string; amount: number }): Promise<{ ref: string; succeeded: boolean }>;
  verifyCredentials(): Promise<boolean>;
}

class StripeProvider implements OnlineProvider {
  constructor(private secretKey: string) {}

  private async call(path: string, body?: Record<string, string>, method = 'POST') {
    let res: Response;
    try {
      res = await fetch(`https://api.stripe.com/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body ? new URLSearchParams(body).toString() : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      // Network failure or timeout: a clear 502 instead of an internal error.
      throw new AppError(502, 'Payment provider is unreachable. Please try again.', 'PROVIDER_UNREACHABLE');
    }
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new AppError(502, `Payment provider error: ${json?.error?.message ?? res.status}`, 'PROVIDER_ERROR');
    return json;
  }

  async createIntent({ amount, currency, orderId, tenantId }: { amount: number; currency: string; orderId: string; tenantId: string }) {
    const pi = await this.call('/payment_intents', {
      amount: String(amount),
      currency: currency.toLowerCase(),
      'automatic_payment_methods[enabled]': 'true',
      'metadata[orderId]': orderId,
      'metadata[tenantId]': tenantId,
    });
    return { ref: pi.id as string, clientSecret: pi.client_secret as string };
  }

  async refund({ ref, amount }: { ref: string; amount: number }) {
    const r = await this.call('/refunds', { payment_intent: ref, amount: String(amount) });
    return { ref: r.id as string, succeeded: r.status === 'succeeded' };
  }

  async verifyCredentials() {
    await this.call('/balance', undefined, 'GET');
    return true;
  }
}

export async function getOnlineProvider(tenantId: Types.ObjectId | string): Promise<{ provider: OnlineProvider; name: 'stripe'; webhookSecret?: string } | null> {
  const t = await Tenant.findById(tenantId).select('+payments.providerSecretEnc +payments.webhookSecretEnc').lean();
  const p = t?.payments;
  if (!p || p.provider !== 'stripe' || !p.providerSecretEnc) return null;
  const secret = decryptSecret(p.providerSecretEnc, env.ENCRYPTION_KEY);
  const webhookSecret = p.webhookSecretEnc ? decryptSecret(p.webhookSecretEnc, env.ENCRYPTION_KEY) : undefined;
  return { provider: new StripeProvider(secret), name: 'stripe', webhookSecret };
}

/** Recomputes order payment totals solely from VERIFIED payment records. */
export async function recomputeOrderPayments(tenantId: Types.ObjectId, orderId: Types.ObjectId | string) {
  // Retried on a version conflict so a concurrent kitchen/status change never loses the payment totals.
  // The order is read BEFORE the payments are summed, so any change that lands in between bumps the
  // order version and forces a fresh read and sum.
  const order = await withOrderRetry(async () => {
    const o = await Order.findOne({ tenantId, _id: orderId });
    if (!o) return null;
    const [agg] = await Payment.aggregate([
      { $match: { tenantId, orderId: o._id, status: 'verified' } },
      { $group: { _id: null, paid: { $sum: { $cond: [{ $eq: ['$kind', 'charge'] }, '$amount', 0] } }, refunded: { $sum: { $cond: [{ $eq: ['$kind', 'refund'] }, '$amount', 0] } } } },
    ]);
    o.amountPaid = agg?.paid ?? 0;
    o.amountRefunded = agg?.refunded ?? 0;
    o.paymentStatus = derivePaymentStatus(o.total, o.amountPaid, o.amountRefunded);
    if (o.amountRefunded > 0 && o.amountRefunded >= o.amountPaid && ['completed', 'cancelled'].includes(o.status)) {
      o.status = 'refunded';
      o.statusHistory.push({ status: 'refunded', at: new Date(), by: 'system' });
    }
    await o.save();
    return o;
  });
  if (!order) return null;
  broadcastOrder(String(tenantId), order.toObject());
  return order;
}

function outstanding(order: { total: number; amountPaid: number }) {
  return Math.max(0, order.total - order.amountPaid);
}

/** Cash collected by staff: verified immediately by the collecting staff member (recorded for audit). */
export interface CashPaymentOptions {
  /** What this payment covers (split bill). The amount must already be computed on the server. */
  allocation?: { mode: 'equal' | 'items' | 'amount'; part?: number; parts?: number; label?: string; items?: { itemId: string; quantity: number }[] };
  /** Repeating a request with the same key returns the first payment instead of charging again. */
  idempotencyKey?: string;
  /** The collecting cashier's open shift (cash drawer), if any. */
  shiftId?: Types.ObjectId;
}

export async function recordCashPayment(tenantId: Types.ObjectId, orderId: string, amount: number, actor: AuthUser, method: 'cash' | 'card_terminal' = 'cash', opts: CashPaymentOptions = {}) {
  if (opts.idempotencyKey) {
    const prior = await Payment.findOne({ tenantId, idempotencyKey: opts.idempotencyKey }).lean();
    if (prior) {
      if (String(prior.orderId) !== String(orderId)) throw conflict('This payment key was already used for another order');
      return prior;
    }
  }
  const order = await Order.findOne({ tenantId, _id: orderId }).lean();
  if (!order) throw notFound('Order not found');
  // Same rule as online payments: nothing is collected for an order that will not be served.
  if (['rejected', 'cancelled', 'refunded'].includes(order.status)) throw badRequest('Order cannot accept payments');
  const due = outstanding(order);
  if (due <= 0) throw badRequest('Order is already fully paid');
  if (amount > due) throw badRequest(`Amount exceeds outstanding balance (${due})`);
  // Claim the amount atomically against the balance we just checked. A concurrent collection (double
  // click, two cashiers) changes amountPaid first, so this compare-and-set fails instead of over-collecting.
  // __v is bumped so an in-flight read-modify-save of this order is retried rather than overwriting it.
  const claim = await Order.updateOne(
    { tenantId, _id: orderId, amountPaid: order.amountPaid, status: { $nin: ['rejected', 'cancelled', 'refunded'] } },
    { $inc: { amountPaid: amount, __v: 1 } },
  );
  if (claim.modifiedCount !== 1) {
    if (opts.idempotencyKey) {
      const prior = await Payment.findOne({ tenantId, idempotencyKey: opts.idempotencyKey }).lean();
      if (prior) return prior;
    }
    throw conflict('This order was just updated (perhaps already paid). Refresh and try again.');
  }
  let payment;
  try {
    payment = await Payment.create({
    tenantId,
    orderId,
    kind: 'charge',
    method,
    provider: method === 'cash' ? 'cash' : 'manual',
    amount,
    currency: order.currency,
    status: 'verified',
    verifiedAt: new Date(),
    verifiedBy: actor.id,
    shiftId: opts.shiftId,
    allocation: opts.allocation,
    idempotencyKey: opts.idempotencyKey,
    });
  } catch (e: any) {
    // Same key submitted twice at the same moment: the loser returns the winner's payment.
    if (e?.code === 11000 && e?.keyPattern?.idempotencyKey && opts.idempotencyKey) {
      await recomputeOrderPayments(tenantId, orderId);
      const prior = await Payment.findOne({ tenantId, idempotencyKey: opts.idempotencyKey }).lean();
      if (prior) return prior;
    }
    throw e;
  } finally {
    // Always re-derive the totals from verified payment records: this confirms the claim on success and
    // releases it if the payment record could not be written.
    await recomputeOrderPayments(tenantId, orderId);
  }
  return payment;
}

/** Customer starts an online payment. Creates a PENDING payment; only the webhook can verify it. */
export async function startOnlinePayment(tenantId: Types.ObjectId, orderId: string, amount?: number) {
  const prov = await getOnlineProvider(tenantId);
  if (!prov) throw new AppError(400, 'Online payments are not configured for this restaurant', 'PROVIDER_NOT_CONFIGURED');
  const order = await Order.findOne({ tenantId, _id: orderId }).lean();
  if (!order) throw notFound('Order not found');
  if (['rejected', 'cancelled', 'refunded'].includes(order.status)) throw badRequest('Order cannot accept payments');
  const due = outstanding(order);
  const amt = amount ?? due;
  if (amt <= 0 || amt > due) throw badRequest('Invalid payment amount');
  // Pressing "Pay" again (or reloading) must not open a second payable intent for the same balance:
  // two confirmed intents would charge the customer twice. Reuse the open one.
  const open = await Payment.findOne({ tenantId, orderId: order._id, kind: 'charge', provider: prov.name, status: 'pending', amount: amt })
    .select('+clientSecret')
    .sort({ createdAt: -1 })
    .lean();
  if (open?.clientSecret) return { paymentId: open._id, clientSecret: open.clientSecret, provider: prov.name };
  const { ref, clientSecret } = await prov.provider.createIntent({ amount: amt, currency: order.currency, orderId: String(order._id), tenantId: String(tenantId) });
  const p = await Payment.create({ tenantId, orderId, kind: 'charge', method: 'online', provider: prov.name, amount: amt, currency: order.currency, status: 'pending', providerRef: ref, clientSecret });
  return { paymentId: p._id, clientSecret, provider: prov.name };
}

/** Called ONLY from a signature-verified webhook. Idempotent. */
export async function handleVerifiedProviderEvent(tenantId: Types.ObjectId, event: { type: string; data: { object: any } }) {
  const obj = event.data.object;
  if (event.type === 'payment_intent.succeeded' || event.type === 'payment_intent.payment_failed') {
    const p = await Payment.findOne({ tenantId, provider: 'stripe', providerRef: obj.id, kind: 'charge' });
    if (!p) return { ignored: 'unknown payment' };
    if (p.status === 'verified') return { ok: true, idempotent: true };
    if (obj.metadata?.tenantId !== String(tenantId)) return { ignored: 'tenant mismatch' };
    if (event.type === 'payment_intent.succeeded') {
      if (obj.amount_received !== p.amount || String(obj.currency).toUpperCase() !== p.currency.toUpperCase()) {
        p.status = 'failed';
        p.reason = 'Amount/currency mismatch';
      } else {
        p.status = 'verified';
        p.verifiedAt = new Date();
      }
    } else {
      p.status = 'failed';
      p.reason = obj.last_payment_error?.message ?? 'Payment failed';
    }
    p.raw = { id: obj.id, status: obj.status };
    await p.save();
    await recomputeOrderPayments(tenantId, p.orderId);
    if (p.status === 'verified') await notify(tenantId, { type: 'payment.verified', title: 'Online payment verified', body: `Order payment ${p.amount} ${p.currency}`, roles: ['owner', 'admin', 'manager', 'cashier'] });
    return { ok: true };
  }
  if (event.type === 'refund.updated' || event.type === 'refund.created') {
    const p = await Payment.findOne({ tenantId, provider: 'stripe', providerRef: obj.id, kind: 'refund' });
    if (!p) return { ignored: 'unknown refund' };
    if (obj.status === 'succeeded' && p.status !== 'verified') {
      p.status = 'verified';
      p.verifiedAt = new Date();
      await p.save();
      await recomputeOrderPayments(tenantId, p.orderId);
    } else if (obj.status === 'failed') {
      p.status = 'failed';
      await p.save();
    }
    return { ok: true };
  }
  return { ignored: event.type };
}

/** Refunds against verified charges. Cash refunds are verified by the acting staff; online refunds via provider. */
export async function refundPayment(tenantId: Types.ObjectId, paymentId: string, amount: number, reason: string, actor: AuthUser, shiftId?: Types.ObjectId) {
  const charge = await Payment.findOne({ tenantId, _id: paymentId, kind: 'charge', status: 'verified' });
  if (!charge) throw notFound('Verified payment not found');
  const [agg] = await Payment.aggregate([
    { $match: { tenantId, kind: 'refund', providerRef: { $exists: true }, 'raw.chargeId': String(charge._id), status: { $in: ['pending', 'verified'] } } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const already = agg?.total ?? 0;
  if (amount <= 0 || amount + already > charge.amount) throw badRequest(`Refund exceeds refundable amount (${charge.amount - already})`);

  if (charge.provider === 'stripe') {
    const prov = await getOnlineProvider(tenantId);
    if (!prov) throw badRequest('Payment provider no longer configured');
    const r = await prov.provider.refund({ ref: charge.providerRef!, amount });
    const p = await Payment.create({
      tenantId, orderId: charge.orderId, kind: 'refund', method: 'online', provider: 'stripe', amount, currency: charge.currency,
      status: r.succeeded ? 'verified' : 'pending', verifiedAt: r.succeeded ? new Date() : undefined, providerRef: r.ref, reason, raw: { chargeId: String(charge._id) },
    });
    await recomputeOrderPayments(tenantId, charge.orderId);
    return p;
  }
  const p = await Payment.create({
    tenantId, orderId: charge.orderId, kind: 'refund', method: charge.method, provider: charge.provider, amount, currency: charge.currency,
    status: 'verified', verifiedAt: new Date(), verifiedBy: actor.id, providerRef: `manual-${Date.now()}`, reason, raw: { chargeId: String(charge._id) },
    // Cash handed back comes out of the refunding cashier's drawer.
    shiftId: charge.method === 'cash' ? shiftId : undefined,
  });
  await recomputeOrderPayments(tenantId, charge.orderId);
  return p;
}
