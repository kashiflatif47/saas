import './env';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import type { Express } from 'express';

export async function startDb() {
  const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri());
  await Promise.all(Object.values(mongoose.models).map((m: any) => m.syncIndexes()));
  return mongod;
}

export async function stopDb(mongod: MongoMemoryReplSet) {
  await mongoose.disconnect();
  await mongod.stop();
}

export const PW = 'Sup3r-Secret-Pass!';

/** Creates a super admin + plan, then provisions tenants through the REAL platform API. */
export async function bootstrapPlatform(app: Express) {
  const { User, Plan } = await import('../src/models/platform');
  await User.create({ tenantId: null, role: 'superadmin', name: 'SA', email: 'sa@test.local', passwordHash: await bcrypt.hash(PW, 4) });
  const plan = await Plan.create({ name: 'Pro', code: 'pro', priceMonthly: 100, trialDays: 14, features: ['qr_ordering', 'kds', 'inventory', 'reservations', 'analytics_export', 'online_payments', 'multi_language', 'loyalty'] });
  const sa = await request(app).post('/api/auth/login').send({ email: 'sa@test.local', password: PW });
  if (sa.status !== 200) throw new Error(`super admin login failed: ${sa.status} ${JSON.stringify(sa.body)}`);
  return { saToken: sa.body.accessToken as string, planId: String(plan._id) };
}

export async function provisionTenant(app: Express, saToken: string, planId: string, slug: string) {
  const res = await request(app)
    .post('/api/platform/tenants')
    .set('Authorization', `Bearer ${saToken}`)
    .send({ name: `Tenant ${slug}`, slug, planId, owner: { name: `Owner ${slug}`, email: `owner@${slug}.test`, password: PW } });
  if (res.status !== 201) throw new Error(`provision failed: ${res.status} ${JSON.stringify(res.body)}`);
  const login = await request(app).post('/api/auth/login').send({ email: `owner@${slug}.test`, password: PW, tenantSlug: slug });
  if (login.status !== 200) throw new Error(`owner login failed: ${login.status}`);
  return { tenantId: String(res.body.tenant._id), slug, token: login.body.accessToken as string, host: `${slug}.test.local` };
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
