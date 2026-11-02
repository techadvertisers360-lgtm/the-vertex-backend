import { Prisma, type ExpenseSource, type PackageKind, type Role } from '@prisma/client';
import { moneyTx, prisma } from '../../lib/prisma';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors';
import { formatNumber, nextSequence } from '../../lib/misc';
import { addMinutes, clinicDateStr, clinicDayBounds, dateOnly, dateOnlyStr, local } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';
import { getSetting } from '../../services/settings';
import { notifyRoles, notifyUsers } from '../../services/notifications';
import { createDirectInvoice, type PaymentInput } from '../invoices/service';
import { monthBounds } from './finance';

/** Clinic operations from the client's demo (D-089). */

const OWNERS: Role[] = ['MD', 'MARKETING_DIRECTOR'];
const nameMap = async (ids: (string | null | undefined)[]) => {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  const users = list.length ? await prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, displayName: true } }) : [];
  return (id: string | null | undefined) => (id ? (users.find((u) => u.id === id)?.displayName ?? null) : null);
};
const number = async (tx: Prisma.TransactionClient, prefix: string, seq: string) => {
  const year = local(new Date()).year;
  return formatNumber(prefix, year, await nextSequence(tx, `${seq}:${year}`));
};

// ───────────── Clinic now ─────────────

export async function clinicNow() {
  const today = clinicDateStr(new Date());
  const b = clinicDayBounds(today);
  const [staff, attendance, inClinic, doctors, leaves] = await Promise.all([
    prisma.user.findMany({ where: { active: true, isDemo: false, attendanceRequired: true }, select: { id: true, displayName: true, role: true }, orderBy: { displayName: 'asc' } }),
    prisma.attendance.findMany({ where: { date: dateOnly(today) }, select: { userId: true, checkInAt: true, checkOutAt: true } }),
    prisma.appointment.findMany({ where: { startAt: { gte: b.start, lt: b.end }, status: { in: ['CHECKED_IN', 'WAITING', 'WITH_DOCTOR', 'RECEPTION', 'PROCEDURE'] } }, orderBy: { startAt: 'asc' }, select: { id: true, status: true, startAt: true, doctorId: true, patient: { select: { name: true } } } }),
    prisma.user.findMany({ where: { active: true, role: 'DOCTOR', isDemo: false }, select: { id: true, displayName: true }, orderBy: { displayName: 'asc' } }),
    prisma.doctorAvailabilityException.findMany({ where: { kind: 'LEAVE', status: 'APPROVED', date: { gte: dateOnly(today) } }, orderBy: { date: 'asc' }, take: 20, select: { doctorId: true, date: true } }),
  ]);
  const name = (id: string) => doctors.find((d) => d.id === id)?.displayName ?? '';
  return {
    staff: staff.map((s) => {
      const a = attendance.find((x) => x.userId === s.id);
      return { ...s, status: !a ? 'NOT_IN' : a.checkOutAt ? 'OUT' : 'IN', checkInAt: a?.checkInAt ?? null, checkOutAt: a?.checkOutAt ?? null };
    }),
    doctors: doctors.map((d) => {
      const withPatient = inClinic.find((a) => a.doctorId === d.id && a.status === 'WITH_DOCTOR');
      return { id: d.id, name: d.displayName, busyWith: withPatient?.patient.name ?? null, waiting: inClinic.filter((a) => a.doctorId === d.id && (a.status === 'WAITING' || a.status === 'CHECKED_IN')).length };
    }),
    patients: inClinic.map((a) => ({ id: a.id, name: a.patient.name, status: a.status, doctor: a.doctorId ? name(a.doctorId) : null, startAt: a.startAt })),
    leaves: leaves.map((l) => ({ doctor: name(l.doctorId), date: dateOnlyStr(l.date) })),
  };
}

// ───────────── Treatment plans ─────────────

export async function openPlans(q?: string) {
  const text = q?.trim();
  const matching = text ? await prisma.patient.findMany({ where: { name: { contains: text } }, select: { id: true }, take: 100 }) : null;
  const plans = await prisma.treatmentPlan.findMany({ where: matching ? { patientId: { in: matching.map((p) => p.id) } } : {}, orderBy: { createdAt: 'desc' }, take: 200, select: { id: true, doctorId: true, patientId: true, currentVersionNo: true } });
  const [versions, patients] = await Promise.all([
    prisma.treatmentPlanVersion.findMany({ where: { OR: plans.map((p) => ({ planId: p.id, versionNo: p.currentVersionNo })) }, select: { planId: true, items: { where: { status: { in: ['PLANNED', 'SCHEDULED'] } }, orderBy: { scheduledStart: 'asc' }, select: { procedureName: true, sessionNumber: true, scheduledStart: true } } } }),
    prisma.patient.findMany({ where: { id: { in: plans.map((p) => p.patientId) } }, select: { id: true, name: true, phone: true } }),
  ]);
  const who = await nameMap(plans.map((p) => p.doctorId));
  const rows = plans.flatMap((p) => {
    const items = versions.find((v) => v.planId === p.id)?.items ?? [];
    return items.length ? [{ id: p.id, patient: patients.find((x) => x.id === p.patientId) ?? null, doctor: who(p.doctorId), nextSessions: items.slice(0, 3), remaining: items.length, nextAt: items[0]!.scheduledStart }] : [];
  });
  return { items: rows.sort((a, b) => a.nextAt.getTime() - b.nextAt.getTime()) };
}

// ───────────── Packages ─────────────

export const listPackageTypes = () => prisma.packageType.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }] });

export async function savePackageType(actor: Actor, input: { name: string; kind: PackageKind; sessions: number; pricePaisa: number; validDays?: number | null }) {
  return prisma.$transaction(async (tx) => {
    if (await tx.packageType.findUnique({ where: { name: input.name.trim() }, select: { id: true } })) throw new ConflictError('DUPLICATE_NAME', 'Is naam ka package pehle se hai.');
    const t = await tx.packageType.create({ data: { name: input.name.trim(), kind: input.kind, sessions: input.sessions, pricePaisa: BigInt(input.pricePaisa), validDays: input.validDays ?? null, createdById: actor.id! } });
    await audit(tx, actor, { action: 'PACKAGE_TYPE_ADDED', recordType: 'PackageType', recordId: t.id, after: t });
    return t;
  });
}

export async function sellPackage(actor: Actor, input: { typeId: string; patientId: string; payment?: PaymentInput }, key: string) {
  const type = await prisma.packageType.findFirst({ where: { id: input.typeId, active: true } });
  if (!type) throw new ValidationError('Package nahi mila.');
  // The sale is an ordinary invoice, so it reaches receipts, Cash Closing and reports without a second money path.
  const inv = (await createDirectInvoice(actor, { patientId: input.patientId, lines: [{ description: `Package: ${type.name} (${type.sessions} sessions)`, unitPricePaisa: Number(type.pricePaisa) }], applyTax: false, confirmOpenVisit: true, payment: input.payment }, `package:${key}`)) as { id: string };
  return prisma.$transaction(async (tx) => {
    const existing = await tx.packageSale.findUnique({ where: { invoiceId: inv.id } });
    if (existing) return existing;
    const expiresAt = type.validDays ? addMinutes(new Date(), type.validDays * 24 * 60) : null;
    const sale = await tx.packageSale.create({ data: { number: await number(tx, 'VH-PKG', 'package'), typeId: type.id, patientId: input.patientId, invoiceId: inv.id, name: type.name, sessions: type.sessions, pricePaisa: type.pricePaisa, expiresAt, soldById: actor.id! } });
    await audit(tx, actor, { action: 'PACKAGE_SOLD', recordType: 'PackageSale', recordId: sale.id, after: { number: sale.number, name: sale.name, price: sale.pricePaisa, invoiceId: inv.id } });
    return sale;
  });
}

export async function listPackageSales(q?: string) {
  const text = q?.trim();
  const patients = text ? await prisma.patient.findMany({ where: { name: { contains: text } }, select: { id: true }, take: 50 }) : null;
  const rows = await prisma.packageSale.findMany({ where: patients ? { patientId: { in: patients.map((p) => p.id) } } : {}, orderBy: { createdAt: 'desc' }, take: 100, include: { uses: { orderBy: { usedAt: 'desc' } } } });
  const owners = await prisma.patient.findMany({ where: { id: { in: rows.map((r) => r.patientId) } }, select: { id: true, name: true, phone: true } });
  return {
    items: rows.map((r) => ({ id: r.id, number: r.number, name: r.name, sessions: r.sessions, used: r.uses.length, left: r.sessions - r.uses.length, pricePaisa: r.pricePaisa, expiresAt: r.expiresAt, invoiceId: r.invoiceId, createdAt: r.createdAt, expired: !!r.expiresAt && r.expiresAt < new Date(), patient: owners.find((o) => o.id === r.patientId) ?? null, lastUsedAt: r.uses[0]?.usedAt ?? null })),
    runningCount: rows.filter((r) => r.uses.length < r.sessions).length,
  };
}

export async function usePackageSession(actor: Actor, saleId: string, note?: string) {
  return moneyTx(async (tx) => {
    await tx.$queryRaw`SELECT id FROM package_sales WHERE id = ${saleId} FOR UPDATE`;
    const s = await tx.packageSale.findUnique({ where: { id: saleId }, include: { uses: { select: { id: true } } } });
    if (!s) throw new NotFoundError('Package');
    if (s.expiresAt && s.expiresAt < new Date()) throw new ConflictError('PACKAGE_EXPIRED', 'Yeh package expire ho chuka hai.');
    if (s.uses.length >= s.sessions) throw new ConflictError('PACKAGE_FINISHED', 'Is package ke sessions khatam ho chuke hain.');
    const use = await tx.packageSessionUse.create({ data: { saleId, usedById: actor.id!, note: note?.trim() || null } });
    await audit(tx, actor, { action: 'PACKAGE_SESSION_USED', recordType: 'PackageSale', recordId: saleId, after: { used: s.uses.length + 1, of: s.sessions } });
    return use;
  });
}

// ───────────── Purchase orders ─────────────

export async function createPurchaseOrder(actor: Actor, input: { vendorId: string; lines: { itemId?: string; name?: string; quantity: number }[] }) {
  if (!input.lines.length) throw new ValidationError('Kam az kam ek item add karein.');
  if (!(await prisma.vendor.findUnique({ where: { id: input.vendorId }, select: { id: true } }))) throw new ValidationError('Vendor chunein.');
  const items = await prisma.stockItem.findMany({ where: { id: { in: input.lines.map((l) => l.itemId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  const lines = input.lines.map((l) => {
    const name = l.itemId ? items.find((i) => i.id === l.itemId)?.name : l.name?.trim();
    if (!name) throw new ValidationError('Item chunein ya naam likhein.');
    return { itemId: l.itemId ?? null, name, quantity: l.quantity };
  });
  return prisma.$transaction(async (tx) => {
    const po = await tx.purchaseOrder.create({ data: { number: await number(tx, 'VH-PO', 'purchase-order'), vendorId: input.vendorId, createdById: actor.id!, lines: { create: lines } }, include: { lines: true } });
    await audit(tx, actor, { action: 'PURCHASE_ORDER_CREATED', recordType: 'PurchaseOrder', recordId: po.id, after: { number: po.number, vendorId: po.vendorId, lines } });
    return po;
  });
}

export async function listPurchaseOrders() {
  const rows = await prisma.purchaseOrder.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { lines: true } });
  const vendors = await prisma.vendor.findMany({ where: { id: { in: rows.map((r) => r.vendorId) } }, select: { id: true, name: true, phone: true } });
  const who = await nameMap(rows.flatMap((r) => [r.createdById, r.decidedById]));
  const [allVendors, allItems] = await Promise.all([prisma.vendor.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }), prisma.stockItem.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 1000 })]);
  return { items: rows.map((r) => ({ ...r, vendor: vendors.find((v) => v.id === r.vendorId) ?? null, createdBy: who(r.createdById), decidedBy: who(r.decidedById) })), vendors: allVendors, stockItems: allItems };
}

export async function decidePurchaseOrder(actor: Actor, id: string, input: { action: 'RECEIVED' | 'CANCELLED'; vendorBillNo?: string; received?: { lineId: string; quantity: number }[] }) {
  return prisma.$transaction(async (tx) => {
    const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { lines: true } });
    if (!po) throw new NotFoundError('Purchase order');
    if (po.status !== 'OPEN') throw new ConflictError('ORDER_CLOSED', 'Yeh order band ho chuka hai.');
    if (input.action === 'RECEIVED') {
      if (!input.vendorBillNo?.trim()) throw new ValidationError('Vendor bill number likhein.');
      for (const r of input.received ?? []) {
        if (!po.lines.some((l) => l.id === r.lineId)) throw new ValidationError('Yeh item is order mein nahi.');
        await tx.purchaseOrderLine.update({ where: { id: r.lineId }, data: { receivedQty: r.quantity } });
      }
    }
    const after = await tx.purchaseOrder.update({ where: { id }, data: { status: input.action, vendorBillNo: input.vendorBillNo?.trim() || null, decidedById: actor.id, decidedAt: new Date() } });
    await audit(tx, actor, { action: `PURCHASE_ORDER_${input.action}`, recordType: 'PurchaseOrder', recordId: id, before: { status: po.status }, after: { status: after.status, vendorBillNo: after.vendorBillNo } });
    return after;
  });
}

// ───────────── Office purchases ─────────────

export async function requestOfficePurchase(actor: Actor, input: { items: { name: string; quantity: string; approxPaisa: number }[] }) {
  if (!input.items.length) throw new ValidationError('Kam az kam ek cheez add karein.');
  return prisma.$transaction(async (tx) => {
    const estimate = input.items.reduce((s, i) => s + BigInt(i.approxPaisa), 0n);
    const r = await tx.officePurchase.create({ data: { requestedById: actor.id!, items: input.items as unknown as Prisma.InputJsonValue, estimatePaisa: estimate } });
    await audit(tx, actor, { action: 'OFFICE_PURCHASE_REQUESTED', recordType: 'OfficePurchase', recordId: r.id, after: { items: input.items, estimate } });
    await notifyRoles(tx, ['MANAGER'], { type: 'OFFICE_PURCHASE', subject: `${actor.displayName}: office purchase request`, recordType: 'OfficePurchase', recordId: r.id, sender: actor });
    return r;
  });
}

export async function listOfficePurchases(actor: Actor) {
  const manage = actor.role === 'MANAGER' || (actor.role !== null && OWNERS.includes(actor.role)) || actor.role === 'RECEPTIONIST';
  const rows = await prisma.officePurchase.findMany({ where: manage ? {} : { requestedById: actor.id! }, orderBy: { createdAt: 'desc' }, take: 100 });
  const who = await nameMap(rows.flatMap((r) => [r.requestedById, r.decidedById, r.settledById]));
  return { items: rows.map((r) => ({ ...r, requestedBy: who(r.requestedById), decidedBy: who(r.decidedById), settledBy: who(r.settledById) })), managerLimitPaisa: await getSetting('office.purchaseManagerLimitPaisa') };
}

export async function decideOfficePurchase(actor: Actor, id: string, input: { action: 'APPROVE' | 'REJECT' | 'SEND_TO_OWNERS'; budgetPaisa?: number; cashFrom?: ExpenseSource; note?: string }) {
  return moneyTx(async (tx) => {
    await tx.$queryRaw`SELECT id FROM office_purchases WHERE id = ${id} FOR UPDATE`;
    const r = await tx.officePurchase.findUnique({ where: { id } });
    if (!r) throw new NotFoundError('Request');
    if (r.status !== 'PENDING' && r.status !== 'WITH_OWNERS') throw new ConflictError('ALREADY_DECIDED', 'Is request par faisla ho chuka hai.');
    if (r.requestedById === actor.id) throw new ForbiddenError({ recordType: 'OfficePurchase', recordId: id, rule: 'approver_not_requester' }, 'Aap ne khud yeh request ki hai; koi aur faisla karega.');
    const isOwner = actor.role !== null && OWNERS.includes(actor.role);
    if (r.status === 'WITH_OWNERS' && !isOwner) throw new ForbiddenError({ recordType: 'OfficePurchase', recordId: id, rule: 'owner_only' }, 'Yeh faisla sirf MD ya Hamza kar sakte hain.');
    if (input.action === 'SEND_TO_OWNERS') {
      const after = await tx.officePurchase.update({ where: { id }, data: { status: 'WITH_OWNERS' } });
      await audit(tx, actor, { action: 'OFFICE_PURCHASE_ESCALATED', recordType: 'OfficePurchase', recordId: id, before: { status: r.status }, after: { status: after.status } });
      await notifyRoles(tx, OWNERS, { type: 'OFFICE_PURCHASE', subject: 'Office purchase: aap ka faisla chahiye', recordType: 'OfficePurchase', recordId: id, sender: actor });
      return after;
    }
    if (input.action === 'REJECT') {
      if (!input.note?.trim()) throw new ValidationError('Reject ki wajah likhein.');
      const after = await tx.officePurchase.update({ where: { id }, data: { status: 'REJECTED', decidedById: actor.id, decidedAt: new Date(), decisionNote: input.note.trim() } });
      await audit(tx, actor, { action: 'OFFICE_PURCHASE_REJECTED', recordType: 'OfficePurchase', recordId: id, before: { status: r.status }, after: { status: after.status }, reason: input.note });
      await notifyUsers(tx, [r.requestedById], { type: 'OFFICE_PURCHASE_DECIDED', subject: 'Office purchase reject ho gayi', body: input.note, recordType: 'OfficePurchase', recordId: id, sender: actor });
      return after;
    }
    if (!input.budgetPaisa || input.budgetPaisa <= 0) throw new ValidationError('Budget likhein.');
    if (!isOwner && BigInt(input.budgetPaisa) > BigInt(await getSetting('office.purchaseManagerLimitPaisa', tx))) throw new ValidationError('Yeh aap ki had se zyada hai. MD aur Hamza ko bhejein.');
    const from = input.cashFrom ?? 'RECEPTION_DRAWER';
    const after = await tx.officePurchase.update({ where: { id }, data: { status: 'CASH_GIVEN', budgetPaisa: BigInt(input.budgetPaisa), cashFrom: from, decidedById: actor.id, decidedAt: new Date(), decisionNote: input.note?.trim() || null } });
    if (from === 'RECEPTION_DRAWER') await tx.ledgerEntry.create({ data: { account: 'CASH_IN_HAND', amountPaisa: -BigInt(input.budgetPaisa), refType: 'OfficePurchase', refId: id, memo: 'Office purchase: cash diya', actorId: actor.id! } });
    await audit(tx, actor, { action: 'OFFICE_PURCHASE_APPROVED', recordType: 'OfficePurchase', recordId: id, before: { status: r.status }, after: { status: after.status, budget: after.budgetPaisa, cashFrom: from } });
    await notifyUsers(tx, [r.requestedById], { type: 'OFFICE_PURCHASE_DECIDED', subject: 'Office purchase approve ho gayi', recordType: 'OfficePurchase', recordId: id, sender: actor });
    return after;
  });
}

/** Bill and change come back. What was spent becomes an expense, so Profit and Loss sees it. */
export async function settleOfficePurchase(actor: Actor, id: string, input: { billTotalPaisa: number; billAttachmentId?: string }) {
  return moneyTx(async (tx) => {
    await tx.$queryRaw`SELECT id FROM office_purchases WHERE id = ${id} FOR UPDATE`;
    const r = await tx.officePurchase.findUnique({ where: { id } });
    if (!r) throw new NotFoundError('Request');
    if (r.status !== 'CASH_GIVEN' || r.budgetPaisa === null) throw new ConflictError('NOT_CASH_GIVEN', 'Is request par cash nahi diya gaya.');
    const bill = BigInt(input.billTotalPaisa);
    const change = r.budgetPaisa - bill;
    const after = await tx.officePurchase.update({ where: { id }, data: { status: 'SETTLED', billTotalPaisa: bill, changePaisa: change, billAttachmentId: input.billAttachmentId ?? null, settledById: actor.id, settledAt: new Date() } });
    // The drawer already paid the whole budget; change back (or the extra spent) corrects it.
    if (r.cashFrom === 'RECEPTION_DRAWER' && change !== 0n) await tx.ledgerEntry.create({ data: { account: 'CASH_IN_HAND', amountPaisa: change, refType: 'OfficePurchase', refId: id, memo: change > 0n ? 'Office purchase: change wapas' : 'Office purchase: zyada kharcha', actorId: actor.id! } });
    await tx.expense.create({ data: { date: dateOnly(clinicDateStr(new Date())), category: 'Office purchases', description: `Office purchase ${id.slice(-6)}`, amountPaisa: bill, paidFrom: r.cashFrom ?? 'RECEPTION_DRAWER', createdById: actor.id! } });
    await audit(tx, actor, { action: 'OFFICE_PURCHASE_SETTLED', recordType: 'OfficePurchase', recordId: id, before: { status: r.status }, after: { status: after.status, bill, change } });
    return after;
  });
}

// ───────────── Chat ─────────────

const ROOMS: { id: string; name: string; roles: Role[] }[] = [
  { id: 'clinic', name: 'Clinic team', roles: ['RECEPTIONIST', 'DOCTOR', 'ASSISTANT', 'OFFICE_BOY', 'MANAGER'] },
  { id: 'desk', name: 'Reception and Manager', roles: ['RECEPTIONIST', 'MANAGER'] },
  { id: 'doctors', name: 'Doctors and Manager', roles: ['DOCTOR', 'MANAGER'] },
  { id: 'lead', name: 'Lead team', roles: ['LEAD_MEMBER', 'MANAGER'] },
  { id: 'marketing', name: 'Marketing', roles: ['MARKETING_LEAD', 'LEAD_MEMBER'] },
  { id: 'management', name: 'Management', roles: ['MANAGER'] },
];
/** MD and Hamza Zafar read every room. */
const roomsFor = (role: Role | null) => ROOMS.filter((r) => role !== null && (OWNERS.includes(role) || r.roles.includes(role)));

export const chatRooms = (actor: Actor) => ({ rooms: roomsFor(actor.role).map(({ id, name }) => ({ id, name })) });

function requireRoom(actor: Actor, room: string) {
  if (!roomsFor(actor.role).some((r) => r.id === room)) throw new ForbiddenError({ recordType: 'ChatRoom', recordId: room, rule: 'room_member' });
}

export async function chatMessages(actor: Actor, room: string) {
  requireRoom(actor, room);
  const rows = await prisma.chatMessage.findMany({ where: { room }, orderBy: { createdAt: 'desc' }, take: 100 });
  const who = await nameMap(rows.map((r) => r.senderId));
  return { items: rows.reverse().map((r) => ({ id: r.id, body: r.body, createdAt: r.createdAt, sender: who(r.senderId), mine: r.senderId === actor.id })) };
}

export async function sendChat(actor: Actor, room: string, body: string) {
  requireRoom(actor, room);
  const text = body.trim();
  if (!text) throw new ValidationError('Message likhein.');
  return prisma.chatMessage.create({ data: { room, senderId: actor.id!, body: text } });
}

// ───────────── Documents and saved reports ─────────────

export async function searchDocuments(q?: string) {
  const text = q?.trim();
  const contains = text ? { contains: text } : undefined;
  const [invoices, receipts, returns, purchaseOrders, packages, slips] = await Promise.all([
    prisma.invoice.findMany({ where: contains ? { number: contains } : {}, orderBy: { createdAt: 'desc' }, take: 25, select: { id: true, number: true, totalPaisa: true, status: true, createdAt: true } }),
    prisma.payment.findMany({ where: contains ? { receiptNo: contains } : {}, orderBy: { receivedAt: 'desc' }, take: 25, select: { id: true, receiptNo: true, amountPaisa: true, receivedAt: true } }),
    prisma.saleReturn.findMany({ where: contains ? { number: contains } : {}, orderBy: { createdAt: 'desc' }, take: 25, select: { id: true, number: true, refundPaisa: true, status: true, createdAt: true } }),
    prisma.purchaseOrder.findMany({ where: contains ? { number: contains } : {}, orderBy: { createdAt: 'desc' }, take: 25, select: { id: true, number: true, status: true, createdAt: true } }),
    prisma.packageSale.findMany({ where: contains ? { number: contains } : {}, orderBy: { createdAt: 'desc' }, take: 25, select: { id: true, number: true, pricePaisa: true, createdAt: true } }),
    prisma.salarySlip.count(),
  ]);
  void slips;
  const items = [
    ...invoices.map((x) => ({ id: x.id, kind: 'Invoice', number: x.number, amountPaisa: x.totalPaisa as bigint | null, status: x.status as string, date: x.createdAt })),
    ...receipts.map((x) => ({ id: x.id, kind: 'Receipt', number: x.receiptNo, amountPaisa: x.amountPaisa as bigint | null, status: 'Saved', date: x.receivedAt })),
    ...returns.map((x) => ({ id: x.id, kind: 'Sale return', number: x.number, amountPaisa: x.refundPaisa as bigint | null, status: x.status as string, date: x.createdAt })),
    ...purchaseOrders.map((x) => ({ id: x.id, kind: 'Purchase order', number: x.number, amountPaisa: null as bigint | null, status: x.status as string, date: x.createdAt })),
    ...packages.map((x) => ({ id: x.id, kind: 'Package', number: x.number, amountPaisa: x.pricePaisa as bigint | null, status: 'Sold', date: x.createdAt })),
  ].sort((a, b) => b.date.getTime() - a.date.getTime());
  const saved = await prisma.savedReport.findMany({ orderBy: { createdAt: 'desc' }, take: 60, select: { id: true, kind: true, date: true, title: true, createdAt: true } });
  return { items: items.slice(0, 100), saved: saved.map((s) => ({ ...s, date: dateOnlyStr(s.date) })) };
}

export async function savedReport(id: string) {
  const r = await prisma.savedReport.findUnique({ where: { id } });
  if (!r) throw new NotFoundError('Report');
  return { ...r, date: dateOnlyStr(r.date) };
}

// ───────────── Data check ─────────────

export async function dataCheck() {
  const problems: { check: string; record: string; detail: string }[] = [];
  const add = (check: string, record: string, detail: string) => problems.push({ check, record, detail });
  const invoices = await prisma.invoice.findMany({ where: { status: { not: 'VOID' } }, select: { id: true, number: true, totalPaisa: true, paidPaisa: true, balancePaisa: true, payments: { select: { amountPaisa: true } } } });
  for (const i of invoices) {
    const receipts = i.payments.reduce((s, p) => s + p.amountPaisa, 0n);
    if (receipts !== i.paidPaisa) add('Receipts do not match', i.number, `Paid ${i.paidPaisa}, receipts ${receipts}`);
    if (i.paidPaisa > i.totalPaisa) add('Paid more than the total', i.number, `Total ${i.totalPaisa}, paid ${i.paidPaisa}`);
    if (i.totalPaisa - i.paidPaisa !== i.balancePaisa && i.paidPaisa <= i.totalPaisa) add('Wrong balance', i.number, `Balance ${i.balancePaisa}, should be ${i.totalPaisa - i.paidPaisa}`);
  }
  const closedNoRx = await prisma.invoice.findMany({ where: { kind: 'VISIT', status: 'CLOSED', prescriptionAttachmentId: null, lines: { none: { stockItemId: { not: null } } } }, select: { number: true }, take: 50 });
  for (const i of closedNoRx) add('Missing proof', i.number, 'Closed with no prescription photo');
  const stock = await prisma.stockTransaction.groupBy({ by: ['itemId'], _sum: { quantity: true } });
  const negative = stock.filter((s) => (s._sum.quantity ?? 0) < 0);
  if (negative.length) {
    const items = await prisma.stockItem.findMany({ where: { id: { in: negative.map((n) => n.itemId) } }, select: { id: true, name: true } });
    for (const n of negative) add('Negative stock', items.find((i) => i.id === n.itemId)?.name ?? n.itemId, `Quantity ${n._sum.quantity}`);
  }
  const doubled = await prisma.$queryRaw<{ description: string; n: bigint }[]>`SELECT description, COUNT(*) AS n FROM expenses GROUP BY date, description, amountPaisa HAVING n > 1 LIMIT 50`;
  for (const d of doubled) add('Double entry', d.description, `${d.n} same expenses`);
  return { checkedInvoices: invoices.length, problems };
}

// ───────────── Standard kits ─────────────

export async function listKits() {
  const rows = await prisma.serviceKitItem.findMany();
  const [services, items] = await Promise.all([
    prisma.service.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.stockItem.findMany({ where: { active: true }, select: { id: true, name: true, baseUnit: true }, orderBy: { name: 'asc' }, take: 1000 }),
  ]);
  return { kits: rows.map((r) => ({ ...r, serviceName: services.find((s) => s.id === r.serviceId)?.name ?? '', itemName: items.find((i) => i.id === r.itemId)?.name ?? '' })), services, items };
}

export async function saveKitItem(actor: Actor, input: { serviceId: string; itemId: string; quantity: number }) {
  return prisma.$transaction(async (tx) => {
    const k = await tx.serviceKitItem.upsert({ where: { serviceId_itemId: { serviceId: input.serviceId, itemId: input.itemId } }, update: { quantity: input.quantity }, create: input });
    await audit(tx, actor, { action: 'SERVICE_KIT_SET', recordType: 'ServiceKitItem', recordId: k.id, after: input });
    return k;
  });
}

export async function removeKitItem(actor: Actor, id: string) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.serviceKitItem.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Kit item');
    await tx.serviceKitItem.delete({ where: { id } });
    await audit(tx, actor, { action: 'SERVICE_KIT_REMOVED', recordType: 'ServiceKitItem', recordId: id, before });
    return { ok: true };
  });
}

/** The kit for a procedure the Assistant is doing, matched on the procedure's name. Names and quantities, no cost. */
export async function kitForProcedure(procedureName: string) {
  const service = await prisma.service.findFirst({ where: { name: procedureName }, select: { id: true } });
  if (!service) return { items: [] };
  const rows = await prisma.serviceKitItem.findMany({ where: { serviceId: service.id } });
  const items = await prisma.stockItem.findMany({ where: { id: { in: rows.map((r) => r.itemId) }, active: true }, select: { id: true, name: true, baseUnit: true } });
  return { items: rows.flatMap((r) => {
    const item = items.find((i) => i.id === r.itemId);
    return item ? [{ itemId: item.id, name: item.name, unit: item.baseUnit, quantity: r.quantity }] : [];
  }) };
}

// ───────────── Room held for a video shoot ─────────────

export async function listRoomHolds() {
  const rows = await prisma.roomReservation.findMany({ where: { purpose: { not: null }, status: 'ACTIVE', endAt: { gte: new Date() } }, orderBy: { startAt: 'asc' }, include: { room: { select: { code: true } } } });
  const rooms = await prisma.room.findMany({ where: { active: true }, select: { id: true, code: true }, orderBy: { sortOrder: 'asc' } });
  return { items: rows.map((r) => ({ id: r.id, room: r.room.code, purpose: r.purpose, startAt: r.startAt, endAt: r.endAt })), rooms };
}

export async function holdRoom(actor: Actor, input: { roomId: string; startAt: string; minutes: number; purpose: string }) {
  const start = new Date(input.startAt);
  if (Number.isNaN(start.getTime()) || start < new Date()) throw new ValidationError('Aane wala waqt chunein.');
  const end = addMinutes(start, input.minutes);
  return prisma.$transaction(async (tx) => {
    const clash = await tx.roomReservation.findFirst({ where: { roomId: input.roomId, status: { in: ['ACTIVE', 'AWAITING_CLEAN'] }, startAt: { lt: end }, endAt: { gt: start } }, select: { id: true } });
    if (clash) throw new ConflictError('ROOM_BUSY', 'Yeh room us waqt busy hai.');
    const r = await tx.roomReservation.create({ data: { roomId: input.roomId, startAt: start, endAt: end, purpose: input.purpose.trim() } });
    await audit(tx, actor, { action: 'ROOM_HELD', recordType: 'RoomReservation', recordId: r.id, after: { roomId: r.roomId, startAt: r.startAt, endAt: r.endAt, purpose: r.purpose } });
    return r;
  });
}

export async function releaseRoomHold(actor: Actor, id: string) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.roomReservation.findUnique({ where: { id } });
    if (!r || !r.purpose) throw new NotFoundError('Room hold');
    const after = await tx.roomReservation.update({ where: { id }, data: { status: 'CANCELLED', releasedAt: new Date() } });
    await audit(tx, actor, { action: 'ROOM_HOLD_CANCELLED', recordType: 'RoomReservation', recordId: id, before: { status: r.status }, after: { status: after.status } });
    return after;
  });
}

// ───────────── Campaign performance ─────────────

export async function campaignPerformance(month: string) {
  const { start, end } = monthBounds(month);
  const sheets = await prisma.metaSheet.findMany({ where: { deletedAt: null }, select: { id: true, campaign: true } });
  const campaigns = [...new Set(sheets.map((s) => s.campaign))];
  const [spends, leads] = await Promise.all([
    prisma.campaignSpend.findMany({ where: { month } }),
    prisma.lead.findMany({ where: { sheetId: { in: sheets.map((s) => s.id) }, createdAt: { gte: start, lt: end } }, select: { sheetId: true, phone: true, status: true } }),
  ]);
  const patients = await prisma.patient.findMany({ where: { phone: { in: leads.map((l) => l.phone).filter((p): p is string => !!p) } }, select: { id: true, phone: true } });
  const invoices = await prisma.invoice.groupBy({ by: ['patientId'], where: { patientId: { in: patients.map((p) => p.id) }, status: { not: 'VOID' } }, _sum: { totalPaisa: true } });
  return {
    month,
    items: campaigns.map((campaign) => {
      const mine = leads.filter((l) => sheets.find((s) => s.id === l.sheetId)?.campaign === campaign);
      const spend = spends.find((s) => s.campaign === campaign)?.spendPaisa ?? 0n;
      const revenue = invoices.reduce((sum, i) => {
        const phone = patients.find((p) => p.id === i.patientId)?.phone;
        return mine.some((l) => l.phone === phone) ? sum + (i._sum.totalPaisa ?? 0n) : sum;
      }, 0n);
      return { campaign, spendPaisa: spend, leads: mine.length, booked: mine.filter((l) => l.status === 'BOOKED').length, costPerLeadPaisa: mine.length ? spend / BigInt(mine.length) : 0n, revenuePaisa: revenue, returnBp: spend > 0n ? Number((revenue * 10_000n) / spend) : null };
    }),
  };
}

export async function setCampaignSpend(actor: Actor, input: { campaign: string; month: string; spendPaisa: number }) {
  return prisma.$transaction(async (tx) => {
    const key = { campaign_month: { campaign: input.campaign, month: input.month } };
    const before = await tx.campaignSpend.findUnique({ where: key });
    const after = await tx.campaignSpend.upsert({ where: key, update: { spendPaisa: BigInt(input.spendPaisa), updatedById: actor.id! }, create: { campaign: input.campaign, month: input.month, spendPaisa: BigInt(input.spendPaisa), updatedById: actor.id! } });
    await audit(tx, actor, { action: 'CAMPAIGN_SPEND_SET', recordType: 'CampaignSpend', recordId: after.id, before, after });
    return after;
  });
}
