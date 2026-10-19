import { randomUUID } from 'node:crypto';
import type { StockKind } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { clinicDateStr, dateOnly, dateOnlyStr } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';
import { batchBalances, checkLowStock, onHand, usableBatches } from '../../services/stock';

/**
 * Reception "Stock & batches" (client 2026-10-20, D-048): two categories — products used in procedures and products
 * sold from the pharmacy. The Receptionist adds a product (or more of one) with name, quantity and price; every
 * addition is a batch + `STOCK_IN` ledger row, so quantity stays ledger-derived (spec §18).
 * Price meaning: Procedure = cost per unit (kept on the batch); Pharmacy = selling price per unit (on the item).
 */

export const KIND_LABEL: Record<StockKind, string> = { PROCEDURE: 'Procedure', PHARMACY: 'Pharmacy' };

export async function list(kind: StockKind) {
  const items = await prisma.stockItem.findMany({ where: { kind }, orderBy: [{ active: 'desc' }, { name: 'asc' }] });
  const today = clinicDateStr(new Date());
  return {
    kind,
    items: await Promise.all(
      items.map(async (i) => {
        const [usable, batches, balances, hand] = await Promise.all([
          usableBatches(prisma, i.id),
          prisma.stockBatch.findMany({ where: { itemId: i.id }, orderBy: { createdAt: 'desc' } }),
          batchBalances(prisma, i.id),
          onHand(prisma, i.id),
        ]);
        const live = batches.filter((b) => (balances.get(b.id) ?? 0) > 0);
        const expiries = live.map((b) => (b.expiryDate ? dateOnlyStr(b.expiryDate) : null)).filter((x): x is string => !!x).sort();
        return {
          id: i.id,
          name: i.name,
          unit: i.baseUnit,
          active: i.active,
          minQty: i.minQty,
          onHand: hand,
          usable: usable.reduce((s, b) => s + b.balance, 0),
          low: hand <= i.minQty,
          pricePaisa: kind === 'PHARMACY' ? i.salePricePaisa : (batches.find((b) => b.unitCostPaisa !== null)?.unitCostPaisa ?? null),
          nextExpiry: expiries[0] ?? null,
          expired: expiries.some((e) => e <= today),
        };
      }),
    ),
  };
}

export interface AddStockInput {
  kind: StockKind;
  name: string;
  quantity: number;
  pricePaisa: number;
  unit?: string;
  expiryDate?: string;
  minQty?: number;
}

/** Add a product, or more of an existing one (same name, same category). Returns the item and the new batch. */
export async function addStock(actor: Actor, input: AddStockInput, idempotencyKey: string) {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (name.length < 2) throw new ValidationError('Product ka naam likhein.');
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw new ValidationError('Quantity sahi likhein.');
  if (!Number.isSafeInteger(input.pricePaisa) || input.pricePaisa < 0) throw new ValidationError('Price sahi likhein.');
  if (input.expiryDate && input.expiryDate < clinicDateStr(new Date())) throw new ValidationError('Expiry date guzar chuki hai.');
  const key = `stockin:${idempotencyKey}`;
  return prisma.$transaction(async (tx) => {
    const replay = await tx.stockTransaction.findUnique({ where: { idempotencyKey: key } });
    if (replay) return { itemId: replay.itemId, batchId: replay.batchId, replayed: true };

    let item = await tx.stockItem.findFirst({ where: { name } });
    if (item && item.kind !== input.kind) throw new ConflictError('ITEM_OTHER_CATEGORY', `"${item.name}" pehle se ${KIND_LABEL[item.kind]} mein hai.`);
    const price = BigInt(input.pricePaisa);
    if (!item) {
      item = await tx.stockItem.create({
        data: {
          name,
          kind: input.kind,
          category: KIND_LABEL[input.kind],
          baseUnit: input.unit?.trim() || 'piece',
          minQty: input.minQty ?? 0,
          salePricePaisa: input.kind === 'PHARMACY' ? price : null,
        },
      });
      await audit(tx, actor, { action: 'STOCK_ITEM_CREATED', recordType: 'StockItem', recordId: item.id, after: item });
    } else {
      await tx.$queryRaw`SELECT id FROM stock_items WHERE id = ${item.id} FOR UPDATE`;
      const data = { active: true, ...(input.kind === 'PHARMACY' ? { salePricePaisa: price } : {}), ...(input.minQty !== undefined ? { minQty: input.minQty } : {}) };
      const before = item;
      item = await tx.stockItem.update({ where: { id: item.id }, data });
      if (before.salePricePaisa !== item.salePricePaisa || before.minQty !== item.minQty || !before.active)
        await audit(tx, actor, { action: 'STOCK_ITEM_UPDATED', recordType: 'StockItem', recordId: item.id, before, after: item });
    }
    const n = (await tx.stockBatch.count({ where: { itemId: item.id } })) + 1;
    const batch = await tx.stockBatch.create({
      data: {
        itemId: item.id,
        lotNo: `R${clinicDateStr(new Date()).replace(/-/g, '')}-${n}-${randomUUID().slice(0, 4)}`,
        expiryDate: input.expiryDate ? dateOnly(input.expiryDate) : null,
        unitCostPaisa: input.kind === 'PROCEDURE' ? price : null,
      },
    });
    await tx.stockTransaction.create({
      data: { itemId: item.id, batchId: batch.id, type: 'STOCK_IN', quantity: input.quantity, unitCostPaisa: batch.unitCostPaisa, actorId: actor.id!, reason: 'Reception stock-in', idempotencyKey: key },
    });
    await audit(tx, actor, { action: 'STOCK_IN', recordType: 'StockItem', recordId: item.id, after: { batchId: batch.id, quantity: input.quantity, pricePaisa: price, kind: input.kind, expiryDate: input.expiryDate ?? null } });
    await checkLowStock(tx, item.id); // clears an old low-stock alert once back above minimum
    return { itemId: item.id, batchId: batch.id, replayed: false };
  });
}

/** Rename / change minimum / hide a product (no deletes — the ledger keeps its history). */
export async function updateProduct(actor: Actor, id: string, input: { name?: string; minQty?: number; pricePaisa?: number; active?: boolean }) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.stockItem.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Product');
    const name = input.name?.trim().replace(/\s+/g, ' ');
    if (name && name !== before.name && (await tx.stockItem.findFirst({ where: { name } }))) throw new ConflictError('ITEM_EXISTS', 'Is naam ka product pehle se hai.');
    const after = await tx.stockItem.update({
      where: { id },
      data: {
        ...(name ? { name } : {}),
        ...(input.minQty !== undefined ? { minQty: input.minQty } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.pricePaisa !== undefined && before.kind === 'PHARMACY' ? { salePricePaisa: BigInt(input.pricePaisa) } : {}),
      },
    });
    await audit(tx, actor, { action: 'STOCK_ITEM_UPDATED', recordType: 'StockItem', recordId: id, before, after });
    return after;
  });
}
