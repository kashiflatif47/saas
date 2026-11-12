import { Router } from 'express';
import { z } from 'zod';
import { Category, KitchenStation, Product } from '../models/menu';
import { InventoryItem } from '../models/inventory';
import { Plan } from '../models/platform';
import { ah, badRequest, notFound, paymentRequired } from '../lib/errors';
import { can } from '../middleware/auth';
import { checkIdParams, validateBody, validateQuery, zI18n, zI18nRequired, zMoney, zPage, zId, zHex } from '../middleware/validate';
import { uploadMemory, storeTenantImage, deleteTenantImage } from '../middleware/upload';
import { audit } from '../services/audit';
import { crudRouter } from './crudFactory';
import { emit } from '../sockets';

export const menuRouter = Router();

/** Open POS screens reload availability and prices when the menu changes. */
const menuChanged = (req: any) => emit.staff(String(req.tenantId), 'menu:updated', { at: Date.now() });

/* ------------------------------ Kitchen stations ------------------------------ */
menuRouter.use('/stations', crudRouter({
  model: KitchenStation,
  entity: 'KitchenStation',
  create: z.object({ name: z.string().min(1).max(60), color: zHex.optional(), isDefault: z.boolean().optional(), isActive: z.boolean().optional() }),
  viewPerm: 'menu:view',
  managePerm: 'menu:manage',
  defaultSort: { isDefault: -1, name: 1 },
  beforeSave: async (data, req) => {
    if (data.isDefault) await KitchenStation.updateMany({ tenantId: req.tenantId }, { $set: { isDefault: false } });
    return data;
  },
}));

/* ------------------------------ Categories ------------------------------ */
const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
const categorySchema = z.object({
  name: zI18nRequired,
  description: zI18n.optional(),
  parentId: zId.nullable().optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  stationId: zId.nullable().optional(),
  isActive: z.boolean().optional(),
  schedule: z.object({ days: z.array(z.number().int().min(0).max(6)).max(7), from: z.string().regex(timeRe).or(z.literal('')).optional(), to: z.string().regex(timeRe).or(z.literal('')).optional() }).optional(),
});

async function assertRefs(tenantId: any, body: any, selfId?: string) {
  if (body.parentId) {
    if (body.parentId === selfId) throw badRequest('A category cannot be its own parent');
    const parent = await Category.findOne({ tenantId, _id: body.parentId }).select('parentId').lean();
    if (!parent) throw badRequest('Parent category not found');
    if (parent.parentId) throw badRequest('Only two levels (category › subcategory) are supported');
    if (selfId && (await Category.exists({ tenantId, parentId: selfId }))) {
      throw badRequest('This category has subcategories, so it cannot become a subcategory itself');
    }
  }
  if (body.stationId && !(await KitchenStation.exists({ tenantId, _id: body.stationId }))) throw badRequest('Kitchen station not found');
}

menuRouter.get('/categories', can('menu:view'), ah(async (req, res) => {
  res.json({ items: await Category.find({ tenantId: req.tenantId }).sort({ sortOrder: 1, createdAt: 1 }).lean() });
}));

menuRouter.post('/categories', can('menu:manage'), validateBody(categorySchema), ah(async (req, res) => {
  await assertRefs(req.tenantId, req.body);
  const last = await Category.findOne({ tenantId: req.tenantId }).sort({ sortOrder: -1 }).select('sortOrder').lean();
  const c = await Category.create({ sortOrder: (last?.sortOrder ?? -1) + 1, ...req.body, tenantId: req.tenantId });
  await audit(req, 'category.create', 'Category', c._id);
  res.status(201).json(c);
}));

menuRouter.patch('/categories/:id', can('menu:manage'), checkIdParams, validateBody(categorySchema.partial()), ah(async (req, res) => {
  await assertRefs(req.tenantId, req.body, req.params.id);
  const c = await Category.findOneAndUpdate({ tenantId: req.tenantId, _id: req.params.id }, { $set: req.body }, { new: true, runValidators: true });
  if (!c) throw notFound('Category not found');
  await audit(req, 'category.update', 'Category', c._id);
  menuChanged(req);
  res.json(c);
}));

menuRouter.post('/categories/reorder', can('menu:manage'), validateBody(z.object({ ids: z.array(zId).min(1).max(500) })), ah(async (req, res) => {
  const ids: string[] = req.body.ids;
  const count = await Category.countDocuments({ tenantId: req.tenantId, _id: { $in: ids } });
  if (count !== ids.length) throw badRequest('Unknown category in order list');
  await Category.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { tenantId: req.tenantId, _id: id }, update: { $set: { sortOrder: i } } } })));
  await audit(req, 'category.reorder', 'Category');
  res.json({ ok: true });
}));

menuRouter.delete('/categories/:id', can('menu:manage'), checkIdParams, ah(async (req, res) => {
  const inUse = await Product.countDocuments({ tenantId: req.tenantId, categoryId: req.params.id, isArchived: false });
  const children = await Category.countDocuments({ tenantId: req.tenantId, parentId: req.params.id });
  if (inUse || children) throw badRequest('Move or archive its products and subcategories first');
  const c = await Category.findOneAndDelete({ tenantId: req.tenantId, _id: req.params.id });
  if (!c) throw notFound('Category not found');
  await audit(req, 'category.delete', 'Category', c._id);
  res.json({ ok: true });
}));

menuRouter.post('/categories/:id/image', can('menu:manage'), checkIdParams, uploadMemory.single('file'), ah(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded');
  const c = await Category.findOne({ tenantId: req.tenantId, _id: req.params.id });
  if (!c) throw notFound('Category not found');
  const url = await storeTenantImage(String(req.tenantId), 'categories', req.file);
  if (c.imageUrl) await deleteTenantImage(String(req.tenantId), c.imageUrl);
  c.imageUrl = url;
  await c.save();
  res.json({ url });
}));

/* ------------------------------ Products ------------------------------ */
const productSchema = z.object({
  categoryId: zId,
  name: zI18nRequired,
  description: zI18n.optional(),
  price: zMoney,
  promoPrice: zMoney.nullable().optional(),
  promoEndsAt: z.coerce.date().nullable().optional(),
  variants: z.array(z.object({ _id: zId.optional(), name: z.string().min(1).max(60), priceDelta: z.number().int().min(-1_000_000).max(1_000_000) })).max(20).optional(),
  addons: z.array(z.object({ _id: zId.optional(), name: z.string().min(1).max(60), price: zMoney, isAvailable: z.boolean().optional() })).max(30).optional(),
  tags: z.array(z.string().max(30)).max(10).optional(),
  isFeatured: z.boolean().optional(),
  isAvailable: z.boolean().optional(),
  trackStock: z.boolean().optional(),
  stockQty: z.number().int().min(0).max(1_000_000).optional(),
  recipe: z.array(z.object({ inventoryItemId: zId, quantity: z.number().positive().max(100000) })).max(30).optional(),
  prepMinutes: z.number().int().min(0).max(600).optional(),
  sortOrder: z.number().int().min(0).optional(),
});

async function assertProductRefs(tenantId: any, body: any) {
  if (body.categoryId && !(await Category.exists({ tenantId, _id: body.categoryId }))) throw badRequest('Category not found');
  if (body.recipe?.length) {
    const ids = [...new Set(body.recipe.map((r: any) => r.inventoryItemId))];
    if ((await InventoryItem.countDocuments({ tenantId, _id: { $in: ids } })) !== ids.length) throw badRequest('Unknown inventory item in recipe');
  }
  if (body.promoPrice != null && body.price != null && body.promoPrice >= body.price) throw badRequest('Promo price must be lower than the regular price');
}

menuRouter.get('/products', can('menu:view'), validateQuery(zPage.extend({ categoryId: z.string().optional(), archived: z.enum(['true', 'false']).optional(), featured: z.enum(['true', 'false']).optional() })), ah(async (req, res) => {
  const q = (req as any).validQuery;
  const filter: any = { tenantId: req.tenantId, isArchived: q.archived === 'true' };
  if (q.categoryId && /^[a-f0-9]{24}$/i.test(q.categoryId)) filter.categoryId = q.categoryId;
  if (q.featured) filter.isFeatured = q.featured === 'true';
  if (q.q) filter['name.en'] = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const [items, total] = await Promise.all([
    Product.find(filter).sort({ sortOrder: 1, createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Product.countDocuments(filter),
  ]);
  res.json({ items, total, page: q.page, limit: q.limit });
}));

menuRouter.get('/products/:id', can('menu:view'), checkIdParams, ah(async (req, res) => {
  const p = await Product.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
  if (!p) throw notFound('Product not found');
  res.json(p);
}));

menuRouter.post('/products', can('menu:manage'), validateBody(productSchema), ah(async (req, res) => {
  const plan = req.tenant!.subscription?.planId ? await Plan.findById(req.tenant!.subscription.planId).lean() : null;
  if (plan?.limits?.maxProducts && (await Product.countDocuments({ tenantId: req.tenantId, isArchived: false })) >= plan.limits.maxProducts) {
    throw paymentRequired(`Your plan allows ${plan.limits.maxProducts} products`);
  }
  await assertProductRefs(req.tenantId, req.body);
  const p = await Product.create({ ...req.body, tenantId: req.tenantId });
  await audit(req, 'product.create', 'Product', p._id);
  menuChanged(req);
  res.status(201).json(p);
}));

menuRouter.patch('/products/:id', can('menu:manage'), checkIdParams, validateBody(productSchema.partial().extend({ isArchived: z.boolean().optional() })), ah(async (req, res) => {
  const existing = await Product.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
  if (!existing) throw notFound('Product not found');
  // Restoring an archived dish counts against the plan's product limit, exactly like creating one.
  if (req.body.isArchived === false && existing.isArchived) {
    const plan = req.tenant!.subscription?.planId ? await Plan.findById(req.tenant!.subscription.planId).lean() : null;
    if (plan?.limits?.maxProducts && (await Product.countDocuments({ tenantId: req.tenantId, isArchived: false })) >= plan.limits.maxProducts) {
      throw paymentRequired(`Your plan allows ${plan.limits.maxProducts} products`);
    }
  }
  await assertProductRefs(req.tenantId, { price: existing.price, ...req.body });
  const p = await Product.findOneAndUpdate({ tenantId: req.tenantId, _id: req.params.id }, { $set: req.body }, { new: true, runValidators: true });
  await audit(req, req.body.isArchived ? 'product.archive' : 'product.update', 'Product', req.params.id);
  menuChanged(req);
  res.json(p);
}));

/** Archive (soft delete) keeps history intact for past orders and reports. */
menuRouter.delete('/products/:id', can('menu:manage'), checkIdParams, ah(async (req, res) => {
  const p = await Product.findOneAndUpdate({ tenantId: req.tenantId, _id: req.params.id }, { $set: { isArchived: true, isFeatured: false } }, { new: true });
  if (!p) throw notFound('Product not found');
  await audit(req, 'product.archive', 'Product', p._id);
  menuChanged(req);
  res.json({ ok: true });
}));

menuRouter.post('/products/:id/images', can('menu:manage'), checkIdParams, uploadMemory.array('files', 8), ah(async (req, res) => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (!files.length) throw badRequest('No files uploaded');
  const p = await Product.findOne({ tenantId: req.tenantId, _id: req.params.id });
  if (!p) throw notFound('Product not found');
  if (p.images.length + files.length > 8) throw badRequest('A product can have at most 8 images');
  for (const f of files) p.images.push(await storeTenantImage(String(req.tenantId), 'products', f));
  await p.save();
  res.json({ images: p.images });
}));

menuRouter.delete('/products/:id/images', can('menu:manage'), checkIdParams, validateBody(z.object({ url: z.string().max(300) })), ah(async (req, res) => {
  const p = await Product.findOne({ tenantId: req.tenantId, _id: req.params.id });
  if (!p) throw notFound('Product not found');
  if (!p.images.includes(req.body.url)) throw notFound('Image not found');
  p.images = p.images.filter((u) => u !== req.body.url);
  await p.save();
  await deleteTenantImage(String(req.tenantId), req.body.url);
  res.json({ images: p.images });
}));

menuRouter.post('/products/:id/stock', can('menu:manage', 'inventory:manage'), checkIdParams, validateBody(z.object({ stockQty: z.number().int().min(0).max(1_000_000), trackStock: z.boolean().optional() })), ah(async (req, res) => {
  const p = await Product.findOneAndUpdate({ tenantId: req.tenantId, _id: req.params.id }, { $set: req.body }, { new: true });
  if (!p) throw notFound('Product not found');
  await audit(req, 'product.stock', 'Product', p._id, req.body);
  menuChanged(req);
  res.json(p);
}));
