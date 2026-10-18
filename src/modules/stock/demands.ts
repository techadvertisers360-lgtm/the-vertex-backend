import { prisma } from '../../lib/prisma';
import { ValidationError } from '../../lib/errors';
import { audit, type Actor } from '../../services/audit';
import { notifyRoles } from '../../services/notifications';

/**
 * Stock demand raised by an Assistant or Office Boy (spec §12, §13, §18): item, quantity and reason go to the
 * Manager's demand queue. Requesters never see costs; the demand number is issued on approval (Phase 8), and
 * totals above the Manager limit are routed to the MD there.
 */
export async function createDemand(actor: Actor, input: { lines: { itemId: string; quantity: number }[]; reason: string }) {
  const ids = input.lines.map((l) => l.itemId);
  if (!ids.length) throw new ValidationError('Kam az kam ek item chunein.');
  if (new Set(ids).size !== ids.length) throw new ValidationError('Ek item ek hi dafa likhein.');
  return prisma.$transaction(async (tx) => {
    const items = await tx.stockItem.findMany({ where: { id: { in: ids }, active: true }, select: { id: true, name: true, baseUnit: true } });
    if (items.length !== ids.length) throw new ValidationError('Stock item nahi mila.');
    const d = await tx.stockDemand.create({
      data: { requestedById: actor.id!, requesterRole: actor.role!, reason: input.reason.trim(), status: 'PENDING_MANAGER', lines: { create: input.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })) } },
    });
    await audit(tx, actor, { action: 'STOCK_DEMAND_CREATED', recordType: 'StockDemand', recordId: d.id, after: { lines: input.lines, reason: input.reason.trim() } });
    const summary = input.lines.map((l) => `${items.find((i) => i.id === l.itemId)!.name} × ${l.quantity}`).join(', ');
    await notifyRoles(tx, ['MANAGER'], {
      type: 'STOCK_DEMAND',
      subject: `Stock demand: ${actor.displayName}`,
      body: `${summary} — ${input.reason.trim()}`,
      recordType: 'StockDemand',
      recordId: d.id,
      sender: actor,
      actionLabel: 'Review demand',
      dedupeKey: `demand:${d.id}:created`,
    });
    return { id: d.id, status: d.status, createdAt: d.createdAt };
  });
}

/** Own demands with status and demand number — no prices (spec §4: costs are Manager/MD only). */
export async function myDemands(actor: Actor) {
  const rows = await prisma.stockDemand.findMany({
    where: { requestedById: actor.id! },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, demandNumber: true, status: true, reason: true, decisionReason: true, createdAt: true, approvedAt: true, lines: { select: { itemId: true, quantity: true, receivedQty: true } } },
  });
  const items = await prisma.stockItem.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => r.lines.map((l) => l.itemId)))] } }, select: { id: true, name: true, baseUnit: true } });
  return {
    items: rows.map((r) => ({
      ...r,
      lines: r.lines.map((l) => ({ ...l, name: items.find((i) => i.id === l.itemId)?.name ?? '—', unit: items.find((i) => i.id === l.itemId)?.baseUnit ?? '' })),
    })),
  };
}
