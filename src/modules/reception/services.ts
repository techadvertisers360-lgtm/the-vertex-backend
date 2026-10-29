import { prisma } from '../../lib/prisma';
import { ConflictError, NotFoundError } from '../../lib/errors';
import { audit, type Actor } from '../../services/audit';

/**
 * Reception "Procedures & Services" (client 2026-10-26, D-060): the `Service` catalogue — the same list the booking
 * and treatment-plan pickers use — shown with the columns of the developer's CSV (Category, Procedure / Service,
 * Source, Note). Reception adds, edits and hides entries; nothing is deleted (bookings and plans point at them).
 */

const clean = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim().replace(/\s+/g, ' ') || null);

export async function list() {
  const items = await prisma.service.findMany({
    select: { id: true, name: true, type: true, category: true, source: true, note: true, active: true, defaultPricePaisa: true },
    orderBy: [{ active: 'desc' }, { category: 'asc' }, { name: 'asc' }],
  });
  return { items };
}

export interface ServiceInput {
  name: string;
  category?: string | null;
  source?: string | null;
  note?: string | null;
}

export async function add(actor: Actor, input: ServiceInput) {
  const name = clean(input.name)!;
  return prisma.$transaction(async (tx) => {
    if (await tx.service.findFirst({ where: { name } })) throw new ConflictError('SERVICE_EXISTS', `"${name}" pehle se list mein hai.`);
    const svc = await tx.service.create({ data: { name, type: 'PROCEDURE', category: clean(input.category) ?? null, source: clean(input.source) ?? null, note: clean(input.note) ?? null } });
    await audit(tx, actor, { action: 'SERVICE_CREATED', recordType: 'Service', recordId: svc.id, after: svc });
    return { id: svc.id };
  });
}

/** Edit any column (null / "" clears it); `active: false` hides it from the list and pickers, `true` brings it back. */
export async function update(actor: Actor, id: string, input: Partial<ServiceInput> & { active?: boolean }) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.service.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Procedure / Service');
    const name = input.name !== undefined ? clean(input.name) : undefined;
    if (name && name !== before.name && (await tx.service.findFirst({ where: { name, id: { not: id } } }))) throw new ConflictError('SERVICE_EXISTS', `"${name}" pehle se list mein hai.`);
    const after = await tx.service.update({
      where: { id },
      data: {
        ...(name ? { name } : {}),
        ...(input.category !== undefined ? { category: clean(input.category) } : {}),
        ...(input.source !== undefined ? { source: clean(input.source) } : {}),
        ...(input.note !== undefined ? { note: clean(input.note) } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      },
    });
    await audit(tx, actor, { action: input.active === false ? 'SERVICE_REMOVED' : input.active === true && !before.active ? 'SERVICE_RESTORED' : 'SERVICE_UPDATED', recordType: 'Service', recordId: id, before, after });
    return { id, active: after.active };
  });
}
