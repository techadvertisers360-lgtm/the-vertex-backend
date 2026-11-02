import type { MoneyMethod } from '../../lib/paymentMethods';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors';
import { audit, type Actor } from '../../services/audit';
import { enqueueMessage } from '../../services/messaging';
import { notifyRoles, notifyUsers } from '../../services/notifications';
import { getSetting } from '../../services/settings';
import { payVendor } from '../inventory/purchasing';
import { monthBounds } from './finance';

/** The rest of the client's demo (D-090). Anything that would change live work is off until it is set. */

// ───────────── Vendor payment requests ─────────────

export async function listVendorPayments() {
  const rows = await prisma.vendorPaymentRequest.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  const [vendors, users, banks] = await Promise.all([
    prisma.vendor.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.user.findMany({ where: { id: { in: rows.flatMap((r) => [r.requestedById, r.decidedById].filter((x): x is string => !!x)) } }, select: { id: true, displayName: true } }),
    prisma.bankAccount.findMany({ where: { active: true }, select: { id: true, name: true } }),
  ]);
  const who = (id: string | null) => users.find((u) => u.id === id)?.displayName ?? null;
  return { items: rows.map((r) => ({ ...r, vendor: vendors.find((v) => v.id === r.vendorId)?.name ?? null, requestedBy: who(r.requestedById), decidedBy: who(r.decidedById) })), vendors, banks };
}

export async function requestVendorPayment(actor: Actor, input: { vendorId: string; amountPaisa: number; note: string }) {
  const note = input.note.trim();
  if (note.length < 3) throw new ValidationError('Kis cheez ki payment hai, likhein.');
  return prisma.$transaction(async (tx) => {
    if (!(await tx.vendor.findUnique({ where: { id: input.vendorId }, select: { id: true } }))) throw new ValidationError('Vendor chunein.');
    if (await tx.vendorPaymentRequest.findFirst({ where: { vendorId: input.vendorId, amountPaisa: BigInt(input.amountPaisa), status: 'PENDING' }, select: { id: true } })) throw new ConflictError('REQUEST_WAITING', 'Is vendor aur amount ki request pehle se pending hai.');
    const r = await tx.vendorPaymentRequest.create({ data: { vendorId: input.vendorId, amountPaisa: BigInt(input.amountPaisa), note, requestedById: actor.id! } });
    await audit(tx, actor, { action: 'VENDOR_PAYMENT_REQUESTED', recordType: 'VendorPaymentRequest', recordId: r.id, after: { vendorId: r.vendorId, amount: r.amountPaisa }, reason: note });
    await notifyRoles(tx, ['MD', 'MARKETING_DIRECTOR'], { type: 'VENDOR_PAYMENT', subject: 'Vendor payment: aap ka faisla chahiye', body: note, recordType: 'VendorPaymentRequest', recordId: r.id, sender: actor });
    return r;
  });
}

export async function decideVendorPayment(actor: Actor, id: string, input: { approve: boolean; note?: string }) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.vendorPaymentRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundError('Request');
    if (r.status !== 'PENDING') throw new ConflictError('ALREADY_DECIDED', 'Is request par faisla ho chuka hai.');
    if (r.requestedById === actor.id) throw new ForbiddenError({ recordType: 'VendorPaymentRequest', recordId: id, rule: 'approver_not_requester' }, 'Aap ne khud yeh request ki hai; koi aur faisla karega.');
    if (!input.approve && !input.note?.trim()) throw new ValidationError('Reject ki wajah likhein.');
    const after = await tx.vendorPaymentRequest.update({ where: { id }, data: { status: input.approve ? 'APPROVED' : 'REJECTED', decidedById: actor.id, decidedAt: new Date(), decisionNote: input.note?.trim() || null } });
    await audit(tx, actor, { action: input.approve ? 'VENDOR_PAYMENT_APPROVED' : 'VENDOR_PAYMENT_REJECTED', recordType: 'VendorPaymentRequest', recordId: id, before: { status: r.status }, after: { status: after.status }, reason: input.note });
    await notifyUsers(tx, [r.requestedById], { type: 'VENDOR_PAYMENT_DECIDED', subject: input.approve ? 'Vendor payment approve ho gayi' : 'Vendor payment reject ho gayi', body: input.note, recordType: 'VendorPaymentRequest', recordId: id, sender: actor });
    return after;
  });
}

/** Pays the vendor through the normal path, once: the supplier payment key is fixed to this request. */
export async function recordVendorPayment(actor: Actor, id: string, input: { method: MoneyMethod; reference?: string; bankAccountId?: string }) {
  const r = await prisma.vendorPaymentRequest.findUnique({ where: { id } });
  if (!r) throw new NotFoundError('Request');
  if (r.status !== 'APPROVED') throw new ConflictError('NOT_APPROVED', 'Pehle approval chahiye.');
  if (r.supplierPaymentId) throw new ConflictError('ALREADY_PAID', 'Yeh payment ho chuki hai.');
  const { payment } = await payVendor(actor, r.vendorId, { amountPaisa: Number(r.amountPaisa), method: input.method, reference: input.reference, bankAccountId: input.bankAccountId, note: r.note }, `vendor-request:${id}`);
  return prisma.vendorPaymentRequest.update({ where: { id }, data: { supplierPaymentId: payment.id } });
}

/** With the setting on, money reaches a vendor only through an approved request (client demo). */
export async function directVendorPaymentAllowed() {
  if (await getSetting('vendor.requirePaymentApproval')) throw new ConflictError('APPROVAL_REQUIRED', 'Vendor payment ke liye pehle request approve karwayein (Requests & Returns).');
}

// ───────────── Messages: payment request, login ─────────────

export async function sendPaymentMessage(actor: Actor, invoiceId: string) {
  return prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.findUnique({ where: { id: invoiceId }, select: { id: true, number: true, balancePaisa: true, status: true, patient: { select: { id: true, name: true, phone: true, whatsappConsent: true } } } });
    if (!inv) throw new NotFoundError('Invoice');
    if (inv.status === 'VOID') throw new ConflictError('INVOICE_CANCELLED', 'Yeh invoice cancel ho chuki hai.');
    if (inv.balancePaisa <= 0n) throw new ValidationError('Is invoice par koi balance nahi.');
    if (!inv.patient) throw new ValidationError('Is invoice par patient nahi.');
    if (!inv.patient.whatsappConsent) throw new ConflictError('NO_WHATSAPP_CONSENT', 'Patient ne WhatsApp ki ijazat nahi di.');
    const base = await getSetting('payment.linkBaseUrl', tx);
    const banks = await tx.bankAccount.findMany({ where: { active: true }, select: { name: true, bankName: true, accountNo: true }, take: 2 });
    const m = await enqueueMessage(tx, {
      template: 'payment_request',
      toPhone: inv.patient.phone,
      patientId: inv.patient.id,
      payload: { patientName: inv.patient.name, amountPaisa: Number(inv.balancePaisa), invoiceNumber: inv.number, link: base ? `${base.replace(/\/+$/, '')}/${inv.number}` : '', bank: banks.map((b) => `${b.bankName} ${b.accountNo} (${b.name})`).join(', ') },
      relatedType: 'Invoice',
      relatedId: inv.id,
      idempotencyKey: `invoice:${inv.id}:payment-request:${inv.balancePaisa}:${new Date().toISOString().slice(0, 13)}`,
      createdById: actor.id,
    });
    await audit(tx, actor, { action: 'PAYMENT_MESSAGE_SENT', recordType: 'Invoice', recordId: inv.id, after: { number: inv.number, balance: inv.balancePaisa } });
    return { queued: true, messageId: m.id };
  });
}

/** Sign-in details on the staff member's phone. Never the password: it is stored hashed, and is given in person. */
export async function sendLoginMessage(actor: Actor, userId: string) {
  return prisma.$transaction(async (tx) => {
    const u = await tx.user.findUnique({ where: { id: userId }, select: { id: true, displayName: true, phone: true, email: true, memberCode: true } });
    if (!u) throw new NotFoundError('Staff');
    if (!u.phone) throw new ValidationError('Is staff ka phone number nahi.');
    const m = await enqueueMessage(tx, {
      template: 'staff_login',
      toPhone: u.phone,
      recipientUserId: u.id,
      payload: { name: u.displayName, login: u.email ?? u.memberCode ?? u.phone, url: env.PUBLIC_APP_URL ?? '' },
      relatedType: 'User',
      relatedId: u.id,
      idempotencyKey: `user:${u.id}:login:${new Date().toISOString().slice(0, 13)}`,
      createdById: actor.id,
    });
    await audit(tx, actor, { action: 'LOGIN_MESSAGE_SENT', recordType: 'User', recordId: u.id });
    return { queued: true, messageId: m.id };
  });
}

// ───────────── Lowest price, departments ─────────────

export const listProducts = async () => ({ items: await prisma.stockItem.findMany({ where: { kind: 'PHARMACY', active: true }, select: { id: true, name: true, salePricePaisa: true, floorPricePaisa: true }, orderBy: { name: 'asc' }, take: 1000 }) });

export async function setFloorPrice(actor: Actor, id: string, floorPaisa: number | null) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.stockItem.findUnique({ where: { id }, select: { id: true, kind: true, salePricePaisa: true, floorPricePaisa: true } });
    if (!before || before.kind !== 'PHARMACY') throw new NotFoundError('Product');
    if (floorPaisa !== null && (floorPaisa <= 0 || (before.salePricePaisa !== null && BigInt(floorPaisa) > before.salePricePaisa))) throw new ValidationError('Lowest price 0 se zyada aur list price se kam ya barabar ho.');
    const after = await tx.stockItem.update({ where: { id }, data: { floorPricePaisa: floorPaisa === null ? null : BigInt(floorPaisa) }, select: { id: true, floorPricePaisa: true } });
    await audit(tx, actor, { action: 'PRODUCT_FLOOR_PRICE_SET', recordType: 'StockItem', recordId: id, before: { floor: before.floorPricePaisa }, after: { floor: after.floorPricePaisa } });
    return after;
  });
}

export async function listDepartments() {
  const [doctors, services] = await Promise.all([
    prisma.user.findMany({ where: { role: 'DOCTOR', active: true }, select: { id: true, displayName: true, doctorProfile: { select: { departments: true } } }, orderBy: { displayName: 'asc' } }),
    prisma.service.findMany({ where: { active: true }, select: { id: true, name: true, department: true }, orderBy: { name: 'asc' } }),
  ]);
  return { doctors: doctors.map((d) => ({ id: d.id, name: d.displayName, departments: (d.doctorProfile?.departments as string[] | null) ?? [] })), services };
}

export async function setDoctorDepartments(actor: Actor, doctorId: string, departments: string[]) {
  const clean = [...new Set(departments.map((d) => d.trim()).filter(Boolean))];
  return prisma.$transaction(async (tx) => {
    const doctor = await tx.user.findFirst({ where: { id: doctorId, role: 'DOCTOR' }, select: { id: true } });
    if (!doctor) throw new NotFoundError('Doctor');
    const after = await tx.doctorProfile.upsert({ where: { userId: doctorId }, create: { userId: doctorId, departments: clean }, update: { departments: clean } });
    await audit(tx, actor, { action: 'DOCTOR_DEPARTMENTS_SET', recordType: 'DoctorProfile', recordId: doctorId, after: { departments: clean } });
    return after;
  });
}

export async function setServiceDepartment(actor: Actor, serviceId: string, department: string | null) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.service.findUnique({ where: { id: serviceId }, select: { department: true } });
    if (!before) throw new NotFoundError('Service');
    const after = await tx.service.update({ where: { id: serviceId }, data: { department: department?.trim() || null }, select: { id: true, department: true } });
    await audit(tx, actor, { action: 'SERVICE_DEPARTMENT_SET', recordType: 'Service', recordId: serviceId, before, after });
    return after;
  });
}

// ───────────── Patient feedback by person ─────────────

export async function feedbackReport(month: string) {
  const { start, end } = monthBounds(month);
  const rows = await prisma.feedback.findMany({ where: { submittedAt: { gte: start, lt: end } }, select: { appointmentId: true, doctorRating: true, staffRating: true, clinicRating: true, receptionRating: true, managerRating: true, suggestion: true, submittedAt: true } });
  const visits = await prisma.appointment.findMany({ where: { id: { in: rows.map((r) => r.appointmentId) } }, select: { id: true, doctorId: true } });
  const doctors = await prisma.user.findMany({ where: { id: { in: visits.map((v) => v.doctorId).filter((x): x is string => !!x) } }, select: { id: true, displayName: true } });
  const avg = (list: (number | null)[]) => {
    const got = list.filter((x): x is number => x !== null);
    return got.length ? { count: got.length, averageX10: Math.round((got.reduce((s, x) => s + x, 0) * 10) / got.length) } : { count: 0, averageX10: null };
  };
  const byPerson = doctors.map((d) => ({ name: d.displayName, ...avg(rows.filter((r) => visits.find((v) => v.id === r.appointmentId)?.doctorId === d.id).map((r) => r.doctorRating)) }));
  return {
    month,
    responses: rows.length,
    byPerson,
    overall: [
      { name: 'Staff', ...avg(rows.map((r) => r.staffRating)) },
      { name: 'Clinic', ...avg(rows.map((r) => r.clinicRating)) },
      { name: 'Reception', ...avg(rows.map((r) => r.receptionRating)) },
      { name: 'Manager', ...avg(rows.map((r) => r.managerRating)) },
    ],
    comments: rows.filter((r) => r.suggestion).slice(0, 50).map((r) => ({ text: r.suggestion!, at: r.submittedAt })),
  };
}
