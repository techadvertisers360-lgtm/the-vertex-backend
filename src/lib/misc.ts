import { createHash, randomBytes } from 'node:crypto';
import pino from 'pino';
import type { Tx } from './prisma';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
  redact: ['req.headers.cookie', 'req.headers.authorization', '*.password', '*.passwordHash', '*.token'],
});

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** JSON-safe conversion: bigint → number (paisa stays exact below 2^53; larger values become strings). */
export function toJsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => {
      if (typeof v === 'bigint') {
        return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v.toString();
      }
      return v;
    }),
  );
}

/**
 * Next value of a named counter inside the caller's transaction. The row lock makes concurrent
 * callers serialize and a number is never reused (rolled-back transactions roll back the bump too).
 */
export async function nextSequence(tx: Tx, name: string): Promise<number> {
  await tx.$executeRaw`INSERT INTO sequences (name, value) VALUES (${name}, 0) ON DUPLICATE KEY UPDATE name = name`;
  await tx.$executeRaw`UPDATE sequences SET value = value + 1 WHERE name = ${name}`;
  const rows = await tx.$queryRaw<{ value: number }[]>`SELECT value FROM sequences WHERE name = ${name}`;
  return Number(rows[0]!.value);
}

/** formatNumber('SD', 2026, 7) → "SD-2026-0007" */
export function formatNumber(prefix: string, year: number, n: number): string {
  return `${prefix}-${year}-${String(n).padStart(4, '0')}`;
}
