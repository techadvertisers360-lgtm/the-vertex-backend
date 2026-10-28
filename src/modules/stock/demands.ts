import { prisma } from '../../lib/prisma';
import { ValidationError } from '../../lib/errors';
import { audit, type Actor } from '../../services/audit';
import { notifyRoles } from '../../services/notifications';

/**
 * Stock demand raised by an Assistant or Office Boy (spec §12, §13, §18): item, quantity and reason go to the
 * Manager's demand queue. Requesters never see costs; the demand number is issued on approval (Phase 8), and
 * totals above the Manager limit are routed to the MD there.
 */
export interface DemandLineInput {
  itemId?: string;
  /** Office Boy writes the item by name (D-066) — not a stock item. */
  itemName?: string;
  quantity?: number;
}

export async function createDemand(actor: Actor, input: { lines: DemandLineInput[]; reason: string }) {
  if (!input.lines.length) throw new ValidationError('Kam az kam ek item likhein.');
  // Office Boy: items by name only (client 2026-10-28, D-066). Assistant: stock items with quantity.
  const written = actor.role === 'OFFICE_BOY';
  const lines = input.lines.map((l) => {
    if (written) {
      const name = l.itemName?.trim().replace(/\s+/g, ' ') ?? '';
      if (name.length < 2) throw new ValidationError('Har item ka naam likhein.');
      return { itemId: null, itemName: name, quantity: l.quantity ?? 1 };
    }
    if (!l.itemId || !l.quantity) throw new ValidationError('Item aur quantity chunein.');
    return { itemId: l.itemId, itemName: null, quantity: l.quantity };
  });
  const key = (l: (typeof lines)[number]) => l.itemId ?? l.itemName!.toLowerCase();
  if (new Set(lines.map(key)).size !== lines.length) throw new ValidationError('Ek item ek hi dafa likhein.');
  return prisma.$transaction(async (tx) => {
    const ids = lines.flatMap((l) => (l.itemId ? [l.itemId] : []));
    const items = await tx.stockItem.findMany({ where: { id: { in: ids }, active: true }, select: { id: true, name: true, baseUnit: true } });
    if (items.length !== ids.length) throw new ValidationError('Stock item nahi mila.');
    const d = await tx.stockDemand.create({
      data: { requestedById: actor.id!, requesterRole: actor.role!, reason: input.reason.trim(), status: 'PENDING_MANAGER', lines: { create: lines } },
    });
    await audit(tx, actor, { action: 'STOCK_DEMAND_CREATED', recordType: 'StockDemand', recordId: d.id, after: { lines, reason: input.reason.trim() } });
    const summary = lines.map((l) => (l.itemName ? l.itemName : `${items.find((i) => i.id === l.itemId)!.name} × ${l.quantity}`)).join(', ');
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
    select: { id: true, demandNumber: true, status: true, reason: true, decisionReason: true, createdAt: true, approvedAt: true, lines: { select: { itemId: true, itemName: true, quantity: true, receivedQty: true } } },
  });
  const items = await prisma.stockItem.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => r.lines.flatMap((l) => (l.itemId ? [l.itemId] : []))))] } }, select: { id: true, name: true, baseUnit: true } });
  return {
    items: rows.map((r) => ({
      ...r,
      lines: r.lines.map(({ itemName, ...l }) => ({ ...l, name: itemName ?? items.find((i) => i.id === l.itemId)?.name ?? '—', unit: items.find((i) => i.id === l.itemId)?.baseUnit ?? '' })),
    })),
  };
}
