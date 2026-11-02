import type { Prisma, Role } from '@prisma/client';
import { moneyTx, prisma, type Tx } from '../../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { phoneSearchFragment } from '../../lib/phone';
import { addDaysStr, clinicDateStr, clinicDayBounds, dateOnly, dateOnlyStr, local } from '../../lib/time';
import { hasPermission } from '../../auth/permissions';
import { audit, type Actor } from '../../services/audit';
import {
  addMoneyPayment,
  advanceBalance,
  applyAdvance,
  assertNotCancelled,
  creditAdvanceFromCancel,
  moneyDetailsFromMode,
  moveInvoiceBalance,
  paymentReceiptNumber,
  receiveAdvance,
  refundAdvance, fileSlip } from '../../services/invoicePayments';
import { publish, roleRoom } from '../../services/realtime';
import { getSetting } from '../../services/settings';
import { journeyChanged } from '../../services/tracker';
import { invoiceTotals, splitPayment } from './money';
import { invoiceNumber } from '../reception/service';

/**
 * The Invoice module (D-084): the list, direct invoices, later payments, advances and cancellation. Visit invoices and
 * counter sales are still created by their own flows; this module reads them all and adds to them. Totals are always
 * computed here. Invoices are never deleted, and money already received is undone by new reversal rows.
 */

export const INVOICE_ROLES: Role[] = ['RECEPTIONIST', 'MANAGER', 'MD'];

const OPEN_VISIT_STATUSES = ['CONFIRMED', 'CHECKED_IN', 'WAITING', 'WITH_DOCTOR', 'RECEPTION', 'PROCEDURE'] as const;
const FINISHED_VISIT_STATUSES = ['DONE', 'CANCELLED', 'RESCHEDULED'];

async function invoicesChanged(tx: Tx, invoiceId: string) {
  await publish(tx, INVOICE_ROLES.map(roleRoom), 'invoices:changed', { invoiceId });
}

async function lockInvoice(tx: Tx, invoiceId: string) {
  await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoiceId} FOR UPDATE`;
  const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
  if (!inv) throw new NotFoundError('Invoice');
  return inv;
}

/** A visit's bill changed: refresh its tracker cards. Direct invoices and counter sales have no visit. */
async function visitChanged(tx: Tx, appointmentId: string | null) {
  if (!appointmentId) return;
  const appt = await tx.appointment.findUniqueOrThrow({ where: { id: appointmentId }, select: { id: true, doctorId: true, status: true } });
  await journeyChanged(tx, appt);
}

// ───────────── List ─────────────

export interface InvoiceFilters {
  from?: string;
  to?: string;
  doctorId?: string;
  q?: string;
}

/**
 * The list defaults to the last 30 days. A search with no dates looks through every invoice, so an old invoice can
 * still be found by its number or the patient's phone.
 */
export function effectiveRange(f: InvoiceFilters): { from?: string; to?: string } {
  if (f.from || f.to) return { from: f.from, to: f.to };
  if (f.q?.trim()) return {};
  const today = clinicDateStr(new Date());
  return { from: addDaysStr(today, -29), to: today };
}

function whereOf(f: InvoiceFilters): Prisma.InvoiceWhereInput {
  const { from, to } = effectiveRange(f);
  if (from && to && from > to) throw new ValidationError('From date, To se pehle ho.');
  const where: Prisma.InvoiceWhereInput = {};
  if (from || to) where.invoiceDate = { ...(from ? { gte: dateOnly(from) } : {}), ...(to ? { lte: dateOnly(to) } : {}) };
  if (f.doctorId) where.doctorId = f.doctorId;
  const term = f.q?.trim();
  if (term) {
    const phone = phoneSearchFragment(term);
    where.OR = [
      { number: { contains: term } },
      { buyerName: { contains: term } },
      { patient: { is: { name: { contains: term } } } },
      ...(phone ? [{ buyerPhone: { contains: phone } }, { patient: { is: { phone: { contains: phone } } } }] : []),
    ];
  }
  return where;
}

const listSelect = {
  id: true,
  number: true,
  kind: true,
  status: true,
  invoiceDate: true,
  buyerName: true,
  buyerPhone: true,
  subtotalPaisa: true,
  discountPaisa: true,
  taxPaisa: true,
  taxRateBp: true,
  totalPaisa: true,
  paidPaisa: true,
  balancePaisa: true,
  cancelReason: true,
  cancelledAt: true,
  patient: { select: { id: true, name: true, phone: true } },
  doctor: { select: { id: true, displayName: true } },
  lines: { select: { id: true, description: true, reversesLineId: true }, orderBy: { createdAt: 'asc' as const } },
} satisfies Prisma.InvoiceSelect;

type ListRow = Prisma.InvoiceGetPayload<{ select: typeof listSelect }>;

/** Services as billed: a pharmacy line cancelled by a reversal line is left out, and so is the reversal line itself. */
function billedServices(lines: ListRow['lines']): string[] {
  const reversed = new Set(lines.map((l) => l.reversesLineId).filter(Boolean));
  return lines.filter((l) => !l.reversesLineId && !reversed.has(l.id)).map((l) => l.description);
}

function listRow(r: ListRow, role: Role) {
  const seeDiscount = hasPermission(role, 'invoice:view_discount');
  return {
    id: r.id,
    number: r.number,
    kind: r.kind,
    status: r.status,
    cancelled: r.status === 'VOID',
    cancelReason: r.cancelReason,
    cancelledAt: r.cancelledAt,
    date: dateOnlyStr(r.invoiceDate),
    patient: r.patient,
    buyerName: r.buyerName,
    buyerPhone: r.buyerPhone,
    doctor: r.doctor ? { id: r.doctor.id, name: r.doctor.displayName } : null,
    services: billedServices(r.lines),
    subtotalPaisa: r.subtotalPaisa,
    ...(seeDiscount ? { discountPaisa: r.discountPaisa } : {}),
    /** null means no tax: shown as "N/A". */
    taxPaisa: r.taxRateBp === null ? null : r.taxPaisa,
    taxRateBp: r.taxRateBp,
    totalPaisa: r.totalPaisa,
    paidPaisa: r.paidPaisa,
    balancePaisa: r.balancePaisa,
  };
}

/** Invoice counts for the cards. Cancelled invoices stay in the list but are not counted as bills. */
async function cardCounts() {
  const now = new Date();
  const today = clinicDateStr(now);
  const weekStart = local(now).startOf('week').toISODate()!; // Monday
  const rows = await prisma.$queryRaw<{ total: unknown; today: unknown; week: unknown }[]>`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(invoiceDate = ${today}), 0) AS today,
           COALESCE(SUM(invoiceDate >= ${weekStart} AND invoiceDate <= ${today}), 0) AS week
    FROM invoices WHERE status <> 'VOID'`;
  const r = rows[0]!;
  return { totalInvoices: Number(r.total), todayInvoices: Number(r.today), weekInvoices: Number(r.week) };
}

export async function listInvoices(role: Role, f: InvoiceFilters & { page: number; pageSize: number }) {
  const where = whereOf(f);
  const seeTotals = hasPermission(role, 'invoice:totals');
  const [rows, total, cards, totals] = await Promise.all([
    prisma.invoice.findMany({ where, select: listSelect, orderBy: [{ invoiceDate: 'desc' }, { createdAt: 'desc' }], skip: (f.page - 1) * f.pageSize, take: f.pageSize }),
    prisma.invoice.count({ where }),
    cardCounts(),
    seeTotals
      ? prisma.invoice.aggregate({ where: { AND: [where, { status: { not: 'VOID' } }] }, _sum: { subtotalPaisa: true, discountPaisa: true, taxPaisa: true, totalPaisa: true, paidPaisa: true, balancePaisa: true } })
      : null,
  ]);
  const range = effectiveRange(f);
  return {
    items: rows.map((r) => listRow(r, role)),
    page: f.page,
    pageSize: f.pageSize,
    total,
    from: range.from ?? null,
    to: range.to ?? null,
    cards,
    ...(totals
      ? {
          /** Rupee totals of the filtered rows, leaving out cancelled invoices. Manager / MD only. */
          totals: {
            subtotalPaisa: totals._sum.subtotalPaisa ?? 0n,
            ...(hasPermission(role, 'invoice:view_discount') ? { discountPaisa: totals._sum.discountPaisa ?? 0n } : {}),
            taxPaisa: totals._sum.taxPaisa ?? 0n,
            totalPaisa: totals._sum.totalPaisa ?? 0n,
            paidPaisa: totals._sum.paidPaisa ?? 0n,
            balancePaisa: totals._sum.balancePaisa ?? 0n,
          },
        }
      : {}),
  };
}

/** Rows for an export: the same filters as the list, without paging. */
export async function exportRows(role: Role, f: InvoiceFilters, maxRows: number) {
  const where = whereOf(f);
  const count = await prisma.invoice.count({ where });
  if (count > maxRows) throw new ValidationError(`${count} invoices hain, ek file mein ${maxRows} tak. Date range chhota karein.`);
  const rows = await prisma.invoice.findMany({ where, select: listSelect, orderBy: [{ invoiceDate: 'desc' }, { createdAt: 'desc' }] });
  return rows.map((r) => listRow(r, role));
}

// ───────────── Form data ─────────────

export async function formOptions() {
  const [doctors, modes, categories, services, banks, taxEnabled, taxRateBp] = await Promise.all([
    prisma.user.findMany({ where: { role: 'DOCTOR', active: true }, select: { id: true, displayName: true }, orderBy: { displayName: 'asc' } }),
    prisma.paymentMode.findMany({ where: { active: true }, select: { id: true, name: true, method: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    prisma.invoiceCategory.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    prisma.service.findMany({ where: { active: true }, select: { id: true, name: true, invoiceCategoryId: true, defaultPricePaisa: true }, orderBy: { name: 'asc' } }),
    prisma.bankAccount.findMany({ where: { active: true }, select: { id: true, name: true, bankName: true } }),
    getSetting('invoice.taxEnabled'),
    getSetting('invoice.taxBasisPoints'),
  ]);
  const nonCashRateBp = await getSetting('invoice.taxCardBasisPoints');
  return { doctors: doctors.map((d) => ({ id: d.id, name: d.displayName })), paymentModes: modes, categories, services, bankAccounts: banks, tax: { enabled: taxEnabled, rateBp: taxRateBp, nonCashRateBp }, requireSlip: await getSetting('payment.requireSlip') };
}

async function openVisitsToday(db: Tx | typeof prisma, patientId: string) {
  const b = clinicDayBounds(clinicDateStr(new Date()));
  return db.appointment.findMany({ where: { patientId, startAt: { gte: b.start, lt: b.end }, status: { in: [...OPEN_VISIT_STATUSES] } }, select: { id: true, startAt: true, status: true, type: true } });
}

/** What the form shows after a patient is picked: advance to use, a visit already open today, and balances owed. */
export async function patientContext(patientId: string) {
  const patient = await prisma.patient.findUnique({ where: { id: patientId }, select: { id: true, name: true, phone: true, mergedIntoId: true } });
  if (!patient) throw new NotFoundError('Patient');
  const [advance, openVisits, owed] = await Promise.all([
    advanceBalance(prisma, patientId),
    openVisitsToday(prisma, patientId),
    prisma.invoice.findMany({ where: { patientId, balancePaisa: { gt: 0n }, status: { not: 'VOID' } }, select: { id: true, number: true, balancePaisa: true, invoiceDate: true } }),
  ]);
  return { patient, advanceBalancePaisa: advance, openVisitsToday: openVisits, unpaidInvoices: owed.map((i) => ({ ...i, invoiceDate: dateOnlyStr(i.invoiceDate) })) };
}

// ───────────── Direct invoice ─────────────

export interface PaymentInput {
  amountPaisa: number;
  paymentModeId: string;
  reference?: string;
  bankAccountId?: string;
  /** The patient confirmed that anything above the balance is kept as an advance. */
  extraToAdvance?: boolean;
  slipAttachmentId?: string;
}

export interface DirectInvoiceInput {
  patientId: string;
  doctorId?: string | null;
  date?: string;
  lines: { serviceId?: string; description?: string; unitPricePaisa: number; quantity?: number }[];
  discountPaisa?: number;
  /** Tax applies when it is on in Settings, unless the desk turns it off for this invoice. */
  applyTax?: boolean;
  useAdvancePaisa?: number;
  payment?: PaymentInput;
  /** Reception saw the warning that this patient has a visit open today, which is billed through the visit. */
  confirmOpenVisit?: boolean;
}

export async function createDirectInvoice(actor: Actor, input: DirectInvoiceInput, idempotencyKey: string) {
  const today = clinicDateStr(new Date());
  const date = input.date ?? today;
  if (date > today) throw new ValidationError('Invoice ki date aane wale din ki nahi ho sakti.');
  const key = `direct:${idempotencyKey}`;

  const invoiceId = await moneyTx(async (tx) => {
    const replay = await tx.invoice.findUnique({ where: { idempotencyKey: key }, select: { id: true } });
    if (replay) return replay.id;

    const patient = await tx.patient.findUnique({ where: { id: input.patientId }, select: { id: true, mergedIntoId: true } });
    if (!patient) throw new NotFoundError('Patient');
    if (patient.mergedIntoId) throw new ConflictError('PATIENT_MERGED', 'Yeh record doosre patient mein merge ho chuka hai.');
    if (input.doctorId && !(await tx.user.findFirst({ where: { id: input.doctorId, role: 'DOCTOR', active: true }, select: { id: true } }))) throw new ValidationError('Doctor nahi mila.');
    if (!input.confirmOpenVisit) {
      const open = await openVisitsToday(tx, patient.id);
      if (open.length) throw new ConflictError('OPEN_VISIT', 'Is patient ki aaj visit khuli hai. Visit ka bill Billing se banta hai. Phir bhi alag invoice banani hai to tasdeeq karein.', { visits: open });
    }

    const serviceIds = input.lines.map((l) => l.serviceId).filter((x): x is string => !!x);
    const services = serviceIds.length ? await tx.service.findMany({ where: { id: { in: serviceIds } }, select: { id: true, name: true } }) : [];
    const lines = input.lines.map((l) => {
      const service = l.serviceId ? services.find((s) => s.id === l.serviceId) : undefined;
      if (l.serviceId && !service) throw new ValidationError('Service nahi mili.');
      const description = l.description?.trim() || service?.name;
      if (!description) throw new ValidationError('Service ka naam likhein.');
      return { serviceId: l.serviceId ?? null, description, unitPricePaisa: BigInt(l.unitPricePaisa), quantity: l.quantity ?? 1 };
    });

    const taxOn = input.applyTax !== false && (await getSetting('invoice.taxEnabled', tx));
    let rate: number | null = taxOn ? await getSetting('invoice.taxBasisPoints', tx) : null;
    if (taxOn && input.payment?.paymentModeId) {
      const nonCash = await getSetting('invoice.taxCardBasisPoints', tx);
      const mode = nonCash === null ? null : await tx.paymentMode.findUnique({ where: { id: input.payment.paymentModeId }, select: { method: true } });
      if (mode && mode.method !== 'CASH') rate = nonCash;
    }
    const totals = invoiceTotals(lines, BigInt(input.discountPaisa ?? 0), rate);

    let inv = await tx.invoice.create({
      data: {
        number: await invoiceNumber(tx),
        kind: 'DIRECT',
        patientId: patient.id,
        doctorId: input.doctorId ?? null,
        invoiceDate: dateOnly(date),
        subtotalPaisa: totals.subtotal,
        discountPaisa: totals.discount,
        taxPaisa: totals.tax,
        taxRateBp: totals.taxRateBp,
        totalPaisa: totals.total,
        paidPaisa: 0n,
        balancePaisa: totals.total,
        idempotencyKey: key,
        createdById: actor.id!,
        lines: { create: lines.map((l) => ({ ...l, lineTotalPaisa: l.unitPricePaisa * BigInt(l.quantity) })) },
      },
    });
    await audit(tx, actor, { action: 'INVOICE_CREATED', recordType: 'Invoice', recordId: inv.id, after: { ...inv, lines, confirmOpenVisit: input.confirmOpenVisit ?? false } });

    if (input.useAdvancePaisa) {
      const amount = BigInt(input.useAdvancePaisa);
      if (amount > inv.balancePaisa) throw new ValidationError('Advance, invoice ke balance se zyada istemal nahi ho sakta.');
      await applyAdvance(tx, actor, inv, amount, `advance-apply:${key}`);
      inv = await moveInvoiceBalance(tx, actor, inv, amount);
    }
    if (input.payment && input.payment.amountPaisa > 0) inv = await takePayment(tx, actor, inv, input.payment, `payment:${key}`);
    if (inv.balancePaisa === 0n && inv.status === 'OPEN') inv = await moveInvoiceBalance(tx, actor, inv, 0n);

    await invoicesChanged(tx, inv.id);
    return inv.id;
  });
  return invoiceDetail(invoiceId);
}

type InvoiceRow = NonNullable<Awaited<ReturnType<typeof prisma.invoice.findUnique>>>;

/** One payment on a locked invoice: its share goes on the invoice, and any confirmed extra becomes an advance. */
async function takePayment(tx: Tx, actor: Actor, inv: InvoiceRow, p: PaymentInput, key: string): Promise<InvoiceRow> {
  const details = await moneyDetailsFromMode(tx, p);
  await fileSlip(tx, actor, details.method, p.slipAttachmentId, inv.id);
  const { toInvoice, toAdvance } = splitPayment(inv.balancePaisa, BigInt(p.amountPaisa), { extraToAdvance: p.extraToAdvance, hasPatient: !!inv.patientId });
  let updated = inv;
  if (toInvoice > 0n) {
    const payment = await addMoneyPayment(tx, actor, inv, toInvoice, details, key);
    updated = await moveInvoiceBalance(tx, actor, inv, toInvoice);
    await audit(tx, actor, {
      action: 'PAYMENT_RECEIVED',
      recordType: 'Invoice',
      recordId: inv.id,
      before: { paid: inv.paidPaisa, balance: inv.balancePaisa, status: inv.status },
      after: { paymentId: payment.id, receiptNo: payment.receiptNo, amount: toInvoice, method: details.method, paymentModeId: details.paymentModeId, paid: updated.paidPaisa, balance: updated.balancePaisa, status: updated.status },
    });
  }
  if (toAdvance > 0n) await receiveAdvance(tx, actor, inv.patientId!, toAdvance, details, `${key}:extra`, { invoiceId: inv.id, note: `Extra on invoice ${inv.number}` });
  return updated;
}

// ───────────── Later payments ─────────────

/** A later payment. Works on a closed invoice too, as long as a balance remains; the visit is not reopened. */
export async function addPayment(actor: Actor, invoiceId: string, p: PaymentInput, idempotencyKey: string) {
  const key = `payment:${idempotencyKey}`;
  await moneyTx(async (tx) => {
    if (await tx.payment.findUnique({ where: { idempotencyKey: key }, select: { id: true } })) return;
    const inv = await lockInvoice(tx, invoiceId);
    assertNotCancelled(inv);
    if (inv.balancePaisa <= 0n) throw new ConflictError('NOTHING_DUE', `Invoice ${inv.number} par koi balance nahi.`);
    await takePayment(tx, actor, inv, p, key);
    await visitChanged(tx, inv.appointmentId);
    await invoicesChanged(tx, inv.id);
  });
  return invoiceDetail(invoiceId);
}

export async function applyAdvanceToInvoice(actor: Actor, invoiceId: string, amountPaisa: number, idempotencyKey: string) {
  const key = `advance-apply:${idempotencyKey}`;
  await moneyTx(async (tx) => {
    if (await tx.payment.findUnique({ where: { idempotencyKey: key }, select: { id: true } })) return;
    const inv = await lockInvoice(tx, invoiceId);
    assertNotCancelled(inv);
    const amount = BigInt(amountPaisa);
    if (amount > inv.balancePaisa) throw new ValidationError('Advance, invoice ke balance se zyada istemal nahi ho sakta.');
    await applyAdvance(tx, actor, inv, amount, key);
    await moveInvoiceBalance(tx, actor, inv, amount);
    await visitChanged(tx, inv.appointmentId);
    await invoicesChanged(tx, inv.id);
  });
  return invoiceDetail(invoiceId);
}

// ───────────── Advances ─────────────

export async function recordAdvance(actor: Actor, input: { patientId: string; amountPaisa: number; paymentModeId: string; reference?: string; bankAccountId?: string; note?: string }, idempotencyKey: string) {
  const key = `advance:${idempotencyKey}`;
  return moneyTx(async (tx) => {
    const replay = await tx.patientAdvanceEntry.findUnique({ where: { idempotencyKey: key } });
    if (replay) return { entry: replay, balancePaisa: await advanceBalance(tx, replay.patientId) };
    const patient = await tx.patient.findUnique({ where: { id: input.patientId }, select: { id: true, mergedIntoId: true } });
    if (!patient) throw new NotFoundError('Patient');
    if (patient.mergedIntoId) throw new ConflictError('PATIENT_MERGED', 'Yeh record doosre patient mein merge ho chuka hai.');
    const details = await moneyDetailsFromMode(tx, input);
    const entry = await receiveAdvance(tx, actor, patient.id, BigInt(input.amountPaisa), details, key, { note: input.note });
    await publish(tx, INVOICE_ROLES.map(roleRoom), 'invoices:changed', { patientId: patient.id });
    return { entry, balancePaisa: await advanceBalance(tx, patient.id) };
  });
}

export async function refundPatientAdvance(actor: Actor, patientId: string, input: { amountPaisa: number; paymentModeId: string; reference?: string; bankAccountId?: string; reason: string }, idempotencyKey: string) {
  const key = `advance-refund:${idempotencyKey}`;
  return moneyTx(async (tx) => {
    const replay = await tx.patientAdvanceEntry.findUnique({ where: { idempotencyKey: key } });
    if (replay) return { entry: replay, balancePaisa: await advanceBalance(tx, replay.patientId) };
    const details = await moneyDetailsFromMode(tx, input);
    const entry = await refundAdvance(tx, actor, patientId, BigInt(input.amountPaisa), details, key, input.reason.trim());
    await publish(tx, INVOICE_ROLES.map(roleRoom), 'invoices:changed', { patientId });
    return { entry, balancePaisa: await advanceBalance(tx, patientId) };
  });
}

export async function advanceEntries(f: { patientId?: string; q?: string; page: number; pageSize: number }) {
  const term = f.q?.trim();
  const phone = term ? phoneSearchFragment(term) : null;
  const where: Prisma.PatientAdvanceEntryWhereInput = {
    ...(f.patientId ? { patientId: f.patientId } : {}),
    ...(term ? { patient: { is: { OR: [{ name: { contains: term } }, ...(phone ? [{ phone: { contains: phone } }] : [])] } } } : {}),
  };
  const [rows, total, balance] = await Promise.all([
    prisma.patientAdvanceEntry.findMany({
      where,
      select: { id: true, type: true, amountPaisa: true, receiptNo: true, method: true, reference: true, invoiceId: true, note: true, actorId: true, createdAt: true, patient: { select: { id: true, name: true, phone: true } }, },
      orderBy: { createdAt: 'desc' },
      skip: (f.page - 1) * f.pageSize,
      take: f.pageSize,
    }),
    prisma.patientAdvanceEntry.count({ where }),
    f.patientId ? advanceBalance(prisma, f.patientId) : null,
  ]);
  const actors = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.actorId))] } }, select: { id: true, displayName: true } });
  return {
    items: rows.map((r) => ({ ...r, actorName: actors.find((a) => a.id === r.actorId)?.displayName ?? null })),
    page: f.page,
    pageSize: f.pageSize,
    total,
    ...(balance !== null ? { balancePaisa: balance } : {}),
  };
}

// ───────────── Cancel ─────────────

export type CancelMoney = 'MOVE_TO_ADVANCE' | 'REFUND';

/**
 * Cancel an invoice (Manager / MD, reason required). Nothing is deleted. Each payment gets a reversal row dated today,
 * so signed cash closings stay as they are:
 *  - REFUND: the money leaves the drawer or bank by the same method it came in.
 *  - MOVE_TO_ADVANCE: nothing leaves the drawer; the amount is held for the patient.
 *  - A payment that came from the advance always goes back to the advance.
 * Pharmacy stock comes back. A visit's invoice cannot be cancelled while the visit is active.
 */
export async function cancelInvoice(actor: Actor, invoiceId: string, input: { reason: string; money?: CancelMoney }) {
  const reason = input.reason.trim();
  if (reason.length < 3) throw new ValidationError('Cancel karne ki wajah likhein.');
  await moneyTx(async (tx) => {
    const inv = await lockInvoice(tx, invoiceId);
    assertNotCancelled(inv);
    if (inv.appointmentId) {
      const appt = await tx.appointment.findUniqueOrThrow({ where: { id: inv.appointmentId }, select: { status: true } });
      if (!FINISHED_VISIT_STATUSES.includes(appt.status)) throw new ConflictError('VISIT_ACTIVE', 'Visit abhi chal rahi hai. Visit khatam hone ke baad invoice cancel ho sakti hai.', { appointmentStatus: appt.status });
    }
    const payments = await tx.payment.findMany({ where: { invoiceId } });
    const reversed = new Set(payments.map((p) => p.reversesPaymentId).filter(Boolean));
    const live = payments.filter((p) => !p.reversesPaymentId && !reversed.has(p.id));
    const hasNewMoney = live.some((p) => p.method !== 'ADVANCE');
    if (hasNewMoney && !input.money) throw new ValidationError('Is invoice par payment ho chuki hai. Chunein: advance mein rakhein ya wapas karein.');
    if (hasNewMoney && input.money === 'MOVE_TO_ADVANCE' && !inv.patientId) throw new ValidationError('Is invoice par patient nahi, is liye raqam sirf wapas ho sakti hai.');

    const undone = [];
    for (const p of live) {
      const toAdvance = p.method === 'ADVANCE' || input.money === 'MOVE_TO_ADVANCE';
      const reversal = await tx.payment.create({
        data: {
          receiptNo: await paymentReceiptNumber(tx),
          invoiceId,
          amountPaisa: -p.amountPaisa,
          // Money staying in the drawer is not a cash movement, so this row is ADVANCE and Cash Closing leaves it out.
          method: toAdvance ? 'ADVANCE' : p.method,
          paymentModeId: toAdvance ? null : p.paymentModeId,
          reference: toAdvance ? null : p.reference,
          bankAccountId: toAdvance ? null : p.bankAccountId,
          reversesPaymentId: p.id,
          note: reason,
          cashierId: actor.id!,
          idempotencyKey: `reversal:${p.id}`,
        },
      });
      if (toAdvance) {
        await creditAdvanceFromCancel(tx, actor, inv.patientId!, p.amountPaisa, inv, reversal.id);
      } else {
        await tx.ledgerEntry.create({
          data: { account: p.method === 'CASH' ? 'CASH_IN_HAND' : 'BANK', bankAccountId: p.bankAccountId, amountPaisa: -p.amountPaisa, refType: 'Payment', refId: reversal.id, memo: `Refund · cancelled invoice ${inv.number}`, actorId: actor.id! },
        });
      }
      undone.push({ paymentId: p.id, reversalId: reversal.id, amount: p.amountPaisa, method: p.method, to: toAdvance ? 'ADVANCE' : 'REFUND' });
    }

    const stockBack = await returnPharmacyStock(tx, actor, inv.id, inv.number, reason);
    const paidBack = live.reduce((s, p) => s + p.amountPaisa, 0n);
    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        status: 'VOID',
        paidPaisa: inv.paidPaisa - paidBack,
        balancePaisa: 0n,
        cancelledAt: new Date(),
        cancelledById: actor.id!,
        cancelReason: reason,
        cancelMoney: !live.length ? 'NONE' : hasNewMoney && input.money === 'REFUND' ? 'REFUNDED' : 'MOVED_TO_ADVANCE',
      },
    });
    await audit(tx, actor, {
      action: 'INVOICE_CANCELLED',
      recordType: 'Invoice',
      recordId: invoiceId,
      before: { status: inv.status, paid: inv.paidPaisa, balance: inv.balancePaisa },
      after: { status: updated.status, paid: updated.paidPaisa, balance: updated.balancePaisa, cancelMoney: updated.cancelMoney, payments: undone, stockReturned: stockBack },
      reason,
    });
    await visitChanged(tx, inv.appointmentId);
    await invoicesChanged(tx, invoiceId);
  });
  return invoiceDetail(invoiceId);
}

/** Pharmacy lines still on the invoice go back into stock through the ledger, to the batches they came from. */
async function returnPharmacyStock(tx: Tx, actor: Actor, invoiceId: string, number: string, reason: string) {
  const lines = await tx.invoiceLine.findMany({ where: { invoiceId, stockItemId: { not: null } }, select: { id: true, reversesLineId: true } });
  const reversed = new Set(lines.map((l) => l.reversesLineId).filter(Boolean));
  const liveIds = lines.filter((l) => !l.reversesLineId && !reversed.has(l.id)).map((l) => l.id);
  if (!liveIds.length) return 0;
  const sold = await tx.stockTransaction.findMany({ where: { invoiceLineId: { in: liveIds }, type: 'SALE' } });
  for (const t of sold) {
    await tx.stockTransaction.create({
      data: { itemId: t.itemId, batchId: t.batchId, type: 'ADJUSTMENT', quantity: -t.quantity, invoiceLineId: t.invoiceLineId, actorId: actor.id!, reason: `Invoice ${number} cancel: ${reason}`, idempotencyKey: `cancelrev:${t.id}` },
    });
  }
  return sold.length;
}

// ───────────── Detail, print, history ─────────────

export async function invoiceDetail(invoiceId: string, role?: Role) {
  const inv = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      patient: { select: { id: true, name: true, phone: true } },
      doctor: { select: { id: true, displayName: true } },
      lines: { orderBy: { createdAt: 'asc' } },
      payments: { orderBy: { receivedAt: 'asc' }, include: { paymentMode: { select: { name: true } } } },
    },
  });
  if (!inv) throw new NotFoundError('Invoice');
  const userIds = [...new Set([inv.createdById, inv.cancelledById, inv.closedById, ...inv.payments.map((p) => p.cashierId)].filter((x): x is string => !!x))];
  const [users, advance, visit] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } }),
    inv.patientId ? advanceBalance(prisma, inv.patientId) : null,
    inv.appointmentId ? prisma.appointment.findUnique({ where: { id: inv.appointmentId }, select: { status: true } }) : null,
  ]);
  const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.displayName ?? null) : null);
  const reversedLines = new Set(inv.lines.map((l) => l.reversesLineId).filter(Boolean));
  const seeDiscount = !role || hasPermission(role, 'invoice:view_discount');
  const { idempotencyKey: _key, createdById, cancelledById, closedById, discountPaisa, ...rest } = inv;
  const cancelBlock = inv.status === 'VOID' ? 'ALREADY_CANCELLED' : visit && !FINISHED_VISIT_STATUSES.includes(visit.status) ? 'VISIT_ACTIVE' : null;
  return {
    ...rest,
    ...(seeDiscount ? { discountPaisa } : {}),
    date: dateOnlyStr(inv.invoiceDate),
    cancelled: inv.status === 'VOID',
    createdByName: name(createdById),
    cancelledByName: name(cancelledById),
    closedByName: name(closedById),
    doctor: inv.doctor ? { id: inv.doctor.id, name: inv.doctor.displayName } : null,
    lines: inv.lines.map((l) => ({ ...(seeDiscount ? l : { ...l, discountPaisa: undefined, discountPercentBp: undefined }), reversed: reversedLines.has(l.id) })),
    payments: inv.payments.map((p) => {
      const { idempotencyKey: _k, paymentMode, ...pay } = p;
      return { ...pay, modeName: paymentMode?.name ?? null, cashierName: name(p.cashierId) };
    }),
    advanceBalancePaisa: advance,
    cancelBlock,
  };
}

/**
 * What a printout needs. The discount is always on it: a patient's bill has to add up, whoever prints it. To stop a
 * role seeing discounts altogether, remove its `invoice:print` as well as `invoice:view_discount`.
 */
export async function invoicePrint(invoiceId: string) {
  const [invoice, clinicName, logoDataUrl] = await Promise.all([invoiceDetail(invoiceId), getSetting('clinic.name'), getSetting('clinic.logoDataUrl')]);
  return { invoice, clinic: { name: clinicName, logoDataUrl } };
}

const AUDIT_ACTIONS = ['INVOICE_OPENED', 'INVOICE_CREATED', 'INVOICE_CLOSED', 'INVOICE_CANCELLED', 'PAYMENT_RECEIVED', 'ADVANCE_RECEIVED', 'ADVANCE_APPLIED', 'ADVANCE_REFUNDED', 'PHARMACY_SALE', 'PHARMACY_SALE_REVERSED', 'COUNTER_SALE', 'INVOICES_EXPORTED', 'PAYMENT_MODE_CHANGED', 'INVOICE_CATEGORY_CHANGED', 'INVOICE_SETTINGS_CHANGED'];

/** Audit history for one invoice, or for the whole billing area, with old and new values. */
export async function auditHistory(f: { invoiceId?: string; page: number; pageSize: number }) {
  const where: Prisma.AuditEventWhereInput = f.invoiceId ? { recordType: 'Invoice', recordId: f.invoiceId } : { action: { in: AUDIT_ACTIONS } };
  const [rows, total] = await Promise.all([
    prisma.auditEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (f.page - 1) * f.pageSize, take: f.pageSize }),
    prisma.auditEvent.count({ where }),
  ]);
  const actors = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))] } }, select: { id: true, displayName: true } });
  return {
    items: rows.map((r) => ({ id: r.id, action: r.action, recordType: r.recordType, recordId: r.recordId, before: r.before, after: r.after, reason: r.reason, at: r.createdAt, actorName: actors.find((a) => a.id === r.actorId)?.displayName ?? null })),
    page: f.page,
    pageSize: f.pageSize,
    total,
  };
}

// ───────────── Payment modes and categories (MD) ─────────────

export async function listPaymentModes() {
  return { items: await prisma.paymentMode.findMany({ select: { id: true, name: true, method: true, active: true, sortOrder: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }) };
}

export async function addPaymentMode(actor: Actor, input: { name: string; method: 'CASH' | 'CARD' | 'BANK_ONLINE' | 'CHEQUE'; sortOrder?: number }) {
  const name = input.name.trim().replace(/\s+/g, ' ');
  return moneyTx(async (tx) => {
    if (await tx.paymentMode.findFirst({ where: { name } })) throw new ConflictError('MODE_EXISTS', `"${name}" pehle se list mein hai.`);
    const m = await tx.paymentMode.create({ data: { name, method: input.method, sortOrder: input.sortOrder ?? 50, createdById: actor.id } });
    await audit(tx, actor, { action: 'PAYMENT_MODE_CHANGED', recordType: 'PaymentMode', recordId: m.id, after: m });
    return m;
  });
}

/** Rename, reorder, or turn on / off. What a mode settles as cannot change: past receipts were counted that way. */
export async function updatePaymentMode(actor: Actor, id: string, input: { name?: string; active?: boolean; sortOrder?: number }) {
  return moneyTx(async (tx) => {
    const before = await tx.paymentMode.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Payment mode');
    const name = input.name?.trim().replace(/\s+/g, ' ');
    if (name && (await tx.paymentMode.findFirst({ where: { name, id: { not: id } } }))) throw new ConflictError('MODE_EXISTS', `"${name}" pehle se list mein hai.`);
    if (input.active === false && before.active && (await tx.paymentMode.count({ where: { active: true, id: { not: id } } })) === 0) throw new ConflictError('LAST_MODE', 'Kam az kam ek payment mode on rehna chahiye.');
    const after = await tx.paymentMode.update({ where: { id }, data: { ...(name ? { name } : {}), ...(input.active !== undefined ? { active: input.active } : {}), ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}) } });
    await audit(tx, actor, { action: 'PAYMENT_MODE_CHANGED', recordType: 'PaymentMode', recordId: id, before, after });
    return after;
  });
}

export async function listCategories() {
  return { items: await prisma.invoiceCategory.findMany({ select: { id: true, name: true, active: true, sortOrder: true, _count: { select: { services: true } } }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }) };
}

export async function addCategory(actor: Actor, input: { name: string; sortOrder?: number }) {
  const name = input.name.trim().replace(/\s+/g, ' ');
  return moneyTx(async (tx) => {
    if (await tx.invoiceCategory.findFirst({ where: { name } })) throw new ConflictError('CATEGORY_EXISTS', `"${name}" pehle se list mein hai.`);
    const c = await tx.invoiceCategory.create({ data: { name, sortOrder: input.sortOrder ?? 50, createdById: actor.id } });
    await audit(tx, actor, { action: 'INVOICE_CATEGORY_CHANGED', recordType: 'InvoiceCategory', recordId: c.id, after: c });
    return c;
  });
}

/** A rename also updates the category text on its services, so Reception's service list shows the same name. */
export async function updateCategory(actor: Actor, id: string, input: { name?: string; active?: boolean; sortOrder?: number }) {
  return moneyTx(async (tx) => {
    const before = await tx.invoiceCategory.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Category');
    const name = input.name?.trim().replace(/\s+/g, ' ');
    if (name && (await tx.invoiceCategory.findFirst({ where: { name, id: { not: id } } }))) throw new ConflictError('CATEGORY_EXISTS', `"${name}" pehle se list mein hai.`);
    const after = await tx.invoiceCategory.update({ where: { id }, data: { ...(name ? { name } : {}), ...(input.active !== undefined ? { active: input.active } : {}), ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}) } });
    if (name && name !== before.name) await tx.service.updateMany({ where: { invoiceCategoryId: id, category: { not: null } }, data: { category: name } });
    await audit(tx, actor, { action: 'INVOICE_CATEGORY_CHANGED', recordType: 'InvoiceCategory', recordId: id, before, after });
    return after;
  });
}

export async function setServiceCategory(actor: Actor, serviceId: string, categoryId: string) {
  return moneyTx(async (tx) => {
    const before = await tx.service.findUnique({ where: { id: serviceId } });
    if (!before) throw new NotFoundError('Service');
    const cat = await tx.invoiceCategory.findUnique({ where: { id: categoryId } });
    if (!cat) throw new NotFoundError('Category');
    const after = await tx.service.update({ where: { id: serviceId }, data: { invoiceCategoryId: categoryId, category: cat.name } });
    await audit(tx, actor, { action: 'SERVICE_UPDATED', recordType: 'Service', recordId: serviceId, before, after });
    return { id: serviceId, invoiceCategoryId: categoryId };
  });
}

