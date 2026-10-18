import { prisma } from '../../lib/prisma';
import { ConflictError } from '../../lib/errors';
import { audit, type Actor } from '../../services/audit';

/**
 * Manager stock-check tasks (spec §19): created with each procedure's 2-day reminder, one per procedure session.
 * The Manager checks the stock for it and marks it done; cancelled / rescheduled procedures drop their check.
 */
export async function list(scope: 'open' | 'done') {
  const rows = await prisma.workflowTask.findMany({
    where: { type: 'MANAGER_STOCK_CHECK', status: scope === 'open' ? { in: ['PENDING', 'IN_PROGRESS'] } : { in: ['COMPLETED', 'CANCELLED'] } },
    orderBy: scope === 'open' ? { dueAt: 'asc' } : { updatedAt: 'desc' },
    take: scope === 'open' ? 200 : 50,
    select: { id: true, title: true, status: true, dueAt: true, createdAt: true, completedAt: true, completedById: true, payload: true, appointmentId: true },
  });
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.completedById).filter((x): x is string => !!x) } }, select: { id: true, displayName: true } });
  return { items: rows.map((r) => ({ ...r, completedBy: users.find((u) => u.id === r.completedById)?.displayName ?? null })) };
}

export async function complete(actor: Actor, id: string, note?: string) {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.workflowTask.updateMany({ where: { id, type: 'MANAGER_STOCK_CHECK', status: { in: ['PENDING', 'IN_PROGRESS'] } }, data: { status: 'COMPLETED', completedAt: new Date(), completedById: actor.id } });
    if (!count) throw new ConflictError('NOT_OPEN', 'Yeh stock check open nahi.');
    await audit(tx, actor, { action: 'STOCK_CHECK_DONE', recordType: 'WorkflowTask', recordId: id, reason: note?.trim() || null });
    return { id };
  });
}
