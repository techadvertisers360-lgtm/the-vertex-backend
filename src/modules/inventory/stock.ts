import { prisma } from '../../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { addMonthsStr, clinicDateStr, dateOnly, dateOnlyStr } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';
import { claimAttachments } from '../../services/files';
import { notifyRoles, notifyUsers } from '../../services/notifications';
import { deny } from '../../services/scope';
import { getSetting } from '../../services/settings';
import { batchBalances, checkLowStock, onHand, usableBatches } from '../../services/stock';

/**
 * Stock overview (spec §18): quantities come only from the ledger. Usable stock excludes expired and quarantined
 * batches (and near-expiry ones unless `stock.nearExpiryUsable`). Batches can be quarantined / released with a reason.
 */
export async function overview() {
  const today = clinicDateStr(new Date());
  const alertBy = addMonthsStr(today, await getSetting('stock.expiryAlertMonths'));
  const [items, vendors, sums] = await Promise.all([
    prisma.stockItem.findMany({ orderBy: { name: 'asc' } }),
    prisma.vendor.findMany({ select: { id: true, name: true } }),
    prisma.stockTransaction.groupBy({ by: ['itemId'], _sum: { quantity: true } }),
  ]);
  const out = [];
  for (const i of items) {
    const [usable, batches, balances] = await Promise.all([usableBatches(prisma, i.id), prisma.stockBatch.findMany({ where: { itemId: i.id } }), batchBalances(prisma, i.id)]);
    const live = batches.filter((b) => (balances.get(b.id) ?? 0) > 0);
    const hand = sums.find((s) => s.itemId === i.id)?._sum.quantity ?? 0;
    out.push({
      id: i.id,
      name: i.name,
      category: i.category,
      baseUnit: i.baseUnit,
      packUnit: i.packUnit,
      packSize: i.packSize,
      minQty: i.minQty,
      active: i.active,
      preferredVendor: vendors.find((v) => v.id === i.preferredVendorId)?.name ?? null,
      onHand: hand,
      usable: usable.reduce((s, b) => s + b.balance, 0),
      low: hand <= i.minQty,
      expired: live.filter((b) => b.expiryDate && dateOnlyStr(b.expiryDate) <= today).reduce((s, b) => s + (balances.get(b.id) ?? 0), 0),
      quarantined: live.filter((b) => b.status === 'QUARANTINED').reduce((s, b) => s + (balances.get(b.id) ?? 0), 0),
      nearExpiry: live.filter((b) => b.expiryDate && dateOnlyStr(b.expiryDate) > today && dateOnlyStr(b.expiryDate) <= alertBy).length,
    });
  }
  return { items: out };
}

export async function itemDetail(itemId: string) {
  const item = await prisma.stockItem.findUnique({ where: { id: itemId } });
  if (!item) throw new NotFoundError('Stock item');
  const today = clinicDateStr(new Date());
  const alertBy = addMonthsStr(today, await getSetting('stock.expiryAlertMonths'));
  const [batches, balances, vendors, txns] = await Promise.all([
    prisma.stockBatch.findMany({ where: { itemId }, orderBy: [{ expiryDate: 'asc' }, { createdAt: 'asc' }] }),
    batchBalances(prisma, itemId),
    prisma.vendor.findMany({ select: { id: true, name: true } }),
    prisma.stockTransaction.findMany({ where: { itemId }, orderBy: { createdAt: 'desc' }, take: 40 }),
  ]);
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(txns.map((t) => t.actorId))] } }, select: { id: true, displayName: true } });
  return {
    item: { ...item, onHand: await onHand(prisma, itemId) },
    batches: batches.map((b) => {
      const exp = b.expiryDate ? dateOnlyStr(b.expiryDate) : null;
      return {
        id: b.id,
        lotNo: b.lotNo,
        expiryDate: exp,
        status: b.status,
        statusReason: b.statusReason,
        balance: balances.get(b.id) ?? 0,
        unitCostPaisa: b.unitCostPaisa,
        vendorId: b.vendorId,
        vendorName: vendors.find((v) => v.id === b.vendorId)?.name ?? null,
        expired: !!exp && exp <= today,
        nearExpiry: !!exp && exp > today && exp <= alertBy,
      };
    }),
    transactions: txns.map((t) => ({ id: t.id, at: t.createdAt, type: t.type, quantity: t.quantity, batchId: t.batchId, reason: t.reason, actor: users.find((u) => u.id === t.actorId)?.displayName ?? null })),
  };
}

export async function createItem(actor: Actor, input: { name: string; category: string; baseUnit: string; packUnit?: string; packSize?: number; minQty: number; preferredVendorId?: string }) {
  const name = input.name.trim();
  return prisma.$transaction(async (tx) => {
    if (await tx.stockItem.findUnique({ where: { name } })) throw new ConflictError('ITEM_EXISTS', 'Is naam ka item pehle se hai.');
    const it = await tx.stockItem.create({ data: { name, category: input.category.trim(), baseUnit: input.baseUnit.trim(), packUnit: input.packUnit?.trim() || null, packSize: input.packSize ?? null, minQty: input.minQty, preferredVendorId: input.preferredVendorId ?? null } });
    await audit(tx, actor, { action: 'STOCK_ITEM_CREATED', recordType: 'StockItem', recordId: it.id, after: it });
    return it;
  });
}

export async function updateItem(actor: Actor, id: string, input: { minQty?: number; preferredVendorId?: string | null; active?: boolean }) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.stockItem.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Stock item');
    const it = await tx.stockItem.update({ where: { id }, data: input });
    await audit(tx, actor, { action: 'STOCK_ITEM_UPDATED', recordType: 'StockItem', recordId: id, before: { minQty: before.minQty, preferredVendorId: before.preferredVendorId, active: before.active }, after: input });
    await checkLowStock(tx, id);
    return it;
  });
}

/** Quarantine a batch (excluded from usable stock) or release it. Expired batches cannot be released. */
export async function setBatchStatus(actor: Actor, batchId: string, status: 'QUARANTINED' | 'AVAILABLE', reason: string) {
  if (!reason.trim()) throw new ValidationError('Wajah likhein.');
  return prisma.$transaction(async (tx) => {
    const b = await tx.stockBatch.findUnique({ where: { id: batchId } });
    if (!b) throw new NotFoundError('Batch');
    if (status === 'AVAILABLE' && b.expiryDate && dateOnlyStr(b.expiryDate) <= clinicDateStr(new Date())) throw new ConflictError('BATCH_EXPIRED', 'Expired batch release nahi ho sakta.');
    const out = await tx.stockBatch.update({ where: { id: batchId }, data: { status, statusReason: reason.trim() } });
    await audit(tx, actor, { action: status === 'QUARANTINED' ? 'BATCH_QUARANTINED' : 'BATCH_RELEASED', recordType: 'StockBatch', recordId: batchId, before: { status: b.status }, after: { status }, reason });
    return out;
  });
}

// ───────────── Damage / breakage write-off (Manager approval) ─────────────

export async function reportDamage(actor: Actor, input: { itemId: string; batchId?: string; quantity: number; reason: string; attachmentId?: string }) {
  if (!input.reason.trim()) throw new ValidationError('Wajah likhein.');
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new ValidationError('Quantity sahi likhein.');
  return prisma.$transaction(async (tx) => {
    const item = await tx.stockItem.findUnique({ where: { id: input.itemId } });
    if (!item) throw new ValidationError('Stock item nahi mila.');
    if (input.batchId && !(await tx.stockBatch.findFirst({ where: { id: input.batchId, itemId: item.id } }))) throw new ValidationError('Batch is item ka nahi.');
    // Approver ≠ requester: damage reported by a Manager is approved by the MD (D-037).
    const approverRole = actor.role === 'MANAGER' ? 'MD' : 'MANAGER';
    const r = await tx.damageReport.create({ data: { itemId: item.id, batchId: input.batchId ?? null, quantity: input.quantity, reason: input.reason.trim(), reportedById: actor.id!, approverRole } });
    if (input.attachmentId) {
      await claimAttachments(tx, actor, [input.attachmentId], ['damagePhoto'], 'DamageReport', r.id);
      await tx.damageReport.update({ where: { id: r.id }, data: { attachmentId: input.attachmentId } });
    }
    await audit(tx, actor, { action: 'DAMAGE_REPORTED', recordType: 'DamageReport', recordId: r.id, after: { itemId: item.id, quantity: input.quantity, batchId: input.batchId }, reason: input.reason });
    await notifyRoles(tx, [approverRole], { type: 'DAMAGE_REPORTED', subject: `Damage: ${item.name} × ${input.quantity}`, body: `${actor.displayName}: ${input.reason.trim()}`, recordType: 'DamageReport', recordId: r.id, sender: actor, actionLabel: 'Approve / reject', dedupeKey: `damage:${r.id}` });
    return r;
  });
}

export async function listDamage(scope: 'pending' | 'all', role: 'MANAGER' | 'MD') {
  const rows = await prisma.damageReport.findMany({ where: { approverRole: role, ...(scope === 'pending' ? { status: 'PENDING' } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 });
  const [items, users, batches] = await Promise.all([
    prisma.stockItem.findMany({ where: { id: { in: rows.map((r) => r.itemId) } }, select: { id: true, name: true, baseUnit: true } }),
    prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.reportedById, r.reviewedById].filter((x): x is string => !!x)))] } }, select: { id: true, displayName: true } }),
    prisma.stockBatch.findMany({ where: { id: { in: rows.map((r) => r.batchId).filter((x): x is string => !!x) } }, select: { id: true, lotNo: true } }),
  ]);
  return {
    items: rows.map((r) => ({
      ...r,
      itemName: items.find((i) => i.id === r.itemId)?.name ?? '—',
      unit: items.find((i) => i.id === r.itemId)?.baseUnit ?? '',
      lotNo: batches.find((b) => b.id === r.batchId)?.lotNo ?? null,
      reportedBy: users.find((u) => u.id === r.reportedById)?.displayName ?? null,
      reviewedBy: users.find((u) => u.id === r.reviewedById)?.displayName ?? null,
    })),
  };
}

/** Approve → write-off from the named batch (or FEFO across batches); reject keeps stock. */
export async function decideDamage(actor: Actor, id: string, approve: boolean, reason?: string) {
  if (!approve && !reason?.trim()) throw new ValidationError('Reject ki wajah likhein.');
  return prisma.$transaction(async (tx) => {
    const r = await tx.damageReport.findUnique({ where: { id } });
    if (!r) throw new NotFoundError('Damage report');
    if (r.approverRole !== actor.role) deny('DamageReport', id, 'damage:approver_role');
    if (r.reportedById === actor.id) deny('DamageReport', id, 'damage:no_self_approval');
    if (r.status !== 'PENDING') throw new ConflictError('ALREADY_DECIDED', 'Is report par faisla ho chuka hai.');
    await tx.$queryRaw`SELECT id FROM stock_items WHERE id = ${r.itemId} FOR UPDATE`;
    if (approve) {
      const balances = await batchBalances(tx, r.itemId);
      let remaining = r.quantity;
      const order = r.batchId ? [r.batchId] : [...(await tx.stockBatch.findMany({ where: { itemId: r.itemId }, orderBy: [{ expiryDate: 'asc' }, { createdAt: 'asc' }] }))].map((b) => b.id);
      const total = order.reduce((s, b) => s + Math.max(0, balances.get(b) ?? 0), 0);
      if (total < r.quantity) throw new ConflictError('INSUFFICIENT_STOCK', `Sirf ${total} stock mein hai — write-off ${r.quantity} nahi ho sakta.`);
      for (const b of order) {
        if (!remaining) break;
        const take = Math.min(remaining, Math.max(0, balances.get(b) ?? 0));
        if (!take) continue;
        await tx.stockTransaction.create({ data: { itemId: r.itemId, batchId: b, type: 'DAMAGE', quantity: -take, actorId: actor.id!, reason: r.reason, idempotencyKey: `damage:${r.id}:${b}` } });
        remaining -= take;
      }
    }
    await tx.damageReport.update({ where: { id }, data: { status: approve ? 'APPROVED' : 'REJECTED', reviewedById: actor.id, reviewedAt: new Date(), decisionReason: reason?.trim() || null } });
    await audit(tx, actor, { action: approve ? 'DAMAGE_WRITTEN_OFF' : 'DAMAGE_REJECTED', recordType: 'DamageReport', recordId: id, reason });
    if (r.reportedById !== actor.id) await notifyUsers(tx, [r.reportedById], { type: 'DAMAGE_DECISION', subject: approve ? 'Damage write-off approve' : 'Damage report reject', body: reason?.trim() || '', recordType: 'DamageReport', recordId: id, sender: actor, dedupeKey: `damage:${id}:decided` });
    if (approve) await checkLowStock(tx, r.itemId);
    return { id, status: approve ? ('APPROVED' as const) : ('REJECTED' as const) };
  });
}

// ───────────── Alerts watcher (spec §18, §20) ─────────────

/**
 * Expiry alert exactly `stock.expiryAlertMonths` (2) calendar months ahead, once per batch with stock; past-expiry
 * batches are marked EXPIRED (never usable). Low-stock is re-checked for every item (once per episode).
 */
export async function runStockAlerts(now = new Date()): Promise<number> {
  const today = clinicDateStr(now);
  const months = await getSetting('stock.expiryAlertMonths');
  const alertBy = addMonthsStr(today, months);
  let n = 0;
  const due = await prisma.stockBatch.findMany({ where: { expiryAlertedAt: null, expiryDate: { not: null, lte: dateOnly(alertBy) }, status: { in: ['AVAILABLE', 'QUARANTINED'] } } });
  for (const b of due) {
    const bal = (await batchBalances(prisma, b.itemId)).get(b.id) ?? 0;
    if (bal <= 0) continue;
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.stockBatch.updateMany({ where: { id: b.id, expiryAlertedAt: null }, data: { expiryAlertedAt: now } });
      if (!count) return;
      const item = await tx.stockItem.findUniqueOrThrow({ where: { id: b.itemId }, select: { name: true, baseUnit: true } });
      const exp = dateOnlyStr(b.expiryDate!);
      await notifyRoles(tx, ['MANAGER'], {
        type: 'EXPIRY_ALERT',
        subject: `Expiry ${exp}: ${item.name}`,
        body: `Lot ${b.lotNo} · ${bal} ${item.baseUnit} · ${exp <= today ? 'expire ho chuka' : `${months} mahine ke andar expire`}`,
        recordType: 'StockItem',
        recordId: b.itemId,
        priority: 1,
        dedupeKey: `expiry:${b.id}`,
      });
      n += 1;
    });
  }
  const { count: expired } = await prisma.stockBatch.updateMany({ where: { status: 'AVAILABLE', expiryDate: { not: null, lte: dateOnly(today) } }, data: { status: 'EXPIRED', statusReason: 'Expiry date guzar gayi' } });
  n += expired;
  for (const i of await prisma.stockItem.findMany({ where: { active: true }, select: { id: true } })) {
    await prisma.$transaction((tx) => checkLowStock(tx, i.id));
  }
  return n;
}
