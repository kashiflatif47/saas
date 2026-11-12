/**
 * DEVELOPMENT / DEMO seed: plans, a super admin and ONE demo tenant ("spice-garden") with real records,
 * so the platform can be explored end-to-end. Safe to re-run: it skips anything that already exists.
 *
 * It refuses to run with NODE_ENV=production (a demo restaurant with shared demo passwords must never
 * appear on a live platform). For production use `npm run bootstrap` instead (plans + super admin only).
 *
 * Usage: SEED_PASSWORD='your-demo-password' npm run seed
 */
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { env } from './config/env';
import { connectDb } from './db/connect';
import { Plan, Tenant, User } from './models/platform';
import { Category, KitchenStation, Product } from './models/menu';
import { Coupon, Table } from './models/operations';
import { InventoryItem, Supplier } from './models/inventory';
import { randomToken } from './lib/crypto';
import { DEFAULT_PLANS, ensureSuperAdmin } from './services/bootstrap';

if (env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data with NODE_ENV=production. Use `npm run bootstrap` for production.');
  process.exit(1);
}

const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? '';
if (DEMO_PASSWORD.length < 10) {
  console.error('Set SEED_PASSWORD (at least 10 characters) — it becomes the password of the demo staff accounts.');
  process.exit(1);
}

async function upsertPlan(code: string) {
  const def = DEFAULT_PLANS.find((p) => p.code === code)!;
  return (await Plan.findOne({ code })) ?? Plan.create(def);
}

async function main() {
  await connectDb(env.MONGODB_URI);

  await upsertPlan('starter');
  await upsertPlan('growth');
  const pro = await upsertPlan('pro');

  const sa = await ensureSuperAdmin(env.SUPERADMIN_EMAIL, env.SUPERADMIN_PASSWORD);
  if (sa === 'skipped') console.warn('No super admin exists and SUPERADMIN_EMAIL/SUPERADMIN_PASSWORD are not set — none created.');

  let tenant = await Tenant.findOne({ slug: 'spice-garden' });
  if (!tenant) {
    tenant = await Tenant.create({
      name: 'Spice Garden',
      slug: 'spice-garden',
      businessType: 'restaurant',
      contact: { email: 'hello@spicegarden.example', phone: '+92 300 0000000', address: 'MM Alam Road', city: 'Lahore', country: 'Pakistan' },
      settings: { currency: 'PKR', currencyDecimals: 2, timezone: 'Asia/Karachi', languages: ['en', 'ur', 'ar'], taxRatePercent: 16, taxInclusive: false, serviceChargePercent: 5, orderTypes: ['dine_in', 'takeaway'], openingHours: 'Daily 12:00 – 00:00', loyaltyEnabled: true, loyaltyPointsPerUnit: 1 },
      branding: {
        heroTitle: { en: 'Slow-cooked flavours of Lahore', ur: 'لاہور کے دیسی ذائقے', ar: 'نكهات لاهور المطهوة ببطء' },
        heroSubtitle: { en: 'Scan, order and relax — we bring it to your table.', ur: 'اسکین کریں، آرڈر دیں اور آرام کریں', ar: 'امسح واطلب واسترخِ' },
        theme: { primary: '#B4532A', secondary: '#2B2118', accent: '#E9B44C', background: '#FFF8EF', surface: '#FFFFFF', text: '#1C1917', fontHeading: 'Fraunces', fontBody: 'Inter', radius: 16 },
      },
      subscription: { planId: pro._id, status: 'active', currentPeriodEnd: new Date(Date.now() + 365 * 86400_000) },
    });
  }
  const tenantId = tenant._id;
  const hash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const staff = [
    ['owner', 'Ayesha Khan', 'owner@spicegarden.example'],
    ['manager', 'Bilal Ahmed', 'manager@spicegarden.example'],
    ['waiter', 'Usman Ali', 'waiter@spicegarden.example'],
    ['cashier', 'Sana Malik', 'cashier@spicegarden.example'],
    ['kitchen', 'Chef Imran', 'kitchen@spicegarden.example'],
    ['inventory_manager', 'Hamza Riaz', 'inventory@spicegarden.example'],
  ];
  for (const [role, name, email] of staff) {
    if (!(await User.exists({ tenantId, email }))) await User.create({ tenantId, role, name, email, passwordHash: hash });
  }

  if (!(await KitchenStation.exists({ tenantId }))) {
    await KitchenStation.create([{ tenantId, name: 'Main Kitchen', isDefault: true, color: '#B4532A' }, { tenantId, name: 'Grill', color: '#7C2D12' }, { tenantId, name: 'Bar', color: '#0E7490' }]);
  }
  const stations = Object.fromEntries((await KitchenStation.find({ tenantId }).lean()).map((s) => [s.name, s._id]));

  if (!(await Category.exists({ tenantId }))) {
    const cats = await Category.create([
      { tenantId, name: { en: 'Starters', ur: 'اسٹارٹرز', ar: 'المقبلات' }, sortOrder: 0, stationId: stations['Main Kitchen'] },
      { tenantId, name: { en: 'BBQ & Grill', ur: 'باربی کیو', ar: 'المشويات' }, sortOrder: 1, stationId: stations['Grill'] },
      { tenantId, name: { en: 'Karahi & Curries', ur: 'کڑاہی', ar: 'الكاري' }, sortOrder: 2, stationId: stations['Main Kitchen'] },
      { tenantId, name: { en: 'Drinks', ur: 'مشروبات', ar: 'المشروبات' }, sortOrder: 3, stationId: stations['Bar'] },
    ]);
    const [starters, bbq, karahi, drinks] = cats;
    const chicken = await InventoryItem.create({ tenantId, name: 'Chicken (boneless)', unit: 'kg', quantity: 25, lowStockThreshold: 5, costPerUnit: 950_00 });
    const supplier = await Supplier.create({ tenantId, name: 'Punjab Poultry Co.', contactName: 'Tariq', phone: '+92 321 0000000' });
    await InventoryItem.updateOne({ tenantId, _id: chicken._id }, { $set: { supplierId: supplier._id } });
    await InventoryItem.create({ tenantId, name: 'Basmati rice', unit: 'kg', quantity: 40, lowStockThreshold: 10, costPerUnit: 380_00, supplierId: supplier._id });
    await Product.create([
      { tenantId, categoryId: starters._id, name: { en: 'Chicken Samosa (4 pcs)', ur: 'چکن سموسہ', ar: 'سمبوسة دجاج' }, description: { en: 'Crisp pastry, spiced chicken, mint chutney.' }, price: 450_00, isFeatured: true, prepMinutes: 8, tags: ['popular'] },
      { tenantId, categoryId: starters._id, name: { en: 'Dahi Bhallay', ur: 'دہی بھلے', ar: 'دهي بهلي' }, price: 390_00, prepMinutes: 5, tags: ['vegetarian'] },
      { tenantId, categoryId: bbq._id, name: { en: 'Chicken Tikka', ur: 'چکن تکہ', ar: 'دجاج تكا' }, description: { en: 'Charcoal-grilled, 24h marinade.' }, price: 1_150_00, promoPrice: 990_00, isFeatured: true, prepMinutes: 18, variants: [{ name: 'Leg', priceDelta: 0 }, { name: 'Breast', priceDelta: 100_00 }], recipe: [{ inventoryItemId: chicken._id, quantity: 0.3 }], tags: ['spicy'] },
      { tenantId, categoryId: bbq._id, name: { en: 'Seekh Kabab (4 pcs)', ur: 'سیخ کباب', ar: 'سيخ كباب' }, price: 1_250_00, prepMinutes: 15, addons: [{ name: 'Extra raita', price: 120_00 }, { name: 'Naan', price: 80_00 }] },
      { tenantId, categoryId: karahi._id, name: { en: 'Chicken Karahi', ur: 'چکن کڑاہی', ar: 'كراهي دجاج' }, description: { en: 'Tomato, green chilli, ginger. Serves 2–3.' }, price: 2_400_00, isFeatured: true, prepMinutes: 25, variants: [{ name: 'Half', priceDelta: 0 }, { name: 'Full', priceDelta: 1_800_00 }], recipe: [{ inventoryItemId: chicken._id, quantity: 0.6 }] },
      { tenantId, categoryId: drinks._id, name: { en: 'Mint Margarita', ur: 'منٹ مارگریٹا', ar: 'نعناع مارغريتا' }, price: 420_00, prepMinutes: 3 },
      { tenantId, categoryId: drinks._id, name: { en: 'Kashmiri Chai', ur: 'کشمیری چائے', ar: 'شاي كشميري' }, price: 350_00, prepMinutes: 6, trackStock: true, stockQty: 40 },
    ]);
  }

  if (!(await Table.exists({ tenantId }))) {
    await Table.insertMany(Array.from({ length: 8 }, (_, i) => ({ tenantId, label: `T${i + 1}`, area: i < 5 ? 'Main hall' : 'Terrace', capacity: i % 3 === 0 ? 6 : 4, qrToken: randomToken(18) })));
  }
  if (!(await Coupon.exists({ tenantId }))) {
    await Coupon.create({ tenantId, code: 'WELCOME10', description: '10% off your first order', type: 'percent', value: 10, maxDiscount: 500_00, minOrder: 1_000_00 });
  }

  console.info('Seed complete.');
  console.info(`  Super admin:  ${sa === 'created' ? `created ${env.SUPERADMIN_EMAIL}` : sa === 'exists' ? 'already exists (unchanged)' : 'not created'}`);
  console.info(`  Demo tenant:  ${env.APP_PROTOCOL}://spice-garden.${env.ROOT_DOMAIN}${env.APP_PUBLIC_PORT ? `:${env.APP_PUBLIC_PORT}` : env.NODE_ENV === 'development' ? ':5173' : ''}`);
  console.info('  Staff logins: owner@ / manager@ / waiter@ / cashier@ / kitchen@ / inventory@spicegarden.example  (password = SEED_PASSWORD)');
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect();
  process.exit(1);
});
