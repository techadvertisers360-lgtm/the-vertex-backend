import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';

/** Point a MySQL URL's `sslcert` at `caPath` and require a verified certificate (pure; unit-tested). */
export function withCaCert(url: string, caPath: string): string {
  const [base, query = ''] = url.split('?');
  const params = query.split('&').filter((p) => p && !/^(sslcert|sslaccept)=/.test(p));
  params.push(`sslcert=${caPath}`, 'sslaccept=strict');
  return `${base}?${params.join('&')}`;
}

/**
 * Serverless hosts have no project files for secrets, so the DB CA can come from `DATABASE_CA_CERT` (PEM text or
 * base64). It is written once to the temp dir and the connection URL is pointed at it (D-042).
 */
function datasourceUrl(): string | undefined {
  const pem = process.env.DATABASE_CA_CERT?.trim();
  const url = process.env.DATABASE_URL;
  if (!pem || !url) return undefined;
  // Env UIs often store multi-line values with literal "\n"; restore real newlines.
  const text = pem.includes('BEGIN CERTIFICATE') ? pem.replace(/\\n/g, '\n') : Buffer.from(pem, 'base64').toString('utf8');
  const path = join(tmpdir(), 'vertex-db-ca.pem');
  writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`);
  return withCaCert(url, path);
}

export const prisma = new PrismaClient({
  datasourceUrl: datasourceUrl(),
  // Tests deliberately trigger constraint/trigger errors; keep their output readable.
  log: process.env.PRISMA_LOG === 'query' ? ['query', 'warn', 'error'] : process.env.NODE_ENV === 'test' ? [] : ['warn', 'error'],
  // Prisma's 5 s default interactive-transaction timeout is too tight for multi-step business transactions
  // (booking + messages + notifications) on a busy server; long transactions are still bounded.
  transactionOptions: { maxWait: 10_000, timeout: 20_000 },
});

/** Interactive transaction client. Services accept `Tx` so callers can compose them in one transaction. */
export type Tx = Prisma.TransactionClient;
export type Db = PrismaClient | Tx;

/** Run `fn` in a new transaction, or inside the caller's transaction when `db` already is one. */
export async function inTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if ('$transaction' in db) {
    return (db as PrismaClient).$transaction(fn, { timeout: 20000, maxWait: 10000 });
  }
  return fn(db as Tx);
}
