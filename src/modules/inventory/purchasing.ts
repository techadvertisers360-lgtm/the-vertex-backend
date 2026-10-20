import type { PaymentMethod } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { clinicDateStr, dateOnly, dateOnlyStr } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';
import { claimAttachments } from '../../services/files';
import { getSetting } from '../../services/settings';
import { batchBalances, checkLowStock } from '../../services/stock';
import { lockDemand, OPEN_FOR_RECEIPT } from './demands';

/**
 * Purchasing (spec §14, §18): goods receipts against an approved demand — partial and from several vendors — each
 * with the vendor invoice, quantity, unit cost, lot and expiry. A receipt adds stock (ledger), a batch per lot, and
 * the vendor payable. Supplier returns reduce stock and payable; supplier payments reduce payable and the cash or
 * chosen bank ledger. All in one transaction each, all audited.
 */

export interface ReceiptLineInput {
  demandLineId: string;
  quantity: number;
  unitCostPaisa: number;
  lotNo: string;
  expiryDate?: string;
}

export async function receiveGoods(actor: Actor, input: { demandId: string; vendorId: string; vendorInvoiceNo?: string; attachmentId?: string; lines: ReceiptLineInput[] }, idempotencyKey: string) {
  if (!input.lines.length) throw new ValidationError('Kam az kam ek item receive karein.');
  const limit = BigInt(await getSetting('stock.managerApprovalLimitPaisa'));
  const today = clinicDateStr(new Date());
  return prisma.$transaction(async (tx) => {
    const replay = await tx.goodsReceipt.findUnique({ where: { idempotencyKey } });
    if (replay) return { receipt: replay, replayed: true };
    const d = await lockDemand(tx, input.demandId);
    if (!OPEN_FOR_RECEIPT.includes(d.status)) {
      throw new ConflictError(d.status === 'PENDING_MD' ? 'MD_APPROVAL_REQUIRED' : 'DEMAND_NOT_APPROVED', d.status === 'PENDING_MD' ? 'Yeh demand MD approval par hai — approval se pehle purchase nahi ho sakti.' : 'Sirf approved demand par purchase / receipt ho sakti hai.');
    }
    const vendor = await tx.vendor.findUnique({ where: { id: input.vendorId } });
    if (!vendor || !vendor.active) throw new ValidationError('Vendor nahi mila.');
    let total = 0n;
    for (const l of input.lines) {
      const line = d.lines.find((x) => x.id === l.demandLineId);
      if (!line) throw new ValidationError('Line is demand ki nahi.');
      if (!Number.isInteger(l.quantity) || l.quantity <= 0) throw new ValidationError('Quantity sahi likhein.');
      if (l.quantity > line.quantity - line.receivedQty) throw new ValidationError(`Demand se zyada nahi: is item ki ${line.quantity - line.receivedQty} baqi hai.`);
      if (l.unitCostPaisa <= 0) throw new ValidationError('Unit cost likhein.');
      if (!l.lotNo.trim()) throw new ValidationError('Lot / batch number likhein.');
      if (l.expiryDate && l.expiryDate <= today) throw new ValidationError('Expired maal receive nahi ho sakta.');
      total += BigInt(l.quantity) * BigInt(l.unitCostPaisa);
    }
    // A Manager-approved demand cannot be bought past the Manager limit without MD approval (lock 6).
    const before = await tx.goodsReceipt.aggregate({ where: { demandId: d.id }, _sum: { totalPaisa: true } });
    if (d.approverRole === 'MANAGER' && (before._sum.totalPaisa ?? 0n) + total > limit) {
      throw new ConflictError('MD_APPROVAL_REQUIRED', `Is demand ki kul purchase Rs ${Number(limit) / 100} se zyada ho jayegi — MD approval chahiye.`);
    }

    const receipt = await tx.goodsReceipt.create({ data: { demandId: d.id, vendorId: vendor.id, vendorInvoiceNo: input.vendorInvoiceNo?.trim() || null, totalPaisa: total, receivedById: actor.id!, idempotencyKey } });
    for (const l of input.lines) {
      const line = d.lines.find((x) => x.id === l.demandLineId)!;
      const lot = l.lotNo.trim();
      let batch = await tx.stockBatch.findUnique({ where: { itemId_lotNo: { itemId: line.itemId, lotNo: lot } } });
      if (batch && (batch.expiryDate ? dateOnlyStr(batch.expiryDate) : null) !== (l.expiryDate ?? null)) {
        throw new ValidationError(`Lot ${lot} pehle ${batch.expiryDate ? dateOnlyStr(batch.expiryDate) : 'baghair expiry'} ke saath aa chuka — expiry match nahi.`);
      }
      batch ??= await tx.stockBatch.create({ data: { itemId: line.itemId, lotNo: lot, expiryDate: l.expiryDate ? dateOnly(l.expiryDate) : null, vendorId: vendor.id, unitCostPaisa: BigInt(l.unitCostPaisa) } });
      const rl = await tx.goodsReceiptLine.create({ data: { receiptId: receipt.id, demandLineId: line.id, itemId: line.itemId, quantity: l.quantity, unitCostPaisa: BigInt(l.unitCostPaisa), lotNo: lot, expiryDate: batch.expiryDate, batchId: batch.id } });
      if (!batch.receiptLineId) await tx.stockBatch.update({ where: { id: batch.id }, data: { receiptLineId: rl.id } });
      await tx.stockTransaction.create({ data: { itemId: line.itemId, batchId: batch.id, type: 'PURCHASE', quantity: l.quantity, unitCostPaisa: BigInt(l.unitCostPaisa), demandId: d.id, receiptId: receipt.id, vendorId: vendor.id, actorId: actor.id!, reason: `Receipt ${input.vendorInvoiceNo ?? ''}`.trim(), idempotencyKey: `receipt:${receipt.id}:${rl.id}` } });
      await tx.stockDemandLine.update({ where: { id: line.id }, data: { receivedQty: { increment: l.quantity } } });
      await checkLowStock(tx, line.itemId);
    }
    const lines = await tx.stockDemandLine.findMany({ where: { demandId: d.id } });
    const done = lines.every((x) => x.receivedQty >= x.quantity);
    await tx.stockDemand.update({ where: { id: d.id }, data: { status: done ? 'RECEIVED' : 'PARTIALLY_RECEIVED' } });
    await tx.ledgerEntry.create({ data: { account: 'SUPPLIER_PAYABLE', vendorId: vendor.id, amountPaisa: total, refType: 'GoodsReceipt', refId: receipt.id, memo: `Invoice ${input.vendorInvoiceNo ?? '—'} · ${d.demandNumber}`, actorId: actor.id! } });
    if (input.attachmentId) {
      await claimAttachments(tx, actor, [input.attachmentId], ['vendorInvoice'], 'GoodsReceipt', receipt.id);
      await tx.goodsReceipt.update({ where: { id: receipt.id }, data: { attachmentId: input.attachmentId } });
    }
    await audit(tx, actor, { action: 'GOODS_RECEIVED', recordType: 'GoodsReceipt', recordId: receipt.id, after: { demandId: d.id, demandNumber: d.demandNumber, vendorId: vendor.id, totalPaisa: total, lines: input.lines } });
    return { receipt: await tx.goodsReceipt.findUniqueOrThrow({ where: { id: receipt.id } }), replayed: false };
  });
}

// ───────────── Vendors ─────────────

async function payable(vendorId: string) {
  const r = await prisma.ledgerEntry.aggregate({ where: { account: 'SUPPLIER_PAYABLE', vendorId }, _sum: { amountPaisa: true } });
  return r._sum.amountPaisa ?? 0n;
}

export async function listVendors() {
  const [vendors, sums] = await Promise.all([
    prisma.vendor.findMany({ orderBy: { name: 'asc' } }),
    prisma.ledgerEntry.groupBy({ by: ['vendorId'], where: { account: 'SUPPLIER_PAYABLE' }, _sum: { amountPaisa: true } }),
  ]);
  const paid = await prisma.supplierPayment.groupBy({ by: ['vendorId'], _sum: { amountPaisa: true }, _max: { paidAt: true } });
  return {
    items: vendors.map((v) => ({
      ...v,
      balancePaisa: sums.find((s) => s.vendorId === v.id)?._sum.amountPaisa ?? 0n,
      // Total paid to this vendor ever and the last payment date (D-050).
      paidPaisa: paid.find((x) => x.vendorId === v.id)?._sum.amountPaisa ?? 0n,
      lastPaidAt: paid.find((x) => x.vendorId === v.id)?._max.paidAt ?? null,
    })),
  };
}

export async function saveVendor(actor: Actor, input: { id?: string; name: string; phone?: string; address?: string; products?: string; active?: boolean }) {
  const name = input.name.trim();
  if (name.length < 2) throw new ValidationError('Vendor ka naam likhein.');
  return prisma.$transaction(async (tx) => {
    const dupe = await tx.vendor.findFirst({ where: { name, ...(input.id ? { id: { not: input.id } } : {}) } });
    if (dupe) throw new ConflictError('VENDOR_EXISTS', 'Is naam ka vendor pehle se hai.');
    const data = { name, phone: input.phone?.trim() || null, address: input.address?.trim() || null, products: input.products?.trim() || null, active: input.active ?? true };
    const before = input.id ? await tx.vendor.findUnique({ where: { id: input.id } }) : null;
    if (input.id && !before) throw new NotFoundError('Vendor');
    const v = input.id ? await tx.vendor.update({ where: { id: input.id }, data }) : await tx.vendor.create({ data });
    await audit(tx, actor, { action: input.id ? 'VENDOR_UPDATED' : 'VENDOR_CREATED', recordType: 'Vendor', recordId: v.id, before, after: v });
    return v;
  });
}

/** Vendor ledger: receipts (+), returns (−), payments (−) with a running balance (what the clinic owes). */
export async function vendorLedger(vendorId: string) {
  const v = await prisma.vendor.findUnique({ where: { id: vendorId } });
  if (!v) throw new NotFoundError('Vendor');
  const rows = await prisma.ledgerEntry.findMany({ where: { account: 'SUPPLIER_PAYABLE', vendorId }, orderBy: { createdAt: 'asc' } });
  const [receipts, payments, returns] = await Promise.all([
    prisma.goodsReceipt.findMany({ where: { id: { in: rows.filter((r) => r.refType === 'GoodsReceipt').map((r) => r.refId) } }, select: { id: true, vendorInvoiceNo: true, attachmentId: true, demandId: true } }),
    prisma.supplierPayment.findMany({ where: { id: { in: rows.filter((r) => r.refType === 'SupplierPayment').map((r) => r.refId) } }, select: { id: true, method: true, reference: true, note: true } }),
    prisma.supplierReturn.findMany({ where: { id: { in: rows.filter((r) => r.refType === 'SupplierReturn').map((r) => r.refId) } }, select: { id: true, quantity: true, reason: true, itemId: true } }),
  ]);
  let running = 0n;
  return {
    vendor: v,
    balancePaisa: await payable(vendorId),
    entries: rows.map((r) => {
      running += r.amountPaisa;
      return {
        id: r.id,
        at: r.createdAt,
        kind: r.refType,
        refId: r.refId,
        amountPaisa: r.amountPaisa,
        balancePaisa: running,
        memo: r.memo,
        receipt: receipts.find((x) => x.id === r.refId) ?? null,
        payment: payments.find((x) => x.id === r.refId) ?? null,
        return: returns.find((x) => x.id === r.refId) ?? null,
      };
    }),
  };
}

/** Supplier payment by cash, cheque or bank/online; reduces payable and cash-in-hand or the chosen bank ledger. */
/**
 * Record money paid to a vendor (D-050). Any amount: above what the clinic owes it becomes an advance (the vendor
 * balance goes below zero and later purchases use it up). Optional note: what the payment was for.
 */
export async function payVendor(actor: Actor, vendorId: string, input: { amountPaisa: number; method: PaymentMethod; reference?: string; bankAccountId?: string; note?: string }, idempotencyKey: string) {
  if (input.method === 'CARD') throw new ValidationError('Supplier payment: cash, cheque ya bank/online.');
  if (input.method !== 'CASH' && !input.bankAccountId) throw new ValidationError('Bank account chunein.');
  if (input.method !== 'CASH' && !input.reference?.trim()) throw new ValidationError(input.method === 'CHEQUE' ? 'Cheque number likhein.' : 'Transaction reference likhein.');
  return prisma.$transaction(async (tx) => {
    const replay = await tx.supplierPayment.findUnique({ where: { idempotencyKey } });
    if (replay) return { payment: replay, replayed: true };
    await tx.$queryRaw`SELECT id FROM vendors WHERE id = ${vendorId} FOR UPDATE`;
    const v = await tx.vendor.findUnique({ where: { id: vendorId } });
    if (!v) throw new NotFoundError('Vendor');
    if (input.bankAccountId && !(await tx.bankAccount.findFirst({ where: { id: input.bankAccountId, active: true } }))) throw new ValidationError('Bank account nahi mila.');
    const amount = BigInt(input.amountPaisa);
    if (amount <= 0n) throw new ValidationError('Amount likhein.');
    const note = input.note?.trim() || null;
    const p = await tx.supplierPayment.create({ data: { vendorId, amountPaisa: amount, method: input.method, reference: input.reference?.trim() || null, note, bankAccountId: input.method === 'CASH' ? null : input.bankAccountId!, actorId: actor.id!, idempotencyKey } });
    await tx.ledgerEntry.create({ data: { account: 'SUPPLIER_PAYABLE', vendorId, amountPaisa: -amount, refType: 'SupplierPayment', refId: p.id, memo: `${input.method}${input.reference ? ` ${input.reference}` : ''}${note ? ` · ${note}` : ''}`, actorId: actor.id! } });
    await tx.ledgerEntry.create({
      data: input.method === 'CASH'
        ? { account: 'CASH_IN_HAND', vendorId, amountPaisa: -amount, refType: 'SupplierPayment', refId: p.id, memo: `Supplier payment: ${v.name}`, actorId: actor.id! }
        : { account: 'BANK', bankAccountId: input.bankAccountId!, vendorId, amountPaisa: -amount, refType: 'SupplierPayment', refId: p.id, memo: `Supplier payment: ${v.name} · ${input.reference}`, actorId: actor.id! },
    });
    await audit(tx, actor, { action: 'SUPPLIER_PAID', recordType: 'SupplierPayment', recordId: p.id, after: { vendorId, amountPaisa: amount, method: input.method, reference: input.reference, bankAccountId: input.bankAccountId, note } });
    return { payment: p, replayed: false };
  });
}

/** Supplier return: stock out of a specific batch, payable reduced by quantity × that batch's unit cost. */
export async function returnToSupplier(actor: Actor, input: { batchId: string; quantity: number; reason: string }) {
  if (!input.reason.trim()) throw new ValidationError('Return ki wajah likhein.');
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new ValidationError('Quantity sahi likhein.');
  return prisma.$transaction(async (tx) => {
    const batch = await tx.stockBatch.findUnique({ where: { id: input.batchId } });
    if (!batch) throw new NotFoundError('Batch');
    await tx.$queryRaw`SELECT id FROM stock_items WHERE id = ${batch.itemId} FOR UPDATE`;
    if (!batch.vendorId || !batch.unitCostPaisa) throw new ValidationError('Is batch ka vendor / cost record nahi — return nahi ho sakta.');
    const bal = (await batchBalances(tx, batch.itemId)).get(batch.id) ?? 0;
    if (input.quantity > bal) throw new ValidationError(`Is batch mein sirf ${bal} baqi hai.`);
    const credit = BigInt(input.quantity) * batch.unitCostPaisa;
    const r = await tx.supplierReturn.create({ data: { vendorId: batch.vendorId, itemId: batch.itemId, batchId: batch.id, quantity: input.quantity, creditPaisa: credit, reason: input.reason.trim(), actorId: actor.id! } });
    await tx.stockTransaction.create({ data: { itemId: batch.itemId, batchId: batch.id, type: 'RETURN_TO_SUPPLIER', quantity: -input.quantity, unitCostPaisa: batch.unitCostPaisa, vendorId: batch.vendorId, actorId: actor.id!, reason: input.reason.trim(), idempotencyKey: `return:${r.id}` } });
    await tx.ledgerEntry.create({ data: { account: 'SUPPLIER_PAYABLE', vendorId: batch.vendorId, amountPaisa: -credit, refType: 'SupplierReturn', refId: r.id, memo: `Return lot ${batch.lotNo} × ${input.quantity}`, actorId: actor.id! } });
    await audit(tx, actor, { action: 'SUPPLIER_RETURN', recordType: 'SupplierReturn', recordId: r.id, after: { batchId: batch.id, quantity: input.quantity, creditPaisa: credit }, reason: input.reason });
    await checkLowStock(tx, batch.itemId);
    return r;
  });
}

export async function bankAccounts() {
  return { items: await prisma.bankAccount.findMany({ where: { active: true }, select: { id: true, name: true, bankName: true } }) };
}
