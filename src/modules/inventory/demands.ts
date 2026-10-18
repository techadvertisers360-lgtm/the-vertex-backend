import type { DemandStatus, Prisma } from '@prisma/client';
import { prisma, type Tx } from '../../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { formatNumber, nextSequence } from '../../lib/misc';
import { local } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';
import { notifyRoles, notifyUsers } from '../../services/notifications';
import { deny } from '../../services/scope';
import { getSetting } from '../../services/settings';
import { onHand } from '../../services/stock';

/**
 * Stock demand approval (spec §4 lock 6, §14, §18): the Manager prices each line (estimate) and approves totals up to
 * `stock.managerApprovalLimitPaisa` (Rs 20,000, inclusive). Anything above — and any demand the Manager raised
 * (approver ≠ requester) — goes to the MD and cannot be purchased until approved. Every approved demand gets a
 * unique demand number (slip). Receipts are refused unless the demand is approved (D-037).
 */
export const OPEN_FOR_RECEIPT: DemandStatus[] = ['APPROVED', 'PARTIALLY_RECEIVED'];

async function lockDemand(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM stock_demands WHERE id = ${id} FOR UPDATE`;
  const d = await tx.stockDemand.findUnique({ where: { id }, include: { lines: true } });
  if (!d) throw new NotFoundError('Stock demand');
  return d;
}

const totalOf = (lines: { quantity: number; estUnitCostPaisa: bigint }[]) => lines.reduce((s, l) => s + BigInt(l.quantity) * l.estUnitCostPaisa, 0n);

/** Manager / MD view of demands with names, estimates, receipts and on-hand stock. */
export async function listDemands(filter: { scope: 'review' | 'md' | 'purchase' | 'all' }) {
  const where: Prisma.StockDemandWhereInput =
    filter.scope === 'review'
      ? { status: { in: ['PENDING_MANAGER', 'RETURNED_FOR_CORRECTION'] } }
      : filter.scope === 'md'
        ? { status: 'PENDING_MD' }
        : filter.scope === 'purchase'
          ? { status: { in: OPEN_FOR_RECEIPT } }
          : {};
  const rows = await prisma.stockDemand.findMany({ where, include: { lines: true }, orderBy: { createdAt: filter.scope === 'all' ? 'desc' : 'asc' }, take: 200 });
  return { items: await decorate(rows), limitPaisa: await getSetting('stock.managerApprovalLimitPaisa') };
}

async function decorate(rows: Prisma.StockDemandGetPayload<{ include: { lines: true } }>[]) {
  const itemIds = [...new Set(rows.flatMap((r) => r.lines.map((l) => l.itemId)))];
  const [items, users, receipts] = await Promise.all([
    prisma.stockItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, name: true, baseUnit: true, minQty: true } }),
    prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.requestedById, r.approvedById, r.forwardedById].filter((x): x is string => !!x)))] } }, select: { id: true, displayName: true } }),
    prisma.goodsReceipt.findMany({ where: { demandId: { in: rows.map((r) => r.id) } }, select: { id: true, demandId: true, vendorId: true, totalPaisa: true, receivedAt: true, vendorInvoiceNo: true } }),
  ]);
  const stock = new Map(await Promise.all(itemIds.map(async (id) => [id, await onHand(prisma, id)] as const)));
  const vendors = await prisma.vendor.findMany({ where: { id: { in: receipts.map((r) => r.vendorId) } }, select: { id: true, name: true } });
  const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.displayName ?? null) : null);
  return rows.map((r) => ({
    id: r.id,
    demandNumber: r.demandNumber,
    status: r.status,
    reason: r.reason,
    requesterRole: r.requesterRole,
    requestedBy: name(r.requestedById),
    requestedById: r.requestedById,
    createdAt: r.createdAt,
    estimatedTotalPaisa: r.estimatedTotalPaisa,
    approvedBy: name(r.approvedById),
    approverRole: r.approverRole,
    approvedAt: r.approvedAt,
    forwardedToMdAt: r.forwardedToMdAt,
    decisionReason: r.decisionReason,
    closedAt: r.closedAt,
    lines: r.lines.map((l) => {
      const it = items.find((i) => i.id === l.itemId);
      return { id: l.id, itemId: l.itemId, name: it?.name ?? '—', unit: it?.baseUnit ?? '', quantity: l.quantity, receivedQty: l.receivedQty, remainingQty: Math.max(0, l.quantity - l.receivedQty), estUnitCostPaisa: l.estUnitCostPaisa, lineTotalPaisa: BigInt(l.quantity) * l.estUnitCostPaisa, onHand: stock.get(l.itemId) ?? 0, minQty: it?.minQty ?? 0 };
    }),
    receipts: receipts.filter((x) => x.demandId === r.id).map((x) => ({ ...x, vendorName: vendors.find((v) => v.id === x.vendorId)?.name ?? null })),
    receivedTotalPaisa: receipts.filter((x) => x.demandId === r.id).reduce((s, x) => s + x.totalPaisa, 0n),
  }));
}

export async function getDemand(id: string) {
  const d = await prisma.stockDemand.findUnique({ where: { id }, include: { lines: true } });
  if (!d) throw new NotFoundError('Stock demand');
  const [view] = await decorate([d]);
  return { ...view!, limitPaisa: await getSetting('stock.managerApprovalLimitPaisa') };
}

/** Manager / MD prices the lines; the total decides who may approve. */
export async function setEstimates(actor: Actor, id: string, lines: { lineId: string; estUnitCostPaisa: number }[]) {
  return prisma.$transaction(async (tx) => {
    const d = await lockDemand(tx, id);
    const reviewer = actor.role === 'MD' ? d.status === 'PENDING_MD' : ['PENDING_MANAGER', 'RETURNED_FOR_CORRECTION'].includes(d.status);
    if (!reviewer) throw new ConflictError('NOT_IN_REVIEW', 'Is demand ki pricing ab badli nahi ja sakti.');
    for (const l of lines) {
      if (!d.lines.some((x) => x.id === l.lineId)) throw new ValidationError('Line is demand ki nahi.');
      await tx.stockDemandLine.update({ where: { id: l.lineId }, data: { estUnitCostPaisa: BigInt(l.estUnitCostPaisa) } });
    }
    const fresh = await tx.stockDemandLine.findMany({ where: { demandId: id } });
    const total = totalOf(fresh);
    await tx.stockDemand.update({ where: { id }, data: { estimatedTotalPaisa: total } });
    await audit(tx, actor, { action: 'DEMAND_ESTIMATED', recordType: 'StockDemand', recordId: id, before: { total: d.estimatedTotalPaisa }, after: { total, lines } });
    return { id, estimatedTotalPaisa: total };
  });
}

async function issueNumber(tx: Tx, now: Date) {
  const year = local(now).year;
  return formatNumber('DM', year, await nextSequence(tx, `demand:${year}`));
}

async function tellRequester(tx: Tx, actor: Actor, d: { id: string; requestedById: string }, subject: string, body: string) {
  if (d.requestedById !== actor.id) await notifyUsers(tx, [d.requestedById], { type: 'STOCK_DEMAND_DECISION', subject, body, recordType: 'StockDemand', recordId: d.id, sender: actor, dedupeKey: `demand:${d.id}:${subject}` });
}

/**
 * Manager decision. APPROVE only when priced, within the limit and not the Manager's own demand; FORWARD sends it to
 * the MD (required above the limit or for own demands); REJECT needs a reason.
 */
export async function managerDecision(actor: Actor, id: string, action: 'APPROVE' | 'FORWARD' | 'REJECT', reason?: string) {
  const limit = BigInt(await getSetting('stock.managerApprovalLimitPaisa'));
  return prisma.$transaction(async (tx) => {
    const d = await lockDemand(tx, id);
    if (!['PENDING_MANAGER', 'RETURNED_FOR_CORRECTION'].includes(d.status)) throw new ConflictError('NOT_IN_REVIEW', 'Is demand par Manager faisla ho chuka hai.');
    const total = totalOf(d.lines);
    const now = new Date();
    if (action === 'REJECT') {
      if (!reason?.trim()) throw new ValidationError('Reject ki wajah likhein.');
      await tx.stockDemand.update({ where: { id }, data: { status: 'REJECTED', decisionReason: reason.trim(), approvedById: actor.id, approverRole: 'MANAGER', approvedAt: now } });
      await audit(tx, actor, { action: 'DEMAND_REJECTED', recordType: 'StockDemand', recordId: id, reason });
      await tellRequester(tx, actor, d, 'Stock demand reject', reason.trim());
      return { id, status: 'REJECTED' as const };
    }
    if (d.lines.some((l) => l.estUnitCostPaisa <= 0n)) throw new ValidationError('Pehle har item ki estimated qeemat likhein.');
    if (action === 'APPROVE') {
      if (d.requestedById === actor.id) deny('StockDemand', id, 'demand:no_self_approval');
      if (total > limit) throw new ConflictError('MD_APPROVAL_REQUIRED', `Total Rs ${Number(total) / 100} hai — Rs ${Number(limit) / 100} se zyada demand MD approve karte hain. "Send to MD" karein.`, { totalPaisa: total, limitPaisa: limit });
      const number = await issueNumber(tx, now);
      await tx.stockDemand.update({ where: { id }, data: { status: 'APPROVED', demandNumber: number, approvedById: actor.id, approverRole: 'MANAGER', approvedAt: now, decisionReason: reason?.trim() || null } });
      await audit(tx, actor, { action: 'DEMAND_APPROVED', recordType: 'StockDemand', recordId: id, after: { demandNumber: number, totalPaisa: total, approverRole: 'MANAGER' } });
      await tellRequester(tx, actor, d, `Stock demand approve: ${number}`, `Total estimate Rs ${Number(total) / 100}`);
      return { id, status: 'APPROVED' as const, demandNumber: number };
    }
    // FORWARD to MD
    await tx.stockDemand.update({ where: { id }, data: { status: 'PENDING_MD', forwardedToMdAt: now, forwardedById: actor.id, decisionReason: reason?.trim() || null } });
    await audit(tx, actor, { action: 'DEMAND_FORWARDED_TO_MD', recordType: 'StockDemand', recordId: id, after: { totalPaisa: total }, reason });
    const items = await tx.stockItem.findMany({ where: { id: { in: d.lines.map((l) => l.itemId) } }, select: { id: true, name: true, baseUnit: true } });
    const lines = d.lines.map((l) => { const it = items.find((i) => i.id === l.itemId); return `${it?.name ?? 'item'} × ${l.quantity} ${it?.baseUnit ?? ''}`.trim(); }).join(', ');
    const mdBody = `${lines} · estimate Rs ${Number(total) / 100} · ${d.reason}${reason?.trim() ? ` · Manager note: ${reason.trim()}` : ''} · Manager: ${actor.displayName}`;
    await notifyRoles(tx, ['MD'], { type: 'STOCK_DEMAND_MD', subject: `Stock demand approval: Rs ${Number(total) / 100}`, body: mdBody, recordType: 'StockDemand', recordId: id, sender: actor, priority: 1, actionLabel: 'Approve / reject', dedupeKey: `demand:${id}:md:${now.getTime()}` });
    return { id, status: 'PENDING_MD' as const };
  });
}

/** MD decision (spec §15 approval center: Approve / Reject / Return for Correction, reason on reject/return). */
export async function mdDecision(actor: Actor, id: string, action: 'APPROVE' | 'REJECT' | 'RETURN', reason?: string) {
  if (action !== 'APPROVE' && !reason?.trim()) throw new ValidationError('Reject / Return ke liye wajah zaroori hai.');
  return prisma.$transaction(async (tx) => {
    const d = await lockDemand(tx, id);
    if (d.status !== 'PENDING_MD') throw new ConflictError('NOT_PENDING_MD', 'Yeh demand MD approval par nahi.');
    if (d.requestedById === actor.id) deny('StockDemand', id, 'demand:no_self_approval');
    const now = new Date();
    if (action === 'APPROVE') {
      if (d.lines.some((l) => l.estUnitCostPaisa <= 0n)) throw new ValidationError('Har item ki estimated qeemat zaroori hai.');
      const number = await issueNumber(tx, now);
      await tx.stockDemand.update({ where: { id }, data: { status: 'APPROVED', demandNumber: number, approvedById: actor.id, approverRole: 'MD', approvedAt: now, decisionReason: reason?.trim() || null } });
      await audit(tx, actor, { action: 'DEMAND_APPROVED', recordType: 'StockDemand', recordId: id, after: { demandNumber: number, totalPaisa: totalOf(d.lines), approverRole: 'MD' } });
      await notifyRoles(tx, ['MANAGER'], { type: 'STOCK_DEMAND_DECISION', subject: `MD ne demand approve ki: ${number}`, body: 'Ab purchase ho sakti hai.', recordType: 'StockDemand', recordId: id, sender: actor, dedupeKey: `demand:${id}:md-approved` });
      await tellRequester(tx, actor, d, `Stock demand approve: ${number}`, 'MD approval');
      return { id, status: 'APPROVED' as const, demandNumber: number };
    }
    const status = action === 'REJECT' ? 'REJECTED' : 'RETURNED_FOR_CORRECTION';
    await tx.stockDemand.update({ where: { id }, data: { status, decisionReason: reason!.trim(), ...(action === 'REJECT' ? { approvedById: actor.id, approverRole: 'MD' as const, approvedAt: now } : {}) } });
    await audit(tx, actor, { action: action === 'REJECT' ? 'DEMAND_REJECTED' : 'DEMAND_RETURNED', recordType: 'StockDemand', recordId: id, reason });
    await notifyRoles(tx, ['MANAGER'], { type: 'STOCK_DEMAND_DECISION', subject: action === 'REJECT' ? 'MD ne demand reject ki' : 'MD ne demand wapas ki (correction)', body: reason!.trim(), recordType: 'StockDemand', recordId: id, sender: actor, dedupeKey: `demand:${id}:md-${action}:${now.getTime()}` });
    if (action === 'REJECT') await tellRequester(tx, actor, d, 'Stock demand reject', reason!.trim());
    return { id, status };
  });
}

/** Stop further receipts on an approved demand (remaining quantity no longer needed). */
export async function closeDemand(actor: Actor, id: string, reason: string) {
  if (!reason.trim()) throw new ValidationError('Band karne ki wajah likhein.');
  return prisma.$transaction(async (tx) => {
    const d = await lockDemand(tx, id);
    if (!OPEN_FOR_RECEIPT.includes(d.status) && d.status !== 'RECEIVED') throw new ConflictError('NOT_OPEN', 'Sirf approved demand band ho sakti hai.');
    await tx.stockDemand.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date(), closedById: actor.id, decisionReason: reason.trim() } });
    await audit(tx, actor, { action: 'DEMAND_CLOSED', recordType: 'StockDemand', recordId: id, reason });
    return { id, status: 'CLOSED' as const };
  });
}

export { lockDemand, totalOf };
