import { prisma } from '../../lib/prisma';
import { ConflictError, ValidationError } from '../../lib/errors';
import { addDaysStr, clinicDateStr, clinicDayBounds, dateOnly, dateOnlyStr } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';
import { installmentViews } from '../../services/installments';

/**
 * Cash (spec §14): the daily closing reviews Reception collections, discounts, cash/bank/cheque, cash paid out to
 * suppliers and the counted cash; the variance is recorded with the Manager's sign-off. A closing is immutable
 * (DB trigger). Cash reports cover a date range and include outstanding balances and installment schedules (Q7).
 */

const sumBy = <T>(rows: T[], f: (r: T) => bigint) => rows.reduce((s, r) => s + f(r), 0n);

/** Everything the Manager needs to close a clinic day (computed from payments, invoices and the ledger). */
export async function daySummary(date?: string) {
  const d = date ?? clinicDateStr(new Date());
  if (d > clinicDateStr(new Date())) throw new ValidationError('Aane wale din ka hisaab nahi.');
  const b = clinicDayBounds(d);
  const [payments, invoices, cashLedger, supplierPayments, closing] = await Promise.all([
    prisma.payment.findMany({ where: { receivedAt: { gte: b.start, lt: b.end } }, select: { id: true, receiptNo: true, amountPaisa: true, method: true, reference: true, cashierId: true, receivedAt: true, invoiceId: true } }),
    prisma.invoice.findMany({ where: { createdAt: { gte: b.start, lt: b.end } }, select: { id: true, discountPaisa: true } }),
    prisma.ledgerEntry.findMany({ where: { account: 'CASH_IN_HAND', createdAt: { gte: b.start, lt: b.end } }, select: { amountPaisa: true, refType: true } }),
    prisma.supplierPayment.findMany({ where: { paidAt: { gte: b.start, lt: b.end } }, select: { id: true, vendorId: true, amountPaisa: true, method: true, reference: true, paidAt: true } }),
    prisma.cashClosing.findUnique({ where: { date: dateOnly(d) } }),
  ]);
  const byMethod = (m: string) => sumBy(payments.filter((p) => p.method === m), (p) => p.amountPaisa);
  const cashIn = sumBy(cashLedger.filter((l) => l.amountPaisa > 0n), (l) => l.amountPaisa);
  const cashOut = -sumBy(cashLedger.filter((l) => l.amountPaisa < 0n), (l) => l.amountPaisa);
  const [cashiers, vendors] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: [...new Set([...payments.map((p) => p.cashierId), closing?.managerId, closing?.cashierId].filter((x): x is string => !!x))] } }, select: { id: true, displayName: true } }),
    prisma.vendor.findMany({ where: { id: { in: supplierPayments.map((s) => s.vendorId) } }, select: { id: true, name: true } }),
  ]);
  const name = (id: string | null | undefined) => (id ? (cashiers.find((u) => u.id === id)?.displayName ?? null) : null);
  const perCashier = [...new Set(payments.map((p) => p.cashierId))].map((id) => {
    const mine = payments.filter((p) => p.cashierId === id);
    return { cashierId: id, name: name(id), count: mine.length, totalPaisa: sumBy(mine, (p) => p.amountPaisa), cashPaisa: sumBy(mine.filter((p) => p.method === 'CASH'), (p) => p.amountPaisa) };
  });
  return {
    date: d,
    collections: {
      count: payments.length,
      totalPaisa: sumBy(payments, (p) => p.amountPaisa),
      cashPaisa: byMethod('CASH'),
      cardPaisa: byMethod('CARD'),
      bankPaisa: byMethod('BANK_ONLINE'),
      chequePaisa: byMethod('CHEQUE'),
    },
    discountsPaisa: sumBy(invoices, (i) => i.discountPaisa),
    cash: { inPaisa: cashIn, outPaisa: cashOut, expectedPaisa: cashIn - cashOut },
    supplierPayments: supplierPayments.map((s) => ({ ...s, vendorName: vendors.find((v) => v.id === s.vendorId)?.name ?? null })),
    perCashier,
    payments: payments.map((p) => ({ ...p, cashierName: name(p.cashierId) })),
    closing: closing && { ...closing, date: dateOnlyStr(closing.date), managerName: name(closing.managerId), cashierName: name(closing.cashierId) },
  };
}

/** Sign off the day: counted cash vs expected; a variance needs a note. One closing per clinic day, never edited. */
export async function closeDay(actor: Actor, input: { date: string; countedCashPaisa: number; notes?: string; cashierId?: string }) {
  const s = await daySummary(input.date);
  if (s.closing) throw new ConflictError('ALREADY_CLOSED', `${input.date} ki cash closing ho chuki hai.`);
  const counted = BigInt(input.countedCashPaisa);
  if (counted < 0n) throw new ValidationError('Counted cash sahi likhein.');
  const variance = counted - s.cash.expectedPaisa;
  if (variance !== 0n && !input.notes?.trim()) throw new ValidationError(`Variance Rs ${Number(variance) / 100} hai — wajah / note likhein.`);
  return prisma.$transaction(async (tx) => {
    if (await tx.cashClosing.findUnique({ where: { date: dateOnly(input.date) } })) throw new ConflictError('ALREADY_CLOSED', `${input.date} ki cash closing ho chuki hai.`);
    const c = await tx.cashClosing.create({
      data: {
        date: dateOnly(input.date),
        expectedCashPaisa: s.cash.expectedPaisa,
        countedCashPaisa: counted,
        variancePaisa: variance,
        cardPaisa: s.collections.cardPaisa,
        bankPaisa: s.collections.bankPaisa,
        chequePaisa: s.collections.chequePaisa,
        discountsPaisa: s.discountsPaisa,
        cashCollectedPaisa: s.collections.cashPaisa,
        cashPaidOutPaisa: s.cash.outPaisa,
        totalCollectedPaisa: s.collections.totalPaisa,
        notes: input.notes?.trim() || null,
        cashierId: input.cashierId ?? null,
        managerId: actor.id!,
      },
    });
    await audit(tx, actor, { action: 'CASH_CLOSED', recordType: 'CashClosing', recordId: c.id, after: { date: input.date, expected: s.cash.expectedPaisa, counted, variance }, reason: input.notes });
    return c;
  });
}

/** Outstanding balances with installment schedules (Q7): every invoice with money still owed. */
export async function outstanding() {
  const today = clinicDateStr(new Date());
  const invoices = await prisma.invoice.findMany({ where: { balancePaisa: { gt: 0n }, status: { not: 'VOID' } }, orderBy: { createdAt: 'asc' } });
  const [patients, installments] = await Promise.all([
    prisma.patient.findMany({ where: { id: { in: invoices.map((i) => i.patientId) } }, select: { id: true, name: true, phone: true } }),
    prisma.installment.findMany({ where: { versionId: { in: invoices.map((i) => i.planVersionId).filter((x): x is string => !!x) } } }),
  ]);
  const items = invoices.map((inv) => {
    const views = inv.planVersionId ? installmentViews(inv, installments.filter((x) => x.versionId === inv.planVersionId), today) : [];
    const overdue = views.filter((v) => v.state === 'OVERDUE');
    const next = views.find((v) => v.outstandingPaisa > 0n && v.state !== 'OVERDUE');
    return {
      invoiceId: inv.id,
      number: inv.number,
      appointmentId: inv.appointmentId,
      status: inv.status,
      createdAt: inv.createdAt,
      patient: patients.find((p) => p.id === inv.patientId) ?? null,
      totalPaisa: inv.totalPaisa,
      paidPaisa: inv.paidPaisa,
      balancePaisa: inv.balancePaisa,
      overduePaisa: sumBy(overdue, (v) => v.outstandingPaisa),
      overdueCount: overdue.length,
      nextDue: next ? { dueDate: next.dueDate, outstandingPaisa: next.outstandingPaisa } : null,
      installments: views,
      unscheduledPaisa: inv.balancePaisa - sumBy(views, (v) => v.outstandingPaisa) > 0n ? inv.balancePaisa - sumBy(views, (v) => v.outstandingPaisa) : 0n,
    };
  });
  return {
    items,
    totals: {
      balancePaisa: sumBy(items, (i) => i.balancePaisa),
      overduePaisa: sumBy(items, (i) => i.overduePaisa),
      dueNext30Paisa: sumBy(items.flatMap((i) => i.installments), (v) => (v.state !== 'OVERDUE' && v.state !== 'PAID' && v.dueDate <= addDaysStr(today, 30) ? v.outstandingPaisa : 0n)),
    },
  };
}

async function dayRow(d: string) {
  const s = await daySummary(d);
  return {
    date: d,
    collections: s.collections,
    discountsPaisa: s.discountsPaisa,
    supplierPaidPaisa: sumBy(s.supplierPayments, (p) => p.amountPaisa),
    cashExpectedPaisa: s.cash.expectedPaisa,
    closing: s.closing ? { countedCashPaisa: s.closing.countedCashPaisa, variancePaisa: s.closing.variancePaisa, managerName: s.closing.managerName, signedOffAt: s.closing.signedOffAt } : null,
  };
}

/** Cash report for a date range: per day collections by method, discounts, supplier cash out, closing variance. */
export async function report(from: string, to: string) {
  if (from > to) throw new ValidationError('From date, To se pehle ho.');
  const days: string[] = [];
  for (let d = from; d <= to && days.length < 92; d = addDaysStr(d, 1)) days.push(d);
  if (days.at(-1) !== to) throw new ValidationError('Zyada se zyada 92 din.');
  const rows: Awaited<ReturnType<typeof dayRow>>[] = [];
  for (const d of days) rows.push(await dayRow(d));
  const tot = (f: (r: (typeof rows)[number]) => bigint) => sumBy(rows, f);
  return {
    from,
    to,
    days: rows,
    totals: {
      collectedPaisa: tot((r) => r.collections.totalPaisa),
      cashPaisa: tot((r) => r.collections.cashPaisa),
      cardPaisa: tot((r) => r.collections.cardPaisa),
      bankPaisa: tot((r) => r.collections.bankPaisa),
      chequePaisa: tot((r) => r.collections.chequePaisa),
      discountsPaisa: tot((r) => r.discountsPaisa),
      supplierPaidPaisa: tot((r) => r.supplierPaidPaisa),
      variancePaisa: tot((r) => r.closing?.variancePaisa ?? 0n),
      unclosedDays: rows.filter((r) => !r.closing && r.collections.count > 0).length,
    },
    outstanding: await outstanding(),
  };
}
