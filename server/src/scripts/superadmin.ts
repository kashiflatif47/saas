/**
 * Super admin management CLI. Production-safe: it never deletes anything and only changes an existing
 * account when --reset-password is passed explicitly.
 *
 *   npm run superadmin -- --email you@example.com                 # create (password prompted from env SUPERADMIN_NEW_PASSWORD)
 *   npm run superadmin -- --email you@example.com --reset-password
 *
 * The password is read from the SUPERADMIN_NEW_PASSWORD environment variable (never from argv, so it
 * does not end up in shell history or process listings).
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { connectDb } from '../db/connect';
import { createSuperAdmin, resetSuperAdminPassword } from '../services/bootstrap';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg('email');
  const name = arg('name') ?? 'Platform Admin';
  const reset = process.argv.includes('--reset-password');
  const password = process.env.SUPERADMIN_NEW_PASSWORD;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Usage: npm run superadmin -- --email you@example.com [--name "Jane"] [--reset-password]');
  if (!password) throw new Error('Set SUPERADMIN_NEW_PASSWORD in the environment (min 10 chars) before running this command');

  await connectDb(env.MONGODB_URI);
  const result = reset ? await resetSuperAdminPassword(email, password) : await createSuperAdmin(email, password, name);
  const messages: Record<string, string> = {
    created: `Super admin ${email} created.`,
    exists: `An account with ${email} already exists — nothing changed. Use --reset-password to change its password.`,
    password_reset: `Password reset for ${email}; all of its sessions were revoked.`,
    not_found: `No super admin with ${email} exists — nothing changed.`,
  };
  console.info(messages[result] ?? result);
  await mongoose.disconnect();
  if (result === 'not_found') process.exitCode = 1;
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
