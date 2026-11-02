import type { Invoice, PaymentMethod } from '@prisma/client';
import { prisma, type Db, type Tx } from '../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors';
import { formatNumber, nextSequence } from '../lib/misc';
import type { MoneyMethod } from '../lib/paymentMethods';
import { local } from '../lib/time';
import { audit, type Actor } from './audit';
import { claimAttachments } from './files';
import { getSetting } from './settings';

/**
 * Money movements on invoices and patient advances (D-084). Every write happens inside the caller's transaction, so
 * the receipt, its ledger entries, the advance entry and the audit event commit or roll back together.
 *
 * Only money that really moves touches CASH_IN_HAND / BANK. A payment settled from an advance, or money moved from a
 * cancelled invoice to an advance, uses method ADVANCE and changes only PATIENT_ADVANCE, so Cash Closing never counts
 * the same money twice.
 */

export interface MoneyDetails {
  method: MoneyMethod;
  paymentModeId?: string | null;
  reference?: string | null;
  bankAccountId?: string | null;
}

const moneyAccount = (method: PaymentMethod) => (method === 'CASH' ? ('CASH_IN_HAND' as const) : ('BANK' as const));

async function receiptNumber(tx: Tx, prefix: string, sequence: string): Promise<string> {
  const year = local(new Date()).year;
  return formatNumber(prefix, year, await nextSequence(tx, `${sequence}:${year}`));
}

export const paymentReceiptNumber = (tx: Tx) => receiptNumber(tx, 'VH-RCP', 'receipt');

/** The rules every money method has always had: non-cash needs a bank account, cheque / online a reference. */
export async function checkMoneyDetails(db: Db, d: MoneyDetails): Promise<MoneyDetails> {
  const reference = d.reference?.trim() || null;
  if (d.method !== 'CASH' && !d.bankAccountId) throw new ValidationError('Bank / card / cheque payment ke liye bank account chunein.');
  if ((d.method === 'CHEQUE' || d.method === 'BANK_ONLINE') && !reference) throw new ValidationError('Cheque number / transaction reference likhein.');
  if (d.method !== 'CASH' && !(await db.bankAccount.findFirst({ where: { id: d.bankAccountId!, active: true }, select: { id: true } }))) throw new ValidationError('Bank account nahi mila.');
  return { ...d, reference, bankAccountId: d.method === 'CASH' ? null : d.bankAccountId! };
}

/** A payment mode chosen at the desk, turned into the fixed method it settles as. */
export async function moneyDetailsFromMode(db: Db, input: { paymentModeId: string; reference?: string | null; bankAccountId?: string | null }): Promise<MoneyDetails> {
  const mode = await db.paymentMode.findUnique({ where: { id: input.paymentModeId } });
  if (!mode || !mode.active) throw new ValidationError('Payment mode nahi mila ya band hai.');
  if (mode.method === 'ADVANCE') throw new ValidationError('Yeh payment mode istemal nahi ho sakta.');
  return checkMoneyDetails(db, { method: mode.method, paymentModeId: mode.id, reference: input.reference, bankAccountId: input.bankAccountId });
}

/** The slip of a non-cash payment: required only when the setting is on (D-091); always filed on the invoice when given. */
export async function fileSlip(tx: Tx, actor: Actor, method: PaymentMethod, slipAttachmentId: string | undefined, invoiceId: string) {
  if (method !== 'CASH' && method !== 'ADVANCE' && !slipAttachmentId && (await getSetting('payment.requireSlip', tx))) throw new ValidationError('Payment slip ki photo add karein.');
  if (slipAttachmentId) await claimAttachments(tx, actor, [slipAttachmentId], ['paymentSlip'], 'Invoice', invoiceId);
}

/** New money received against an invoice: a Payment and its cash or bank ledger entry. */
export async function addMoneyPayment(tx: Tx, actor: Actor, inv: Pick<Invoice, 'id' | 'number'>, amount: bigint, d: MoneyDetails, idempotencyKey: string) {
  const payment = await tx.payment.create({
    data: {
      receiptNo: await paymentReceiptNumber(tx),
      invoiceId: inv.id,
      amountPaisa: amount,
      method: d.method,
      paymentModeId: d.paymentModeId ?? null,
      reference: d.reference ?? null,
      bankAccountId: d.bankAccountId ?? null,
      cashierId: actor.id!,
      idempotencyKey,
    },
  });
  await tx.ledgerEntry.create({
    data: { account: moneyAccount(d.method), bankAccountId: d.bankAccountId ?? null, amountPaisa: amount, refType: 'Payment', refId: payment.id, memo: `Invoice ${inv.number} · ${d.method}`, actorId: actor.id! },
  });
  return payment;
}

/** Change an invoice's paid and balance. A direct invoice closes itself once nothing is owed; a visit closes at the desk. */
export async function moveInvoiceBalance(tx: Tx, actor: Actor, inv: Invoice, paidDelta: bigint) {
  const paid = inv.paidPaisa + paidDelta;
  const balance = inv.balancePaisa - paidDelta;
  const closeNow = inv.kind === 'DIRECT' && inv.status === 'OPEN' && balance === 0n;
  return tx.invoice.update({
    where: { id: inv.id },
    data: { paidPaisa: paid, balancePaisa: balance, ...(closeNow ? { status: 'CLOSED' as const, closedAt: new Date(), closedById: actor.id! } : {}) },
  });
}

// ───────────── Patient advance ─────────────

export async function advanceBalance(db: Db, patientId: string): Promise<bigint> {
  const r = await db.patientAdvanceEntry.aggregate({ where: { patientId }, _sum: { amountPaisa: true } });
  return r._sum.amountPaisa ?? 0n;
}

/** Serialises everything that reads and then spends one patient's advance. */
async function lockPatient(tx: Tx, patientId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM patients WHERE id = ${patientId} FOR UPDATE`;
  if (!rows.length) throw new NotFoundError('Patient');
}

/** Money received as an advance, or the extra on an overpayment. */
export async function receiveAdvance(tx: Tx, actor: Actor, patientId: string, amount: bigint, d: MoneyDetails, idempotencyKey: string, extra: { invoiceId?: string; note?: string | null } = {}) {
  const receiptNo = await receiptNumber(tx, 'VH-ADV', 'advance');
  const entry = await tx.patientAdvanceEntry.create({
    data: {
      patientId,
      type: 'RECEIPT',
      amountPaisa: amount,
      receiptNo,
      method: d.method,
      paymentModeId: d.paymentModeId ?? null,
      reference: d.reference ?? null,
      bankAccountId: d.bankAccountId ?? null,
      invoiceId: extra.invoiceId ?? null,
      note: extra.note?.trim() || null,
      actorId: actor.id!,
      idempotencyKey,
    },
  });
  await tx.ledgerEntry.createMany({
    data: [
      { account: moneyAccount(d.method), bankAccountId: d.bankAccountId ?? null, amountPaisa: amount, refType: 'PatientAdvance', refId: entry.id, memo: `Advance ${receiptNo} · ${d.method}`, actorId: actor.id! },
      { account: 'PATIENT_ADVANCE', amountPaisa: amount, refType: 'PatientAdvance', refId: entry.id, memo: `Advance ${receiptNo}`, actorId: actor.id! },
    ],
  });
  await audit(tx, actor, { action: 'ADVANCE_RECEIVED', recordType: 'Patient', recordId: patientId, after: { entryId: entry.id, receiptNo, amount, method: d.method, invoiceId: extra.invoiceId ?? null } });
  return entry;
}

/** Pay an invoice from the patient's advance: no new money, so no cash or bank entry. */
export async function applyAdvance(tx: Tx, actor: Actor, inv: Pick<Invoice, 'id' | 'number' | 'patientId'>, amount: bigint, idempotencyKey: string) {
  if (!inv.patientId) throw new ValidationError('Is invoice par patient nahi.');
  if (amount <= 0n) throw new ValidationError('Amount sahi likhein.');
  await lockPatient(tx, inv.patientId);
  const available = await advanceBalance(tx, inv.patientId);
  if (amount > available) throw new ValidationError(`Patient ka advance sirf Rs ${Number(available) / 100} hai.`, { availablePaisa: available });
  const payment = await tx.payment.create({
    data: { receiptNo: await paymentReceiptNumber(tx), invoiceId: inv.id, amountPaisa: amount, method: 'ADVANCE', cashierId: actor.id!, idempotencyKey },
  });
  const entry = await tx.patientAdvanceEntry.create({
    data: { patientId: inv.patientId, type: 'APPLIED', amountPaisa: -amount, invoiceId: inv.id, paymentId: payment.id, actorId: actor.id!, idempotencyKey: `${idempotencyKey}:applied` },
  });
  await tx.ledgerEntry.create({ data: { account: 'PATIENT_ADVANCE', amountPaisa: -amount, refType: 'PatientAdvance', refId: entry.id, memo: `Applied to invoice ${inv.number}`, actorId: actor.id! } });
  await audit(tx, actor, { action: 'ADVANCE_APPLIED', recordType: 'Invoice', recordId: inv.id, after: { paymentId: payment.id, receiptNo: payment.receiptNo, amount, availableBefore: available } });
  return payment;
}

/** Money from a cancelled invoice is now held for the patient. Nothing leaves the drawer. */
export async function creditAdvanceFromCancel(tx: Tx, actor: Actor, patientId: string, amount: bigint, inv: Pick<Invoice, 'id' | 'number'>, paymentId: string) {
  await lockPatient(tx, patientId);
  const entry = await tx.patientAdvanceEntry.create({
    data: { patientId, type: 'CANCEL_CREDIT', amountPaisa: amount, invoiceId: inv.id, paymentId, actorId: actor.id!, idempotencyKey: `cancel-credit:${paymentId}` },
  });
  await tx.ledgerEntry.create({ data: { account: 'PATIENT_ADVANCE', amountPaisa: amount, refType: 'PatientAdvance', refId: entry.id, memo: `From cancelled invoice ${inv.number}`, actorId: actor.id! } });
  return entry;
}

/** Pay an advance back to the patient (Manager / MD): money leaves the drawer or bank today. */
export async function refundAdvance(tx: Tx, actor: Actor, patientId: string, amount: bigint, d: MoneyDetails, idempotencyKey: string, reason: string) {
  if (amount <= 0n) throw new ValidationError('Amount sahi likhein.');
  await lockPatient(tx, patientId);
  const available = await advanceBalance(tx, patientId);
  if (amount > available) throw new ValidationError(`Patient ka advance sirf Rs ${Number(available) / 100} hai.`, { availablePaisa: available });
  const receiptNo = await receiptNumber(tx, 'VH-ADV', 'advance');
  const entry = await tx.patientAdvanceEntry.create({
    data: { patientId, type: 'REFUND', amountPaisa: -amount, receiptNo, method: d.method, paymentModeId: d.paymentModeId ?? null, reference: d.reference ?? null, bankAccountId: d.bankAccountId ?? null, note: reason, actorId: actor.id!, idempotencyKey },
  });
  await tx.ledgerEntry.createMany({
    data: [
      { account: moneyAccount(d.method), bankAccountId: d.bankAccountId ?? null, amountPaisa: -amount, refType: 'PatientAdvance', refId: entry.id, memo: `Advance refund ${receiptNo}`, actorId: actor.id! },
      { account: 'PATIENT_ADVANCE', amountPaisa: -amount, refType: 'PatientAdvance', refId: entry.id, memo: `Advance refund ${receiptNo}`, actorId: actor.id! },
    ],
  });
  await audit(tx, actor, { action: 'ADVANCE_REFUNDED', recordType: 'Patient', recordId: patientId, before: { balance: available }, after: { entryId: entry.id, receiptNo, amount, method: d.method, balance: available - amount }, reason });
  return entry;
}

/** Advances that moved real money in a period (receipts in, refunds out). Used by every "collected" figure. */
export async function advanceMoney(bounds: { start: Date; end: Date }) {
  return prisma.patientAdvanceEntry.findMany({
    where: { createdAt: { gte: bounds.start, lt: bounds.end }, type: { in: ['RECEIPT', 'REFUND'] } },
    select: { id: true, receiptNo: true, amountPaisa: true, method: true, reference: true, actorId: true, createdAt: true, type: true },
  });
}

export function assertNotCancelled(inv: Pick<Invoice, 'status' | 'number'>) {
  if (inv.status === 'VOID') throw new ConflictError('INVOICE_CANCELLED', `Invoice ${inv.number} cancel ho chuki hai.`);
}
