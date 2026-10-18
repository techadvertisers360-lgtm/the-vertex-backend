import { execSync } from 'node:child_process';
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

/**
 * Bring the dedicated test database up to date with `prisma migrate deploy` (non-destructive: applies pending
 * migrations only). Tests create their own uniquely-named fixtures, so no wipe is needed between runs.
 * Users created by earlier runs are deactivated so role-wide notifications ("all Managers") stay small and
 * each run's assertions only see this run's active users. Nothing is deleted.
 * To start from scratch, reset the test DB manually: `DATABASE_URL=$DATABASE_URL_TEST npx prisma migrate reset`.
 */
export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error('DATABASE_URL_TEST is not set (see backend/.env.example).');
  if (url === process.env.DATABASE_URL) throw new Error('DATABASE_URL_TEST must differ from DATABASE_URL.');
  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } });

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    await prisma.user.updateMany({ where: { email: { endsWith: '@test.local' }, active: true }, data: { active: false } });
  } finally {
    await prisma.$disconnect();
  }
}
