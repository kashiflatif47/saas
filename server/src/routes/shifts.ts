import { Router } from 'express';
import { z } from 'zod';
import { CashShift } from '../models/operations';
import { ah } from '../lib/errors';
import { can } from '../middleware/auth';
import { checkIdParams, validateBody, validateQuery, zMoney, zPage } from '../middleware/validate';
import { roleHas } from '../config/permissions';
import { audit } from '../services/audit';
import { addMovement, closeShift, findOpenShift, loadShiftFor, openShift, shiftTotals } from '../services/shiftService';

/** Cash shifts / cash drawer. Every change is audited. */
export const shiftsRouter = Router();

shiftsRouter.get('/current', can('shifts:operate'), ah(async (req, res) => {
  const shift = await findOpenShift(req.tenantId!, req.user!.id);
  res.json({ shift, totals: shift ? await shiftTotals(req.tenantId!, shift) : null, required: !!req.tenant!.settings?.requireOpenShiftForCash });
}));

shiftsRouter.get('/', can('shifts:operate', 'shifts:manage'), validateQuery(zPage.extend({ status: z.enum(['open', 'closed']).optional() })), ah(async (req, res) => {
  const q = (req as any).validQuery;
  const filter: any = { tenantId: req.tenantId };
  // Cashiers see their own shifts; managers see everyone's.
  if (!roleHas(req.user!.role, 'shifts:manage', req.user!.permissionOverrides)) filter.cashierId = req.user!.id;
  if (q.status) filter.status = q.status;
  const [items, total] = await Promise.all([
    CashShift.find(filter).sort({ openedAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    CashShift.countDocuments(filter),
  ]);
  // Open shifts show live totals; closed shifts show the figures frozen at closing.
  const withTotals = await Promise.all(items.map(async (s) => (s.status === 'open' ? { ...s, live: await shiftTotals(req.tenantId!, s) } : s)));
  res.json({ items: withTotals, total, page: q.page, limit: q.limit });
}));

shiftsRouter.get('/:id', can('shifts:operate', 'shifts:manage'), checkIdParams, ah(async (req, res) => {
  const shift = await loadShiftFor(req.tenantId!, req.params.id, req.user!);
  res.json({ shift, totals: await shiftTotals(req.tenantId!, shift.toObject()) });
}));

shiftsRouter.post('/open', can('shifts:operate'), validateBody(z.object({ openingFloat: zMoney, notes: z.string().max(300).optional() })), ah(async (req, res) => {
  const shift = await openShift(req.tenantId!, req.user!, req.body.openingFloat, req.body.notes);
  await audit(req, 'shift.open', 'CashShift', shift._id, { openingFloat: req.body.openingFloat });
  res.status(201).json(shift);
}));

shiftsRouter.post('/:id/movements', can('shifts:operate', 'shifts:manage'), checkIdParams, validateBody(z.object({ type: z.enum(['in', 'out']), amount: zMoney.refine((n) => n > 0, 'Amount must be positive'), reason: z.string().min(3).max(200) })), ah(async (req, res) => {
  const shift = await addMovement(req.tenantId!, req.params.id, req.user!, req.body.type, req.body.amount, req.body.reason);
  await audit(req, `shift.cash_${req.body.type}`, 'CashShift', req.params.id, { amount: req.body.amount, reason: req.body.reason });
  res.status(201).json(shift);
}));

shiftsRouter.post('/:id/close', can('shifts:operate', 'shifts:manage'), checkIdParams, validateBody(z.object({ countedCash: zMoney, notes: z.string().max(500).optional() })), ah(async (req, res) => {
  const shift = await closeShift(req.tenantId!, req.params.id, req.user!, req.body.countedCash, req.body.notes);
  await audit(req, 'shift.close', 'CashShift', req.params.id, { countedCash: shift.countedCash, expectedCash: shift.expectedCash, discrepancy: shift.discrepancy });
  res.json(shift);
}));
