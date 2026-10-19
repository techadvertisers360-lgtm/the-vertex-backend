import { prisma, type Tx } from '../../lib/prisma';
import { ConflictError, LockedError, NotFoundError, ValidationError } from '../../lib/errors';
import { audit, type Actor } from '../../services/audit';
import { getSetting } from '../../services/settings';
import { checkLowStock, usableBatches } from '../../services/stock';

/**
 * Pharmacy at billing (client 2026-10-20, D-048): after the prescription pad photo is uploaded, the Receptionist adds
 * the pharmacy products the patient takes — product, quantity, price, and a discount as a percentage or a fixed
 * amount. Each becomes an invoice line, stock is deducted FEFO (`SALE` ledger rows) and the invoice totals / balance
 * rise in the same transaction. Lines are append-only: a mistake is cancelled with a reversal line and the stock
 * comes back. The server computes every amount.
 */

export type DiscountInput = { type: 'NONE' } | { type: 'PERCENT'; percent: number } | { type: 'FIXED'; amountPaisa: number };

/** Gross, discount and net for a pharmacy line — integer paisa only (pure; unit-tested). */
export function pharmacyAmounts(unitPricePaisa: bigint, quantity: number, d: DiscountInput) {
  const gross = unitPricePaisa * BigInt(quantity);
  let discount = 0n;
  let percentBp: number | null = null;
  if (d.type === 'PERCENT') {
    percentBp = Math.round(d.percent * 100);
    if (!Number.isFinite(d.percent) || percentBp < 0 || percentBp > 10_000) throw new ValidationError('Discount 0 se 100% ke darmiyan ho.');
    discount = (gross * BigInt(percentBp) + 5_000n) / 10_000n; // rounded to the nearest paisa
  } else if (d.type === 'FIXED') {
    if (!Number.isSafeInteger(d.amountPaisa) || d.amountPaisa < 0) throw new ValidationError('Discount amount sahi likhein.');
    discount = BigInt(d.amountPaisa);
  }
  if (discount > gross) throw new ValidationError('Discount total se zyada nahi ho sakta.');
  return { gross, discount, net: gross - discount, percentBp };
}

/** Pharmacy products the Receptionist can sell now: usable stock and selling price. No cost fields. */
export async function options() {
  const items = await prisma.stockItem.findMany({ where: { kind: 'PHARMACY', active: true }, select: { id: true, name: true, baseUnit: true, salePricePaisa: true }, orderBy: { name: 'asc' } });
  const rows = await Promise.all(items.map(async (i) => ({ ...i, usable: (await usableBatches(prisma, i.id)).reduce((s, b) => s + b.balance, 0) })));
  return { items: rows };
}

async function lockOpenInvoice(tx: Tx, invoiceId: string) {
  await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoiceId} FOR UPDATE`;
  const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
  if (!inv) throw new NotFoundError('Invoice');
  if (inv.status !== 'OPEN') throw new ConflictError('INVOICE_CLOSED', 'Invoice close ho chuki hai.');
  return inv;
}

export interface PharmacyLineInput {
  itemId: string;
  quantity: number;
  unitPricePaisa: number;
  discount: DiscountInput;
}

export async function addLine(actor: Actor, invoiceId: string, input: PharmacyLineInput, idempotencyKey: string) {
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw new ValidationError('Quantity sahi likhein.');
  if (!Number.isSafeInteger(input.unitPricePaisa) || input.unitPricePaisa < 0) throw new ValidationError('Price sahi likhein.');
  const key = `sale:${idempotencyKey}`;
  return prisma.$transaction(async (tx) => {
    const replay = await tx.stockTransaction.findFirst({ where: { idempotencyKey: { startsWith: `${key}:` } }, select: { invoiceLineId: true } });
    if (replay?.invoiceLineId) return { line: await tx.invoiceLine.findUniqueOrThrow({ where: { id: replay.invoiceLineId } }), replayed: true };

    const inv = await lockOpenInvoice(tx, invoiceId);
    const prescription = await tx.attachment.findFirst({ where: { recordType: 'Invoice', recordId: invoiceId, route: 'prescriptionPhoto' }, select: { id: true } });
    if (!prescription) throw new LockedError('PRESCRIPTION_REQUIRED', 'Pehle prescription pad ki photo upload karein, phir pharmacy add karein.');

    await tx.$queryRaw`SELECT id FROM stock_items WHERE id = ${input.itemId} FOR UPDATE`;
    const item = await tx.stockItem.findUnique({ where: { id: input.itemId } });
    if (!item || !item.active || item.kind !== 'PHARMACY') throw new ValidationError('Pharmacy product chunein.');
    const batches = await usableBatches(tx, item.id);
    const available = batches.reduce((s, b) => s + b.balance, 0);
    if (input.quantity > available && !(await getSetting('stock.allowNegative', tx))) {
      throw new ValidationError(`${item.name}: sirf ${available} ${item.baseUnit} stock mein hai.`, { itemId: item.id, available });
    }
    const amt = pharmacyAmounts(BigInt(input.unitPricePaisa), input.quantity, input.discount);
    const line = await tx.invoiceLine.create({
      data: {
        invoiceId,
        description: `Pharmacy: ${item.name}`,
        quantity: input.quantity,
        unitPricePaisa: BigInt(input.unitPricePaisa),
        discountPaisa: amt.discount,
        discountPercentBp: amt.percentBp,
        lineTotalPaisa: amt.net,
        stockItemId: item.id,
      },
    });
    let remaining = input.quantity;
    for (const b of batches) {
      if (!remaining) break;
      const take = Math.min(remaining, b.balance);
      await tx.stockTransaction.create({ data: { itemId: item.id, batchId: b.id, type: 'SALE', quantity: -take, invoiceLineId: line.id, actorId: actor.id!, reason: `Pharmacy sale · invoice ${inv.number}`, idempotencyKey: `${key}:${b.id}` } });
      remaining -= take;
    }
    if (remaining > 0)
      await tx.stockTransaction.create({ data: { itemId: item.id, type: 'SALE', quantity: -remaining, invoiceLineId: line.id, actorId: actor.id!, reason: `Pharmacy sale (no batch stock) · invoice ${inv.number}`, idempotencyKey: `${key}:nobatch` } });
    await tx.invoice.update({
      where: { id: invoiceId },
      data: { subtotalPaisa: { increment: amt.gross }, discountPaisa: { increment: amt.discount }, totalPaisa: { increment: amt.net }, balancePaisa: { increment: amt.net } },
    });
    await audit(tx, actor, { action: 'PHARMACY_SALE', recordType: 'Invoice', recordId: invoiceId, after: { lineId: line.id, itemId: item.id, quantity: input.quantity, unitPricePaisa: input.unitPricePaisa, discountPaisa: amt.discount, percentBp: amt.percentBp, totalPaisa: amt.net } });
    await checkLowStock(tx, item.id);
    return { line, replayed: false };
  });
}

/** Cancel a pharmacy line added by mistake: a reversal line, stock back, totals down. Not after it is paid for. */
export async function reverseLine(actor: Actor, invoiceId: string, lineId: string, reason: string) {
  if (!reason.trim()) throw new ValidationError('Wajah likhein.');
  return prisma.$transaction(async (tx) => {
    const inv = await lockOpenInvoice(tx, invoiceId);
    const line = await tx.invoiceLine.findUnique({ where: { id: lineId } });
    if (!line || line.invoiceId !== invoiceId || !line.stockItemId || line.reversesLineId) throw new NotFoundError('Pharmacy line');
    if (await tx.invoiceLine.findUnique({ where: { reversesLineId: lineId } })) throw new ConflictError('ALREADY_REVERSED', 'Yeh line pehle hi wapas ho chuki hai.');
    if (inv.balancePaisa < line.lineTotalPaisa) throw new ConflictError('LINE_PAID', 'Is line ki payment ho chuki hai — wapas karne ke liye pehle refund karein (Manager).');
    const gross = line.unitPricePaisa * BigInt(line.quantity);
    const rev = await tx.invoiceLine.create({
      data: {
        invoiceId,
        description: `Wapas: ${line.description.replace(/^Pharmacy: /, '')}`,
        quantity: -line.quantity,
        unitPricePaisa: line.unitPricePaisa,
        discountPaisa: -line.discountPaisa,
        discountPercentBp: line.discountPercentBp,
        lineTotalPaisa: -line.lineTotalPaisa,
        stockItemId: line.stockItemId,
        reversesLineId: lineId,
        reason: reason.trim(),
      },
    });
    const sold = await tx.stockTransaction.findMany({ where: { invoiceLineId: lineId, type: 'SALE' } });
    for (const t of sold)
      await tx.stockTransaction.create({ data: { itemId: t.itemId, batchId: t.batchId, type: 'ADJUSTMENT', quantity: -t.quantity, invoiceLineId: rev.id, actorId: actor.id!, reason: `Pharmacy line wapas · invoice ${inv.number}: ${reason.trim()}`, idempotencyKey: `salerev:${t.id}` } });
    await tx.invoice.update({
      where: { id: invoiceId },
      data: { subtotalPaisa: { decrement: gross }, discountPaisa: { decrement: line.discountPaisa }, totalPaisa: { decrement: line.lineTotalPaisa }, balancePaisa: { decrement: line.lineTotalPaisa } },
    });
    await audit(tx, actor, { action: 'PHARMACY_SALE_REVERSED', recordType: 'Invoice', recordId: invoiceId, after: { lineId, reversalLineId: rev.id, totalPaisa: line.lineTotalPaisa }, reason: reason.trim() });
    await checkLowStock(tx, line.stockItemId!);
    return { reversal: rev };
  });
}
