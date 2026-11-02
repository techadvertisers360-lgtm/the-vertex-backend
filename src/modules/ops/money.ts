import type { ExpenseSource, InvoiceRequestType } from '@prisma/client';
import { moneyTx, prisma } from '../../lib/prisma';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors';
import { formatNumber, nextSequence } from '../../lib/misc';
import type { MoneyMethod } from '../../lib/paymentMethods';
import { clinicDateStr, dateOnly, dateOnlyStr, local } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';
import { checkMoneyDetails, paymentReceiptNumber } from '../../services/invoicePayments';
import { notifyRoles, notifyUsers } from '../../services/notifications';

/**
 * Money at the desk from the client's demo (D-089). A different person always approves what someone asked for, and
 * every approval is written with its money, stock and audit rows in one transaction.
 */

const names = async (ids: (string | null | undefined)[]) => {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  const users = list.length ? await prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, displayName: true } }) : [];
  return (id: string | null | undefined) => (id ? (users.find((u) => u.id === id)?.displayName ?? null) : null);
};

// ───────────── Part payment and bill correction requests ─────────────

export async function createInvoiceRequest(actor: Actor, input: { type: InvoiceRequestType; invoiceId: string; amountAskedPaisa?: number; note: string }) {
  const note = input.note.trim();
  if (note.length < 3) throw new ValidationError('Wajah likhein.');
  return prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.findUnique({ where: { id: input.invoiceId }, select: { id: true, number: true, status: true, balancePaisa: true, doctorId: true, appointmentId: true } });
    if (!inv) throw new NotFoundError('Invoice');
    if (inv.status === 'VOID') throw new ConflictError('INVOICE_CANCELLED', 'Yeh invoice cancel ho chuki hai.');
    if (await tx.invoiceRequest.findFirst({ where: { invoiceId: inv.id, type: input.type, status: 'PENDING' }, select: { id: true } })) throw new ConflictError('REQUEST_WAITING', 'Is invoice ki request pehle se pending hai.');
    if (input.type === 'PART_PAYMENT') {
      if (inv.balancePaisa <= 0n) throw new ValidationError('Is invoice par koi balance nahi.');
      if (input.amountAskedPaisa === undefined || input.amountAskedPaisa < 0 || BigInt(input.amountAskedPaisa) >= inv.balancePaisa) throw new ValidationError('Amount balance se kam likhein.');
    }
    const r = await tx.invoiceRequest.create({
      data: { type: input.type, invoiceId: inv.id, requestedById: actor.id!, note, amountNeededPaisa: input.type === 'PART_PAYMENT' ? inv.balancePaisa : null, amountAskedPaisa: input.type === 'PART_PAYMENT' ? BigInt(input.amountAskedPaisa!) : null },
    });
    await audit(tx, actor, { action: 'INVOICE_REQUEST_CREATED', recordType: 'InvoiceRequest', recordId: r.id, after: { type: r.type, invoice: inv.number, asked: r.amountAskedPaisa }, reason: note });
    const notice = { type: 'INVOICE_REQUEST', subject: `${input.type === 'PART_PAYMENT' ? 'Part payment' : 'Bill correction'} request: ${inv.number}`, body: note, recordType: 'InvoiceRequest', recordId: r.id, sender: actor };
    await notifyRoles(tx, ['MANAGER'], notice);
    const appointment = inv.appointmentId ? await tx.appointment.findUnique({ where: { id: inv.appointmentId }, select: { doctorId: true } }) : null;
    const doctorId = inv.doctorId ?? appointment?.doctorId;
    if (input.type === 'PART_PAYMENT' && doctorId) await notifyUsers(tx, [doctorId], notice);
    return r;
  });
}

export async function listInvoiceRequests(actor: Actor, status?: 'PENDING' | 'APPROVED' | 'REJECTED') {
  // A Doctor sees part payments on their own visits only, and never a bill correction.
  let doctorInvoices: string[] | undefined;
  if (actor.role === 'DOCTOR') {
    const appointments = await prisma.appointment.findMany({ where: { doctorId: actor.id! }, select: { id: true } });
    const own = await prisma.invoice.findMany({ where: { OR: [{ doctorId: actor.id! }, { appointmentId: { in: appointments.map((a) => a.id) } }] }, select: { id: true } });
    doctorInvoices = own.map((i) => i.id);
  }
  const rows = await prisma.invoiceRequest.findMany({
    where: { ...(status ? { status } : {}), ...(doctorInvoices ? { invoiceId: { in: doctorInvoices }, type: 'PART_PAYMENT' as const } : {}), ...(actor.role === 'RECEPTIONIST' ? { requestedById: actor.id! } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  const invoices = await prisma.invoice.findMany({ where: { id: { in: rows.map((r) => r.invoiceId) } }, select: { id: true, number: true, buyerName: true, balancePaisa: true, patient: { select: { name: true } } } });
  const who = await names(rows.flatMap((r) => [r.requestedById, r.decidedById]));
  return {
    items: rows.map((r) => {
      const inv = invoices.find((i) => i.id === r.invoiceId);
      return { ...r, invoiceNumber: inv?.number ?? null, patient: inv?.patient?.name ?? inv?.buyerName ?? null, balancePaisa: inv?.balancePaisa ?? null, requestedBy: who(r.requestedById), decidedBy: who(r.decidedById) };
    }),
  };
}

export async function decideInvoiceRequest(actor: Actor, id: string, input: { approve: boolean; amountApprovedPaisa?: number; adjustmentPaisa?: number; note?: string }) {
  return moneyTx(async (tx) => {
    const r = await tx.invoiceRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundError('Request');
    if (r.status !== 'PENDING') throw new ConflictError('ALREADY_DECIDED', 'Is request par faisla ho chuka hai.');
    if (r.requestedById === actor.id) throw new ForbiddenError({ recordType: 'InvoiceRequest', recordId: id, rule: 'approver_not_requester' }, 'Aap ne khud yeh request ki hai; koi aur faisla karega.');
    const inv = await tx.invoice.findUnique({ where: { id: r.invoiceId }, select: { doctorId: true, appointmentId: true } });
    const visit = inv?.appointmentId ? await tx.appointment.findUnique({ where: { id: inv.appointmentId }, select: { doctorId: true } }) : null;
    if (actor.role === 'DOCTOR' && (r.type !== 'PART_PAYMENT' || (inv?.doctorId ?? visit?.doctorId) !== actor.id)) throw new ForbiddenError({ recordType: 'InvoiceRequest', recordId: id, rule: 'doctor_own_visit' });
    if (!input.approve && !input.note?.trim()) throw new ValidationError('Reject ki wajah likhein.');
    const amount = r.type === 'PART_PAYMENT' && input.approve ? BigInt(input.amountApprovedPaisa ?? Number(r.amountAskedPaisa ?? 0n)) : null;
    // Bill correction (D-090): a line for the difference, so the original lines stay as they were.
    const adjustment = r.type === 'BILL_CORRECTION' && input.approve && input.adjustmentPaisa ? BigInt(input.adjustmentPaisa) : null;
    if (adjustment) {
      await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${r.invoiceId} FOR UPDATE`;
      const bill = await tx.invoice.findUniqueOrThrow({ where: { id: r.invoiceId }, select: { status: true, subtotalPaisa: true, totalPaisa: true, paidPaisa: true, balancePaisa: true } });
      if (bill.status === 'VOID') throw new ConflictError('INVOICE_CANCELLED', 'Yeh invoice cancel ho chuki hai.');
      const total = bill.totalPaisa + adjustment;
      if (total < bill.paidPaisa) throw new ValidationError('Naya total wusool shuda raqam se kam hai. Pehle refund karein ya invoice cancel karein.');
      await tx.invoiceLine.create({ data: { invoiceId: r.invoiceId, description: `Correction: ${r.note}`.slice(0, 190), quantity: 1, unitPricePaisa: adjustment, discountPaisa: 0n, lineTotalPaisa: adjustment, reason: input.note?.trim() || r.note } });
      await tx.invoice.update({ where: { id: r.invoiceId }, data: { subtotalPaisa: bill.subtotalPaisa + adjustment, totalPaisa: total, balancePaisa: total - bill.paidPaisa } });
    }
    const after = await tx.invoiceRequest.update({
      where: { id },
      data: { adjustmentPaisa: adjustment, status: input.approve ? 'APPROVED' : 'REJECTED', amountApprovedPaisa: amount, decidedById: actor.id, decidedAt: new Date(), decisionNote: input.note?.trim() || null },
    });
    await audit(tx, actor, { action: input.approve ? 'INVOICE_REQUEST_APPROVED' : 'INVOICE_REQUEST_REJECTED', recordType: 'InvoiceRequest', recordId: id, before: { status: r.status }, after: { status: after.status, amount }, reason: input.note });
    await notifyUsers(tx, [r.requestedById], { type: 'INVOICE_REQUEST_DECIDED', subject: input.approve ? 'Request approve ho gayi' : 'Request reject ho gayi', body: input.note, recordType: 'InvoiceRequest', recordId: id, sender: actor });
    return after;
  });
}

// ───────────── Cash handover ─────────────

export async function createHandover(actor: Actor, input: { date?: string; amountPaisa: number; leftAtDeskPaisa?: number; toId: string; note?: string }) {
  if (input.toId === actor.id) throw new ValidationError('Kisi aur ko cash dein.');
  const to = await prisma.user.findFirst({ where: { id: input.toId, active: true, role: { in: ['RECEPTIONIST', 'MANAGER', 'MD', 'MARKETING_DIRECTOR'] } }, select: { id: true, displayName: true } });
  if (!to) throw new ValidationError('Yeh shakhs cash nahi le sakta.');
  return prisma.$transaction(async (tx) => {
    const h = await tx.cashHandover.create({
      data: { date: dateOnly(input.date ?? clinicDateStr(new Date())), amountPaisa: BigInt(input.amountPaisa), leftAtDeskPaisa: input.leftAtDeskPaisa === undefined ? null : BigInt(input.leftAtDeskPaisa), fromId: actor.id!, toId: to.id, note: input.note?.trim() || null },
    });
    await audit(tx, actor, { action: 'CASH_HANDED_OVER', recordType: 'CashHandover', recordId: h.id, after: { amount: h.amountPaisa, left: h.leftAtDeskPaisa, to: to.displayName } });
    await notifyUsers(tx, [to.id], { type: 'CASH_HANDOVER', subject: `${actor.displayName} ne cash diya: confirm karein`, recordType: 'CashHandover', recordId: h.id, sender: actor });
    return h;
  });
}

export async function confirmHandover(actor: Actor, id: string) {
  return prisma.$transaction(async (tx) => {
    const h = await tx.cashHandover.findUnique({ where: { id } });
    if (!h) throw new NotFoundError('Handover');
    if (h.toId !== actor.id) throw new ForbiddenError({ recordType: 'CashHandover', recordId: id, rule: 'receiver_only' });
    if (h.receivedAt) throw new ConflictError('ALREADY_CONFIRMED', 'Yeh cash pehle hi confirm ho chuka hai.');
    const after = await tx.cashHandover.update({ where: { id }, data: { receivedAt: new Date() } });
    await audit(tx, actor, { action: 'CASH_HANDOVER_RECEIVED', recordType: 'CashHandover', recordId: id, after: { amount: h.amountPaisa } });
    return after;
  });
}

export async function listHandovers(actor: Actor, date?: string) {
  const top = actor.role === 'MANAGER' || actor.role === 'MD' || actor.role === 'MARKETING_DIRECTOR';
  const rows = await prisma.cashHandover.findMany({
    where: { ...(date ? { date: dateOnly(date) } : {}), ...(top ? {} : { OR: [{ fromId: actor.id! }, { toId: actor.id! }] }) },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  const who = await names(rows.flatMap((r) => [r.fromId, r.toId]));
  const receivers = await prisma.user.findMany({ where: { active: true, role: { in: ['RECEPTIONIST', 'MANAGER', 'MD', 'MARKETING_DIRECTOR'] }, id: { not: actor.id! } }, select: { id: true, displayName: true }, orderBy: { displayName: 'asc' } });
  return { items: rows.map((r) => ({ ...r, date: dateOnlyStr(r.date), from: who(r.fromId), to: who(r.toId) })), receivers };
}

// ───────────── Pharmacy sale returns ─────────────

export async function returnableSales(q?: string) {
  const text = q?.trim();
  const lines = await prisma.invoiceLine.findMany({
    where: { stockItemId: { not: null }, reversesLineId: null, invoice: { status: { not: 'VOID' }, ...(text ? { OR: [{ number: { contains: text } }, { buyerName: { contains: text } }, { patient: { name: { contains: text } } }] } : {}) } },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, description: true, quantity: true, lineTotalPaisa: true, createdAt: true, invoice: { select: { id: true, number: true, buyerName: true, patient: { select: { name: true } } } } },
  });
  const taken = await prisma.saleReturn.groupBy({ by: ['invoiceLineId'], where: { invoiceLineId: { in: lines.map((l) => l.id) }, status: { not: 'REJECTED' } }, _sum: { quantity: true } });
  return {
    items: lines.map((l) => ({
      id: l.id,
      description: l.description,
      quantity: l.quantity,
      returnableQty: l.quantity - (taken.find((t) => t.invoiceLineId === l.id)?._sum.quantity ?? 0),
      lineTotalPaisa: l.lineTotalPaisa,
      createdAt: l.createdAt,
      invoiceNumber: l.invoice.number,
      patient: l.invoice.patient?.name ?? l.invoice.buyerName,
    })),
  };
}

export async function requestSaleReturn(actor: Actor, input: { invoiceLineId: string; quantity: number; restock: boolean; method: MoneyMethod; bankAccountId?: string; reference?: string; reason: string }) {
  const reason = input.reason.trim();
  if (reason.length < 3) throw new ValidationError('Wapsi ki wajah likhein.');
  const money = await checkMoneyDetails(prisma, { method: input.method, bankAccountId: input.bankAccountId, reference: input.reference });
  return moneyTx(async (tx) => {
    const line = await tx.invoiceLine.findUnique({ where: { id: input.invoiceLineId }, select: { id: true, invoiceId: true, quantity: true, lineTotalPaisa: true, stockItemId: true, description: true, invoice: { select: { status: true, number: true, paidPaisa: true } } } });
    if (!line || !line.stockItemId) throw new ValidationError('Yeh product is bill par nahi.');
    if (line.invoice.status === 'VOID') throw new ConflictError('INVOICE_CANCELLED', 'Yeh invoice cancel ho chuki hai.');
    await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${line.invoiceId} FOR UPDATE`;
    const taken = await tx.saleReturn.aggregate({ where: { invoiceLineId: line.id, status: { not: 'REJECTED' } }, _sum: { quantity: true } });
    if (input.quantity > line.quantity - (taken._sum.quantity ?? 0)) throw new ValidationError('Bill par itni quantity baqi nahi.');
    const refund = (line.lineTotalPaisa * BigInt(input.quantity)) / BigInt(line.quantity);
    if (refund > line.invoice.paidPaisa) throw new ValidationError('Refund, wusool shuda raqam se zyada nahi ho sakta.');
    const year = local(new Date()).year;
    const r = await tx.saleReturn.create({
      data: { number: formatNumber('VH-SR', year, await nextSequence(tx, `sale-return:${year}`)), invoiceId: line.invoiceId, invoiceLineId: line.id, quantity: input.quantity, restock: input.restock, refundPaisa: refund, method: money.method, bankAccountId: money.bankAccountId ?? null, reference: money.reference ?? null, reason, requestedById: actor.id! },
    });
    await audit(tx, actor, { action: 'SALE_RETURN_REQUESTED', recordType: 'SaleReturn', recordId: r.id, after: { number: r.number, invoice: line.invoice.number, quantity: r.quantity, refund }, reason });
    await notifyRoles(tx, ['MANAGER'], { type: 'SALE_RETURN', subject: `Pharmacy wapsi: ${line.description}`, body: reason, recordType: 'SaleReturn', recordId: r.id, sender: actor });
    return r;
  });
}

export async function decideSaleReturn(actor: Actor, id: string, input: { approve: boolean; note?: string }) {
  return moneyTx(async (tx) => {
    const r = await tx.saleReturn.findUnique({ where: { id } });
    if (!r) throw new NotFoundError('Sale return');
    await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${r.invoiceId} FOR UPDATE`;
    const fresh = await tx.saleReturn.findUniqueOrThrow({ where: { id } });
    if (fresh.status !== 'PENDING') throw new ConflictError('ALREADY_DECIDED', 'Is wapsi par faisla ho chuka hai.');
    if (fresh.requestedById === actor.id) throw new ForbiddenError({ recordType: 'SaleReturn', recordId: id, rule: 'approver_not_requester' }, 'Aap ne khud yeh wapsi maangi hai; koi aur approve karega.');
    if (!input.approve) {
      if (!input.note?.trim()) throw new ValidationError('Reject ki wajah likhein.');
      const after = await tx.saleReturn.update({ where: { id }, data: { status: 'REJECTED', decidedById: actor.id, decidedAt: new Date(), decisionNote: input.note.trim() } });
      await audit(tx, actor, { action: 'SALE_RETURN_REJECTED', recordType: 'SaleReturn', recordId: id, before: { status: fresh.status }, after: { status: after.status }, reason: input.note });
      await notifyUsers(tx, [r.requestedById], { type: 'SALE_RETURN_DECIDED', subject: `Wapsi ${r.number} reject ho gayi`, body: input.note, recordType: 'SaleReturn', recordId: id, sender: actor });
      return after;
    }
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: r.invoiceId }, select: { id: true, number: true, status: true, totalPaisa: true, paidPaisa: true } });
    if (inv.status === 'VOID') throw new ConflictError('INVOICE_CANCELLED', 'Yeh invoice cancel ho chuki hai.');
    if (r.refundPaisa > inv.paidPaisa) throw new ConflictError('REFUND_TOO_HIGH', 'Refund, wusool shuda raqam se zyada nahi ho sakta.');
    const line = await tx.invoiceLine.findUniqueOrThrow({ where: { id: r.invoiceLineId }, select: { stockItemId: true, description: true } });

    // Money: a negative receipt and its ledger row, so Cash Closing shows the money going out today.
    const payment = await tx.payment.create({
      data: { receiptNo: await paymentReceiptNumber(tx), invoiceId: inv.id, amountPaisa: -r.refundPaisa, method: r.method, reference: r.reference, bankAccountId: r.bankAccountId, note: `Pharmacy wapsi ${r.number}: ${r.reason}`, cashierId: actor.id!, idempotencyKey: `sale-return:${r.id}` },
    });
    await tx.ledgerEntry.create({ data: { account: r.method === 'CASH' ? 'CASH_IN_HAND' : 'BANK', bankAccountId: r.bankAccountId, amountPaisa: -r.refundPaisa, refType: 'SaleReturn', refId: r.id, memo: `Pharmacy wapsi ${r.number} · ${inv.number}`, actorId: actor.id! } });
    await tx.invoice.update({ where: { id: inv.id }, data: { totalPaisa: inv.totalPaisa - r.refundPaisa, paidPaisa: inv.paidPaisa - r.refundPaisa } });

    // Stock: back to the batch it was sold from, unless it is damaged.
    if (r.restock && line.stockItemId) {
      const sold = await tx.stockTransaction.findFirst({ where: { invoiceLineId: r.invoiceLineId, type: 'SALE' }, orderBy: { createdAt: 'asc' }, select: { batchId: true, unitCostPaisa: true } });
      await tx.stockTransaction.create({ data: { itemId: line.stockItemId, batchId: sold?.batchId ?? null, type: 'ADJUSTMENT', quantity: r.quantity, unitCostPaisa: sold?.unitCostPaisa ?? null, invoiceLineId: r.invoiceLineId, actorId: actor.id!, reason: `Pharmacy wapsi ${r.number}`, idempotencyKey: `sale-return:${r.id}` } });
    }
    const after = await tx.saleReturn.update({ where: { id }, data: { status: 'APPROVED', decidedById: actor.id, decidedAt: new Date(), decisionNote: input.note?.trim() || null, paymentId: payment.id } });
    await audit(tx, actor, { action: 'SALE_RETURN_APPROVED', recordType: 'SaleReturn', recordId: id, before: { status: fresh.status, total: inv.totalPaisa, paid: inv.paidPaisa }, after: { status: after.status, refund: r.refundPaisa, receipt: payment.receiptNo, restock: r.restock } });
    await notifyUsers(tx, [r.requestedById], { type: 'SALE_RETURN_DECIDED', subject: `Wapsi ${r.number} approve ho gayi`, recordType: 'SaleReturn', recordId: id, sender: actor });
    return after;
  });
}

export async function listSaleReturns(status?: 'PENDING' | 'APPROVED' | 'REJECTED') {
  const rows = await prisma.saleReturn.findMany({ where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: 100 });
  const [lines, invoices] = await Promise.all([
    prisma.invoiceLine.findMany({ where: { id: { in: rows.map((r) => r.invoiceLineId) } }, select: { id: true, description: true } }),
    prisma.invoice.findMany({ where: { id: { in: rows.map((r) => r.invoiceId) } }, select: { id: true, number: true } }),
  ]);
  const who = await names(rows.flatMap((r) => [r.requestedById, r.decidedById]));
  return { items: rows.map((r) => ({ ...r, description: lines.find((l) => l.id === r.invoiceLineId)?.description ?? '', invoiceNumber: invoices.find((i) => i.id === r.invoiceId)?.number ?? '', requestedBy: who(r.requestedById), decidedBy: who(r.decidedById) })) };
}

// ───────────── Expenses and cash paid out ─────────────

export async function addExpense(actor: Actor, input: { date?: string; category: string; description: string; amountPaisa: number; paidFrom: ExpenseSource }) {
  const description = input.description.trim();
  if (description.length < 2) throw new ValidationError('Kharche ki tafseel likhein.');
  const date = dateOnly(input.date ?? clinicDateStr(new Date()));
  return prisma.$transaction(async (tx) => {
    const same = await tx.expense.findFirst({ where: { date, description, amountPaisa: BigInt(input.amountPaisa) }, select: { id: true } });
    if (same) throw new ConflictError('DUPLICATE_EXPENSE', 'Yeh kharcha us din pehle se save hai. Alag kharcha hai to tafseel badlein.');
    const e = await tx.expense.create({ data: { date, category: input.category.trim(), description, amountPaisa: BigInt(input.amountPaisa), paidFrom: input.paidFrom, createdById: actor.id! } });
    // Only money leaving the drawer changes the cash the day should close with.
    if (input.paidFrom === 'RECEPTION_DRAWER') await tx.ledgerEntry.create({ data: { account: 'CASH_IN_HAND', amountPaisa: -e.amountPaisa, refType: 'Expense', refId: e.id, memo: `${e.category}: ${description}`, actorId: actor.id! } });
    await audit(tx, actor, { action: 'EXPENSE_ADDED', recordType: 'Expense', recordId: e.id, after: { category: e.category, description, amount: e.amountPaisa, paidFrom: e.paidFrom } });
    return e;
  });
}

export async function listExpenses(month: string) {
  const start = dateOnly(`${month}-01`);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const end = dateOnly(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`);
  const rows = await prisma.expense.findMany({ where: { date: { gte: start, lt: end } }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] });
  const who = await names(rows.map((r) => r.createdById));
  const byCategory = [...new Set(rows.map((r) => r.category))].map((category) => ({ category, totalPaisa: rows.filter((r) => r.category === category).reduce((s, r) => s + r.amountPaisa, 0n) }));
  return { month, totalPaisa: rows.reduce((s, r) => s + r.amountPaisa, 0n), byCategory, items: rows.map((r) => ({ ...r, date: dateOnlyStr(r.date), createdBy: who(r.createdById) })) };
}
