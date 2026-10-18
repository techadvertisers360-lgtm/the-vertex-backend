import { Prisma, PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
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
