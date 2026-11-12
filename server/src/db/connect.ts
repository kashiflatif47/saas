import mongoose from 'mongoose';

/**
 * Connects to MongoDB and ensures declared indexes exist.
 *
 * `createIndexes()` is used deliberately instead of `syncIndexes()`: syncIndexes DROPS any index that is
 * not declared in code, which is destructive against a shared production database (e.g. an index added by
 * an operator or Atlas Performance Advisor). createIndexes only builds what is missing.
 * The Mongo driver reconnects automatically after transient network failures; we log state changes.
 */
export async function connectDb(uri: string) {
  mongoose.set('strictQuery', true);
  mongoose.connection.on('disconnected', () => console.warn('[DB] disconnected — driver will retry'));
  mongoose.connection.on('reconnected', () => console.info('[DB] reconnected'));
  mongoose.connection.on('error', (e) => console.error('[DB] connection error', e?.message ?? e));
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, maxPoolSize: 50 });
  await Promise.all(
    Object.values(mongoose.models).map((m) =>
      m.createIndexes().catch((e: unknown) => console.error(`[DB] index build failed for ${m.modelName}`, e)),
    ),
  );
  console.info('[DB] connected');
}
