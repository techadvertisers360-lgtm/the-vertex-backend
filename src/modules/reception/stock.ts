import { randomUUID } from 'node:crypto';
import type { StockItem, StockKind } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors';
import { clinicDateStr, dateOnly, dateOnlyStr } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';
import { notifyRoles, notifyUsers } from '../../services/notifications';
import { batchBalances, checkLowStock, onHand, usableBatches } from '../../services/stock';

/**
 * Reception "Stock & batches" (client 2026-10-20, D-048): two categories — products used in procedures and products
 * sold from the pharmacy. The Receptionist adds a product (or more of one) with name, quantity and price; the Manager
 * verifies it (D-052) and only then it becomes a batch + `STOCK_IN` ledger row, so quantity stays ledger-derived (§18).
 * Price meaning: Procedure = cost per unit (kept on the batch); Pharmacy = selling price per unit (on the item).
 */

export const KIND_LABEL: Record<StockKind, string> = { PROCEDURE: 'Procedure', PHARMACY: 'Pharmacy' };

export async function list(kind: StockKind) {
  const items = await prisma.stockItem.findMany({ where: { kind }, orderBy: [{ active: 'desc' }, { name: 'asc' }] });
  const pending = await prisma.stockIntake.groupBy({ by: ['itemId'], where: { status: 'PENDING', itemId: { in: items.map((i) => i.id) } }, _sum: { quantity: true } });
  const today = clinicDateStr(new Date());
  const vendors = await prisma.vendor.findMany({ select: { id: true, name: true } });
  return {
    kind,
    items: await Promise.all(
      items.map(async (i) => {
        const [usable, batches, balances, hand] = await Promise.all([
          usableBatches(prisma, i.id),
          prisma.stockBatch.findMany({ where: { itemId: i.id }, orderBy: [{ expiryDate: 'asc' }, { createdAt: 'desc' }] }),
          batchBalances(prisma, i.id),
          onHand(prisma, i.id),
        ]);
        const live = batches.filter((b) => (balances.get(b.id) ?? 0) > 0);
        const expiries = live.map((b) => (b.expiryDate ? dateOnlyStr(b.expiryDate) : null)).filter((x): x is string => !!x).sort();
        return {
          id: i.id,
          name: i.name,
          unit: i.baseUnit,
          // the columns of the stock CSV (D-055 / D-057)
          code: i.code,
          category: i.category,
          department: i.department,
          procedureUse: i.procedureUse,
          packUnit: i.packUnit,
          packSize: i.packSize,
          itemType: i.itemType,
          sterile: i.sterile,
          note: i.note,
          salePricePaisa: i.salePricePaisa,
          /** Batches with stock left (pharmacy table: one row per batch). */
          batches: live.map((b) => ({
            id: b.id,
            lotNo: b.lotNo,
            distributor: (b.vendorId && vendors.find((v) => v.id === b.vendorId)?.name) || null,
            costPaisa: b.unitCostPaisa,
            quantity: balances.get(b.id) ?? 0,
            expiryDate: b.expiryDate ? dateOnlyStr(b.expiryDate) : null,
          })),
          active: i.active,
          minQty: i.minQty,
          onHand: hand,
          usable: usable.reduce((s, b) => s + b.balance, 0),
          low: i.minQty > 0 && hand <= i.minQty, // no minimum set (0) = no low-stock flag (D-056)
          pricePaisa: kind === 'PHARMACY' ? i.salePricePaisa : (batches.find((b) => b.unitCostPaisa !== null)?.unitCostPaisa ?? null),
          nextExpiry: expiries[0] ?? null,
          /** Added by Reception, waiting for the Manager's verification (D-052) — not in stock yet. */
          pendingQty: pending.find((p) => p.itemId === i.id)?._sum.quantity ?? 0,
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
  /** Pharmacy (D-057): batch number, distributor and purchase price per unit; `pricePaisa` is the selling price. */
  lotNo?: string;
  distributor?: string;
  costPaisa?: number;
  /** Procedure catalogue fields (D-057), as in the stock CSV. */
  details?: ProductDetails;
}

export interface ProductDetails {
  code?: string;
  category?: string;
  department?: string;
  procedureUse?: string;
  packUnit?: string;
  packSize?: number;
  itemType?: string;
  sterile?: boolean;
  note?: string;
}

type DetailFields = Pick<StockItem, 'code' | 'category' | 'department' | 'procedureUse' | 'packUnit' | 'packSize' | 'itemType' | 'sterile' | 'note'>;
const NO_DETAILS: DetailFields = { code: null, category: '', department: null, procedureUse: null, packUnit: null, packSize: null, itemType: null, sterile: null, note: null };

/** Only the fields that were filled in and differ from the product (a blank never wipes a value). */
function detailChanges(item: DetailFields, d: ProductDetails = {}): Partial<DetailFields> {
  const t = (v?: string) => v?.trim().replace(/\s+/g, ' ') || undefined;
  const want: Partial<DetailFields> = {
    code: t(d.code),
    category: t(d.category),
    department: t(d.department),
    procedureUse: t(d.procedureUse),
    packUnit: t(d.packUnit),
    packSize: d.packSize || undefined,
    itemType: t(d.itemType),
    sterile: d.sterile,
    note: t(d.note),
  };
  return Object.fromEntries(Object.entries(want).filter(([k, v]) => v !== undefined && v !== item[k as keyof DetailFields]));
}

/**
 * Reception adds a product, or more of an existing one (same name, same category). It waits for the Manager's
 * verification (D-052): nothing is in stock — not usable, not sellable — until the Manager verifies it.
 */
export async function addStock(actor: Actor, input: AddStockInput, idempotencyKey: string) {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (name.length < 2) throw new ValidationError('Product ka naam likhein.');
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 0) throw new ValidationError('Quantity sahi likhein.');
  if (input.costPaisa !== undefined && (!Number.isSafeInteger(input.costPaisa) || input.costPaisa < 0)) throw new ValidationError('Purchase price sahi likhein.');
  if (!Number.isSafeInteger(input.pricePaisa) || input.pricePaisa < 0) throw new ValidationError('Price sahi likhein.');
  if (input.expiryDate && input.expiryDate < clinicDateStr(new Date())) throw new ValidationError('Expiry date guzar chuki hai.');
  const key = `intake:${idempotencyKey}`;
  return prisma.$transaction(async (tx) => {
    const replay = await tx.stockIntake.findUnique({ where: { idempotencyKey: key } });
    if (replay) return { itemId: replay.itemId, intakeId: replay.id, status: replay.status, replayed: true };
    const code = input.kind === 'PROCEDURE' ? input.details?.code?.trim() : undefined;
    if (code) {
      const owner = await tx.stockItem.findUnique({ where: { code }, select: { name: true } });
      if (owner && owner.name.toLowerCase() !== name.toLowerCase()) throw new ConflictError('ITEM_CODE_TAKEN', `Item ID "${code}" pehle se "${owner.name}" ka hai.`);
    }

    let item = await tx.stockItem.findFirst({ where: { name } });
    if (item && item.kind !== input.kind) throw new ConflictError('ITEM_OTHER_CATEGORY', `"${item.name}" pehle se ${KIND_LABEL[item.kind]} mein hai.`);
    if (!item) {
      const d = input.kind === 'PROCEDURE' ? detailChanges(NO_DETAILS, input.details) : {};
      item = await tx.stockItem.create({ data: { name, kind: input.kind, category: KIND_LABEL[input.kind], baseUnit: input.unit?.trim() || 'piece', minQty: input.minQty ?? 0, ...d } });
      await audit(tx, actor, { action: 'STOCK_ITEM_CREATED', recordType: 'StockItem', recordId: item.id, after: item });
    } else {
      const data = { ...(input.kind === 'PROCEDURE' ? detailChanges(item, input.details) : {}), ...(input.minQty !== undefined && input.minQty !== item.minQty ? { minQty: input.minQty } : {}) };
      if (Object.keys(data).length) {
        const before = item;
        item = await tx.stockItem.update({ where: { id: item.id }, data });
        await audit(tx, actor, { action: 'STOCK_ITEM_UPDATED', recordType: 'StockItem', recordId: item.id, before, after: item });
      }
    }
    // Quantity 0: the product (and its details) only — nothing for the Manager to verify.
    if (input.quantity === 0) return { itemId: item.id, intakeId: null, status: null, replayed: false };
    const intake = await tx.stockIntake.create({
      data: {
        itemId: item.id,
        quantity: input.quantity,
        pricePaisa: BigInt(input.pricePaisa),
        expiryDate: input.expiryDate ? dateOnly(input.expiryDate) : null,
        lotNo: input.lotNo?.trim() || null,
        distributor: input.distributor?.trim().replace(/\s+/g, ' ') || null,
        costPaisa: input.kind === 'PHARMACY' && input.costPaisa !== undefined ? BigInt(input.costPaisa) : null,
        addedById: actor.id!,
        idempotencyKey: key,
      },
    });
    await audit(tx, actor, { action: 'STOCK_INTAKE_ADDED', recordType: 'StockIntake', recordId: intake.id, after: { itemId: item.id, name: item.name, kind: item.kind, quantity: input.quantity, pricePaisa: input.pricePaisa, expiryDate: input.expiryDate ?? null, lotNo: intake.lotNo, distributor: intake.distributor, costPaisa: intake.costPaisa } });
    await notifyRoles(tx, ['MANAGER'], {
      type: 'STOCK_INTAKE_PENDING',
      subject: `Stock verify karein: ${item.name} × ${input.quantity}`,
      body: `${KIND_LABEL[item.kind]} · ${actor.displayName} ne add kiya`,
      recordType: 'StockIntake',
      recordId: intake.id,
      sender: actor,
      priority: 1,
      actionLabel: 'Verify',
      dedupeKey: `intake:${intake.id}`,
    });
    return { itemId: item.id, intakeId: intake.id, status: intake.status, replayed: false };
  });
}

/** Stock waiting for verification (Manager) — or all recent intakes. */
export async function intakes(scope: 'pending' | 'recent') {
  const rows = await prisma.stockIntake.findMany({
    where: scope === 'pending' ? { status: 'PENDING' } : {},
    orderBy: { createdAt: scope === 'pending' ? 'asc' : 'desc' },
    take: scope === 'pending' ? 200 : 100,
    include: { item: { select: { name: true, kind: true, baseUnit: true, salePricePaisa: true } } },
  });
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.addedById, r.decidedById]).filter((x): x is string => !!x))] } }, select: { id: true, displayName: true } });
  const name = (id: string | null) => users.find((u) => u.id === id)?.displayName ?? null;
  return {
    items: rows.map((r) => ({
      id: r.id,
      itemId: r.itemId,
      name: r.item.name,
      kind: r.item.kind,
      unit: r.item.baseUnit,
      quantity: r.quantity,
      pricePaisa: r.pricePaisa,
      currentSalePricePaisa: r.item.kind === 'PHARMACY' ? r.item.salePricePaisa : null,
      expiryDate: r.expiryDate ? dateOnlyStr(r.expiryDate) : null,
      lotNo: r.lotNo,
      distributor: r.distributor,
      costPaisa: r.costPaisa,
      status: r.status,
      addedBy: name(r.addedById),
      addedAt: r.createdAt,
      decidedBy: name(r.decidedById),
      decidedAt: r.decidedAt,
      reason: r.reason,
    })),
  };
}

/**
 * Manager verifies: the batch and the `STOCK_IN` ledger row are written now, and a pharmacy price takes effect. The
 * person who added it cannot verify it (approver ≠ requester).
 */
export async function verifyIntake(actor: Actor, id: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM stock_intakes WHERE id = ${id} FOR UPDATE`;
    const intake = await tx.stockIntake.findUnique({ where: { id } });
    if (!intake) throw new NotFoundError('Stock entry');
    if (intake.status !== 'PENDING') throw new ConflictError('INTAKE_DECIDED', 'Yeh entry pehle hi verify / reject ho chuki hai.');
    if (intake.addedById === actor.id) throw new ForbiddenError({ recordType: 'StockIntake', recordId: id, rule: 'approver_not_requester' }, 'Apna add kiya stock khud verify nahi kar sakte.');
    await tx.$queryRaw`SELECT id FROM stock_items WHERE id = ${intake.itemId} FOR UPDATE`;
    const item = await tx.stockItem.findUniqueOrThrow({ where: { id: intake.itemId } });
    const n = (await tx.stockBatch.count({ where: { itemId: item.id } })) + 1;
    let vendorId: string | null = null;
    if (intake.distributor) {
      const v = (await tx.vendor.findUnique({ where: { name: intake.distributor } })) ?? (await tx.vendor.create({ data: { name: intake.distributor } }));
      vendorId = v.id;
    }
    // The typed batch number is kept; a second entry with the same number for this product gets a suffix.
    const taken = intake.lotNo ? await tx.stockBatch.findUnique({ where: { itemId_lotNo: { itemId: item.id, lotNo: intake.lotNo } } }) : null;
    const batch = await tx.stockBatch.create({
      data: {
        itemId: item.id,
        lotNo: intake.lotNo && !taken ? intake.lotNo : `${intake.lotNo ? `${intake.lotNo}-` : 'R'}${clinicDateStr(new Date()).replace(/-/g, '')}-${n}-${randomUUID().slice(0, 4)}`,
        expiryDate: intake.expiryDate,
        vendorId,
        unitCostPaisa: item.kind === 'PROCEDURE' ? intake.pricePaisa : intake.costPaisa,
      },
    });
    await tx.stockTransaction.create({
      data: { itemId: item.id, batchId: batch.id, type: 'STOCK_IN', quantity: intake.quantity, unitCostPaisa: batch.unitCostPaisa, vendorId, actorId: actor.id!, reason: `Reception stock-in, verified by Manager`, idempotencyKey: `intake:${intake.id}:in` },
    });
    if (item.kind === 'PHARMACY' && item.salePricePaisa !== intake.pricePaisa) await tx.stockItem.update({ where: { id: item.id }, data: { salePricePaisa: intake.pricePaisa, active: true } });
    else if (!item.active) await tx.stockItem.update({ where: { id: item.id }, data: { active: true } });
    await tx.stockIntake.update({ where: { id }, data: { status: 'VERIFIED', decidedById: actor.id, decidedAt: new Date(), batchId: batch.id } });
    await audit(tx, actor, { action: 'STOCK_INTAKE_VERIFIED', recordType: 'StockIntake', recordId: id, after: { batchId: batch.id, quantity: intake.quantity, pricePaisa: intake.pricePaisa } });
    await checkLowStock(tx, item.id);
    return { ok: true, batchId: batch.id };
  });
}

/** Manager rejects (reason required): nothing reaches the stock; the person who added it is told why. */
export async function rejectIntake(actor: Actor, id: string, reason: string) {
  if (!reason.trim()) throw new ValidationError('Reject ki wajah likhein.');
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM stock_intakes WHERE id = ${id} FOR UPDATE`;
    const intake = await tx.stockIntake.findUnique({ where: { id }, include: { item: { select: { name: true } } } });
    if (!intake) throw new NotFoundError('Stock entry');
    if (intake.status !== 'PENDING') throw new ConflictError('INTAKE_DECIDED', 'Yeh entry pehle hi verify / reject ho chuki hai.');
    if (intake.addedById === actor.id) throw new ForbiddenError({ recordType: 'StockIntake', recordId: id, rule: 'approver_not_requester' }, 'Apna add kiya stock khud reject nahi kar sakte.');
    await tx.stockIntake.update({ where: { id }, data: { status: 'REJECTED', decidedById: actor.id, decidedAt: new Date(), reason: reason.trim() } });
    await audit(tx, actor, { action: 'STOCK_INTAKE_REJECTED', recordType: 'StockIntake', recordId: id, reason: reason.trim() });
    await notifyUsers(tx, [intake.addedById], {
      type: 'STOCK_INTAKE_REJECTED',
      subject: `Stock reject: ${intake.item.name} × ${intake.quantity}`,
      body: reason.trim(),
      recordType: 'StockIntake',
      recordId: id,
      sender: actor,
      priority: 1,
      dedupeKey: `intake:${id}:rejected`,
    });
    return { ok: true };
  });
}

export interface UpdateProductInput {
  name?: string;
  minQty?: number;
  pricePaisa?: number;
  active?: boolean;
  unit?: string;
  /** Procedure catalogue fields (D-058): a string sets the field, null / "" clears it. */
  details?: { [K in keyof ProductDetails]?: ProductDetails[K] | null };
}

/**
 * Edit a product (D-058): name, unit, minimum, pharmacy selling price and — for procedure products — the stock CSV
 * columns. "Delete" from Reception is `active: false`: the product leaves the lists and pickers but its stock history
 * stays (no hard deletes, spec §4.9); `active: true` brings it back.
 */
export async function updateProduct(actor: Actor, id: string, input: UpdateProductInput) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.stockItem.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Product');
    const name = input.name?.trim().replace(/\s+/g, ' ');
    if (name && name !== before.name && (await tx.stockItem.findFirst({ where: { name, id: { not: id } } }))) throw new ConflictError('ITEM_EXISTS', 'Is naam ka product pehle se hai.');
    const clean = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim().replace(/\s+/g, ' ') || null);
    const d = before.kind === 'PROCEDURE' ? (input.details ?? {}) : {};
    const code = clean(d.code);
    if (code && code !== before.code && (await tx.stockItem.findFirst({ where: { code, id: { not: id } } }))) throw new ConflictError('ITEM_CODE_TAKEN', `Item ID "${code}" pehle se kisi aur product ka hai.`);
    const category = clean(d.category);
    const after = await tx.stockItem.update({
      where: { id },
      data: {
        ...(name ? { name } : {}),
        ...(input.unit?.trim() ? { baseUnit: input.unit.trim() } : {}),
        ...(input.minQty !== undefined ? { minQty: input.minQty } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.pricePaisa !== undefined && before.kind === 'PHARMACY' ? { salePricePaisa: BigInt(input.pricePaisa) } : {}),
        ...(code !== undefined ? { code } : {}),
        ...(category !== undefined ? { category: category ?? 'Procedure' } : {}),
        ...(clean(d.department) !== undefined ? { department: clean(d.department) } : {}),
        ...(clean(d.procedureUse) !== undefined ? { procedureUse: clean(d.procedureUse) } : {}),
        ...(clean(d.packUnit) !== undefined ? { packUnit: clean(d.packUnit) } : {}),
        ...(d.packSize !== undefined ? { packSize: d.packSize || null } : {}),
        ...(clean(d.itemType) !== undefined ? { itemType: clean(d.itemType) } : {}),
        ...(d.sterile !== undefined ? { sterile: d.sterile } : {}),
        ...(clean(d.note) !== undefined ? { note: clean(d.note) } : {}),
      },
    });
    await audit(tx, actor, { action: input.active === false ? 'STOCK_ITEM_REMOVED' : input.active === true && !before.active ? 'STOCK_ITEM_RESTORED' : 'STOCK_ITEM_UPDATED', recordType: 'StockItem', recordId: id, before, after });
    return { id: after.id, active: after.active };
  });
}
