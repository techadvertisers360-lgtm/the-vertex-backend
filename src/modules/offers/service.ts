import { prisma } from '../../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { audit, type Actor } from '../../services/audit';
import { claimAttachments } from '../../services/files';
import { notifyRoles } from '../../services/notifications';

/**
 * Creatives & offers (spec §17): Muaz / Hamza upload the final poster or ad with offer title, service and validity.
 * Active offers show to Lead Team, Reception and Manager; once expired (or withdrawn) an offer leaves the active list
 * but stays in history. Creatives are public files (not clinical) and are served through the files endpoint.
 */

const isActive = (o: { validFrom: Date; validTo: Date; withdrawnAt: Date | null }, now: Date) => !o.withdrawnAt && o.validFrom <= now && o.validTo > now;

async function decorate(rows: Awaited<ReturnType<typeof prisma.offer.findMany>>, now: Date) {
  const [sheets, users] = await Promise.all([
    prisma.metaSheet.findMany({ where: { id: { in: rows.map((r) => r.sheetId).filter((x): x is string => !!x) } }, select: { id: true, title: true, campaign: true } }),
    prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.createdById))] } }, select: { id: true, displayName: true } }),
  ]);
  return rows.map((o) => ({
    id: o.id,
    title: o.title,
    serviceName: o.serviceName,
    description: o.description,
    validFrom: o.validFrom,
    validTo: o.validTo,
    attachmentId: o.attachmentId,
    sheet: sheets.find((s) => s.id === o.sheetId) ?? null,
    createdBy: users.find((u) => u.id === o.createdById)?.displayName ?? null,
    withdrawnAt: o.withdrawnAt,
    state: o.withdrawnAt ? ('WITHDRAWN' as const) : o.validTo <= now ? ('EXPIRED' as const) : o.validFrom > now ? ('SCHEDULED' as const) : ('ACTIVE' as const),
  }));
}

/** Everyone with `offers:read`: only offers live right now. */
export async function activeOffers(now = new Date()) {
  const rows = await prisma.offer.findMany({ where: { withdrawnAt: null, validFrom: { lte: now }, validTo: { gt: now } }, orderBy: { validTo: 'asc' } });
  return { items: await decorate(rows, now) };
}

/** Marketing view: all offers with state (active / scheduled / expired / withdrawn). */
export async function allOffers(now = new Date()) {
  const rows = await prisma.offer.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  return { items: await decorate(rows, now) };
}

export async function createOffer(actor: Actor, input: { title: string; serviceName?: string; description?: string; sheetId?: string; validFrom: Date; validTo: Date; attachmentId: string }) {
  if (!input.title.trim()) throw new ValidationError('Offer title likhein.');
  if (input.validTo <= input.validFrom) throw new ValidationError('Validity end, start ke baad ho.');
  if (input.validTo <= new Date()) throw new ValidationError('Validity end guzar chuki hai.');
  return prisma.$transaction(async (tx) => {
    if (input.sheetId && !(await tx.metaSheet.findUnique({ where: { id: input.sheetId } }))) throw new ValidationError('Sheet nahi mili.');
    const o = await tx.offer.create({
      data: { title: input.title.trim(), serviceName: input.serviceName?.trim() || null, description: input.description?.trim() || null, sheetId: input.sheetId ?? null, validFrom: input.validFrom, validTo: input.validTo, createdById: actor.id! },
    });
    await claimAttachments(tx, actor, [input.attachmentId], ['adCreative'], 'Offer', o.id);
    await tx.offer.update({ where: { id: o.id }, data: { attachmentId: input.attachmentId } });
    await audit(tx, actor, { action: 'OFFER_PUBLISHED', recordType: 'Offer', recordId: o.id, after: { ...o, attachmentId: input.attachmentId } });
    if (input.validFrom <= new Date()) {
      await notifyRoles(tx, ['LEAD_MEMBER', 'RECEPTIONIST', 'MANAGER'], { type: 'OFFER_PUBLISHED', subject: `Naya offer: ${o.title}`, body: `${o.serviceName ?? ''} · ${input.validTo.toISOString().slice(0, 10)} tak`.trim(), recordType: 'Offer', recordId: o.id, sender: actor, dedupeKey: `offer:${o.id}` });
    }
    return o;
  });
}

export async function withdrawOffer(actor: Actor, id: string, reason: string) {
  if (!reason.trim()) throw new ValidationError('Wajah likhein.');
  return prisma.$transaction(async (tx) => {
    const o = await tx.offer.findUnique({ where: { id } });
    if (!o) throw new NotFoundError('Offer');
    if (o.withdrawnAt || o.validTo <= new Date()) throw new ConflictError('OFFER_ENDED', 'Offer pehle hi khatam ho chuka hai.');
    const out = await tx.offer.update({ where: { id }, data: { withdrawnAt: new Date(), withdrawnById: actor.id } });
    await audit(tx, actor, { action: 'OFFER_WITHDRAWN', recordType: 'Offer', recordId: id, reason });
    return out;
  });
}

export { isActive };
