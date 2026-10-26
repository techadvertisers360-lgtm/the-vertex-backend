import { prisma, type Db, type Tx } from '../lib/prisma';
import { ValidationError } from '../lib/errors';
import { addMonthsStr, clinicDateStr, dateOnly } from '../lib/time';
import { audit, type Actor } from './audit';
import { notifyRoles } from './notifications';
import { getSetting } from './settings';

/**
 * Stock is derived from the append-only ledger (spec §18): on-hand = Σ quantity. Batches carry lot + expiry.
 * "Usable" excludes quarantined/expired batches and, when `stock.nearExpiryUsable` is false, batches inside
 * the expiry-alert window.
 */
export async function batchBalances(db: Db, itemId: string) {
  const rows = await db.stockTransaction.groupBy({ by: ['batchId'], where: { itemId }, _sum: { quantity: true } });
  return new Map(rows.map((r) => [r.batchId, r._sum.quantity ?? 0]));
}

export async function onHand(db: Db, itemId: string): Promise<number> {
  const r = await db.stockTransaction.aggregate({ where: { itemId }, _sum: { quantity: true } });
  return r._sum.quantity ?? 0;
}

export async function usableBatches(db: Db, itemId: string, now = new Date()) {
  const today = clinicDateStr(now);
  const nearOk = await getSetting('stock.nearExpiryUsable', db);
  const months = await getSetting('stock.expiryAlertMonths', db);
  const cutoff = nearOk ? today : addMonthsStr(today, months);
  const [batches, balances] = await Promise.all([db.stockBatch.findMany({ where: { itemId, status: 'AVAILABLE' } }), batchBalances(db, itemId)]);
  return batches
    .filter((b) => !b.expiryDate || b.expiryDate > dateOnly(cutoff))
    .map((b) => ({ id: b.id, lotNo: b.lotNo, expiryDate: b.expiryDate, balance: balances.get(b.id) ?? 0 }))
    .filter((b) => b.balance > 0)
    .sort((a, b) => (a.expiryDate?.getTime() ?? Infinity) - (b.expiryDate?.getTime() ?? Infinity)); // FEFO
}

/** What an Assistant may see: procedure products only (D-048) — names, units, usable quantity, never cost (spec §12, §4). */
export async function stockForUsage(db: Db = prisma) {
  const items = await db.stockItem.findMany({ where: { active: true, kind: 'PROCEDURE' }, select: { id: true, name: true, category: true, baseUnit: true, packUnit: true, packSize: true }, orderBy: { name: 'asc' } });
  return Promise.all(items.map(async (i) => ({ ...i, usableQty: (await usableBatches(db, i.id)).reduce((s, b) => s + b.balance, 0) })));
}

export interface UsageLine {
  itemId: string;
  quantity: number; // base units
}

/**
 * Deduct procedure usage exactly once (spec §12, §18, §22): the item row is locked, batches are consumed FEFO,
 * each ledger row carries a deterministic idempotency key, and impossible quantities are rejected unless the
 * clinic allows negative stock (§24 "never silently decrement below stock").
 */
export async function deductUsage(tx: Tx, actor: Actor, procedureTaskId: string, line: UsageLine): Promise<void> {
  if (!Number.isInteger(line.quantity) || line.quantity <= 0) throw new ValidationError('Quantity sahi likhein.');
  await tx.$queryRaw`SELECT id FROM stock_items WHERE id = ${line.itemId} FOR UPDATE`;
  const item = await tx.stockItem.findUnique({ where: { id: line.itemId } });
  if (!item || !item.active) throw new ValidationError('Stock item nahi mila.');
  const batches = await usableBatches(tx, line.itemId);
  const available = batches.reduce((s, b) => s + b.balance, 0);
  const allowNegative = await getSetting('stock.allowNegative', tx);
  if (line.quantity > available && !allowNegative) {
    throw new ValidationError(`${item.name}: sirf ${available} ${item.baseUnit} usable stock hai. Manager ko stock demand bhejein.`, { itemId: item.id, available });
  }
  let remaining = line.quantity;
  for (const b of batches) {
    if (remaining === 0) break;
    const take = Math.min(remaining, b.balance);
    await tx.stockTransaction.create({
      data: { itemId: item.id, batchId: b.id, type: 'USAGE', quantity: -take, procedureTaskId, actorId: actor.id!, reason: 'Procedure usage', idempotencyKey: `usage:${procedureTaskId}:${item.id}:${b.id}` },
    });
    remaining -= take;
  }
  if (remaining > 0) {
    // only reachable when negative stock is allowed by setting
    await tx.stockTransaction.create({ data: { itemId: item.id, type: 'USAGE', quantity: -remaining, procedureTaskId, actorId: actor.id!, reason: 'Procedure usage (no batch stock)', idempotencyKey: `usage:${procedureTaskId}:${item.id}:nobatch` } });
  }
  await audit(tx, actor, { action: 'STOCK_USED', recordType: 'StockItem', recordId: item.id, after: { procedureTaskId, quantity: line.quantity } });
  await checkLowStock(tx, item.id);
}

/**
 * Low-stock alert, once per episode (D-037): the first time on-hand drops to/below minimum the Managers are told
 * and `lowStockAlertedAt` is set; it is cleared when stock is back above minimum (receipt), re-arming the alert.
 */
export async function checkLowStock(tx: Tx, itemId: string): Promise<void> {
  const item = await tx.stockItem.findUnique({ where: { id: itemId } });
  if (!item || !item.active) return;
  const left = await onHand(tx, itemId);
  if (item.minQty <= 0 || left > item.minQty) {
    if (item.lowStockAlertedAt) await tx.stockItem.update({ where: { id: itemId }, data: { lowStockAlertedAt: null } });
    return;
  }
  const { count } = await tx.stockItem.updateMany({ where: { id: itemId, lowStockAlertedAt: null }, data: { lowStockAlertedAt: new Date() } });
  if (!count) return;
  // Reception keeps the procedure / pharmacy stock now (D-048); the Manager still handles demands and purchases.
  await notifyRoles(tx, ['MANAGER', 'RECEPTIONIST'], {
    type: 'LOW_STOCK',
    subject: `Low stock: ${item.name}`,
    body: `${left} ${item.baseUnit} baqi (minimum ${item.minQty}) — demand / purchase karein`,
    recordType: 'StockItem',
    recordId: item.id,
    priority: 1,
    actionLabel: 'Demand / purchase',
  });
}
