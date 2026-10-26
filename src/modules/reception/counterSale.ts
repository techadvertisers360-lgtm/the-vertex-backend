import type { PaymentMethod } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { NotFoundError, ValidationError } from '../../lib/errors';
import { formatNumber, nextSequence } from '../../lib/misc';
import { normalizePhone } from '../../lib/phone';
import { clinicDateStr, clinicDayBounds, local } from '../../lib/time';
import { audit, type Actor } from '../../services/audit';
import { getSetting } from '../../services/settings';
import { checkLowStock, usableBatches } from '../../services/stock';
import { pharmacyAmounts, type DiscountInput } from './pharmacy';
import { invoiceNumber } from './service';

/**
 * Counter sale (client 2026-10-26, D-061): someone walks in only for pharmacy products — no appointment. Reception
 * picks the products (selling price filled in, may be changed), gives a discount per line (percent or fixed amount)
 * and takes payment, which may be split (part cash, part bank transfer / card). One transaction writes a CLOSED
 * `COUNTER` invoice with its lines, deducts stock FEFO (`SALE` rows), and records each payment with its ledger entry —
 * so the sale, its discount and the cash / bank split show in the day's cash closing like any other payment.
 * The payments must add up to the total: a counter sale leaves no balance. The server computes every amount.
 */

export interface CounterLineInput {
  itemId: string;
  quantity: number;
  unitPricePaisa: number;
  discount: DiscountInput;
}

export interface CounterPaymentInput {
  method: PaymentMethod;
  amountPaisa: number;
  bankAccountId?: string;
  reference?: string;
}

export interface CounterSaleInput {
  buyerName?: string;
  buyerPhone?: string;
  lines: CounterLineInput[];
  payments: CounterPaymentInput[];
}

export async function createSale(actor: Actor, input: CounterSaleInput, idempotencyKey: string) {
  if (!input.lines.length) throw new ValidationError('Kam az kam ek product chunein.');
  for (const l of input.lines) {
    if (!Number.isSafeInteger(l.quantity) || l.quantity <= 0) throw new ValidationError('Quantity sahi likhein.');
    if (!Number.isSafeInteger(l.unitPricePaisa) || l.unitPricePaisa < 0) throw new ValidationError('Price sahi likhein.');
  }
  const payments = input.payments.filter((p) => p.amountPaisa !== 0);
  for (const p of payments) {
    if (!Number.isSafeInteger(p.amountPaisa) || p.amountPaisa < 0) throw new ValidationError('Payment amount sahi likhein.');
    if (p.method !== 'CASH' && !p.bankAccountId) throw new ValidationError('Bank / card payment ke liye bank account chunein.');
    if ((p.method === 'BANK_ONLINE' || p.method === 'CHEQUE') && !p.reference?.trim()) throw new ValidationError('Bank transfer ka transaction reference likhein.');
  }
  const phone = input.buyerPhone?.trim() ? normalizePhone(input.buyerPhone) : null;
  if (input.buyerPhone?.trim() && !phone) throw new ValidationError('Phone number sahi likhein.');
  const key = `counter:${idempotencyKey}`;

  const invoiceId = await prisma.$transaction(async (tx) => {
    const replay = await tx.stockTransaction.findFirst({ where: { idempotencyKey: { startsWith: `${key}:` } }, select: { invoiceLineId: true } });
    if (replay?.invoiceLineId) return (await tx.invoiceLine.findUniqueOrThrow({ where: { id: replay.invoiceLineId }, select: { invoiceId: true } })).invoiceId;

    // Price every line first (items locked) so the invoice is created with its final totals.
    const allowNegative = await getSetting('stock.allowNegative', tx);
    const priced = [];
    const wanted = new Map<string, number>();
    for (const l of input.lines) {
      await tx.$queryRaw`SELECT id FROM stock_items WHERE id = ${l.itemId} FOR UPDATE`;
      const item = await tx.stockItem.findUnique({ where: { id: l.itemId } });
      if (!item || !item.active || item.kind !== 'PHARMACY') throw new ValidationError('Pharmacy product chunein.');
      const batches = await usableBatches(tx, item.id);
      const available = batches.reduce((s, b) => s + b.balance, 0);
      const total = (wanted.get(item.id) ?? 0) + l.quantity;
      if (total > available && !allowNegative) throw new ValidationError(`${item.name}: sirf ${available} ${item.baseUnit} stock mein hai.`, { itemId: item.id, available });
      wanted.set(item.id, total);
      priced.push({ input: l, item, amt: pharmacyAmounts(BigInt(l.unitPricePaisa), l.quantity, l.discount) });
    }
    const subtotal = priced.reduce((s, p) => s + p.amt.gross, 0n);
    const discount = priced.reduce((s, p) => s + p.amt.discount, 0n);
    const total = subtotal - discount;
    const paid = payments.reduce((s, p) => s + BigInt(p.amountPaisa), 0n);
    if (paid !== total) throw new ValidationError(`Payment (Rs ${Number(paid) / 100}) total (Rs ${Number(total) / 100}) ke barabar honi chahiye.`, { totalPaisa: total, paidPaisa: paid });
    for (const p of payments)
      if (p.bankAccountId && !(await tx.bankAccount.findFirst({ where: { id: p.bankAccountId, active: true } }))) throw new ValidationError('Bank account nahi mila.');

    const now = new Date();
    const inv = await tx.invoice.create({
      data: {
        number: await invoiceNumber(tx),
        kind: 'COUNTER',
        buyerName: input.buyerName?.trim() || null,
        buyerPhone: phone,
        status: 'CLOSED',
        subtotalPaisa: subtotal,
        discountPaisa: discount,
        totalPaisa: total,
        paidPaisa: paid,
        balancePaisa: 0n,
        closedAt: now,
        closedById: actor.id,
        createdById: actor.id!,
      },
    });

    // Lines and stock: FEFO across usable batches (the same rule as pharmacy at billing).
    for (const [i, p] of priced.entries()) {
      const line = await tx.invoiceLine.create({
        data: {
          invoiceId: inv.id,
          description: `Pharmacy: ${p.item.name}`,
          quantity: p.input.quantity,
          unitPricePaisa: BigInt(p.input.unitPricePaisa),
          discountPaisa: p.amt.discount,
          discountPercentBp: p.amt.percentBp,
          lineTotalPaisa: p.amt.net,
          stockItemId: p.item.id,
        },
      });
      let remaining = p.input.quantity;
      for (const b of await usableBatches(tx, p.item.id)) {
        if (!remaining) break;
        const take = Math.min(remaining, b.balance);
        await tx.stockTransaction.create({ data: { itemId: p.item.id, batchId: b.id, type: 'SALE', quantity: -take, invoiceLineId: line.id, actorId: actor.id!, reason: `Counter sale · ${inv.number}`, idempotencyKey: `${key}:${i}:${b.id}` } });
        remaining -= take;
      }
      if (remaining > 0)
        await tx.stockTransaction.create({ data: { itemId: p.item.id, type: 'SALE', quantity: -remaining, invoiceLineId: line.id, actorId: actor.id!, reason: `Counter sale (no batch stock) · ${inv.number}`, idempotencyKey: `${key}:${i}:nobatch` } });
    }

    // Payments: each one a receipt and a ledger entry (cash in hand, or the chosen bank account).
    const year = local(now).year;
    for (const [i, p] of payments.entries()) {
      const payment = await tx.payment.create({
        data: {
          receiptNo: formatNumber('VH-RCP', year, await nextSequence(tx, `receipt:${year}`)),
          invoiceId: inv.id,
          amountPaisa: BigInt(p.amountPaisa),
          method: p.method,
          reference: p.reference?.trim() || null,
          bankAccountId: p.method === 'CASH' ? null : p.bankAccountId!,
          cashierId: actor.id!,
          idempotencyKey: `${key}:pay:${i}`,
        },
      });
      await tx.ledgerEntry.create({
        data: {
          account: p.method === 'CASH' ? 'CASH_IN_HAND' : 'BANK',
          bankAccountId: p.method === 'CASH' ? null : p.bankAccountId!,
          amountPaisa: BigInt(p.amountPaisa),
          refType: 'Payment',
          refId: payment.id,
          memo: `Counter sale ${inv.number} · ${p.method}`,
          actorId: actor.id!,
        },
      });
    }
    await audit(tx, actor, {
      action: 'COUNTER_SALE',
      recordType: 'Invoice',
      recordId: inv.id,
      after: {
        number: inv.number,
        buyerName: inv.buyerName,
        lines: priced.map((p) => ({ itemId: p.item.id, name: p.item.name, quantity: p.input.quantity, unitPricePaisa: p.input.unitPricePaisa, discountPaisa: p.amt.discount, totalPaisa: p.amt.net })),
        subtotalPaisa: subtotal,
        discountPaisa: discount,
        totalPaisa: total,
        payments: payments.map((p) => ({ method: p.method, amountPaisa: p.amountPaisa })),
      },
    });
    for (const id of wanted.keys()) await checkLowStock(tx, id);
    return inv.id;
  });
  return detail(invoiceId);
}

/** A counter sale as a receipt: lines, discount, total and how it was paid (cash / bank). */
export async function detail(invoiceId: string) {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { lines: { orderBy: { createdAt: 'asc' } }, payments: { orderBy: { receivedAt: 'asc' } } } });
  if (!inv || inv.kind !== 'COUNTER') throw new NotFoundError('Counter sale');
  const [banks, users] = await Promise.all([
    prisma.bankAccount.findMany({ where: { id: { in: inv.payments.map((p) => p.bankAccountId).filter((x): x is string => !!x) } }, select: { id: true, name: true, bankName: true } }),
    prisma.user.findMany({ where: { id: { in: [inv.createdById] } }, select: { id: true, displayName: true } }),
  ]);
  const by = (m: string[]) => inv.payments.filter((p) => m.includes(p.method)).reduce((s, p) => s + p.amountPaisa, 0n);
  return {
    id: inv.id,
    number: inv.number,
    at: inv.createdAt,
    buyerName: inv.buyerName,
    buyerPhone: inv.buyerPhone,
    soldBy: users[0]?.displayName ?? null,
    lines: inv.lines.map((l) => ({ id: l.id, description: l.description.replace(/^Pharmacy: /, ''), quantity: l.quantity, unitPricePaisa: l.unitPricePaisa, discountPaisa: l.discountPaisa, discountPercentBp: l.discountPercentBp, lineTotalPaisa: l.lineTotalPaisa })),
    subtotalPaisa: inv.subtotalPaisa,
    discountPaisa: inv.discountPaisa,
    totalPaisa: inv.totalPaisa,
    cashPaisa: by(['CASH']),
    bankPaisa: by(['BANK_ONLINE', 'CARD', 'CHEQUE']),
    payments: inv.payments.map((p) => {
      const b = banks.find((x) => x.id === p.bankAccountId);
      return { receiptNo: p.receiptNo, method: p.method, amountPaisa: p.amountPaisa, reference: p.reference, bank: b ? `${b.name} · ${b.bankName}` : null };
    }),
  };
}

/** Counter sales of a clinic day, newest first, with the cash / bank split of each and the day's totals. */
export async function list(date?: string) {
  const d = date ?? clinicDateStr(new Date());
  const b = clinicDayBounds(d);
  const rows = await prisma.invoice.findMany({
    where: { kind: 'COUNTER', createdAt: { gte: b.start, lt: b.end } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, number: true, createdAt: true, buyerName: true, totalPaisa: true, discountPaisa: true, lines: { select: { id: true } }, payments: { select: { method: true, amountPaisa: true } } },
  });
  const items = rows.map((r) => {
    const cash = r.payments.filter((p) => p.method === 'CASH').reduce((s, p) => s + p.amountPaisa, 0n);
    return { id: r.id, number: r.number, at: r.createdAt, buyerName: r.buyerName, items: r.lines.length, discountPaisa: r.discountPaisa, totalPaisa: r.totalPaisa, cashPaisa: cash, bankPaisa: r.totalPaisa - cash };
  });
  const sum = (f: (x: (typeof items)[number]) => bigint) => items.reduce((s, x) => s + f(x), 0n);
  return { date: d, items, totals: { count: items.length, totalPaisa: sum((x) => x.totalPaisa), cashPaisa: sum((x) => x.cashPaisa), bankPaisa: sum((x) => x.bankPaisa), discountPaisa: sum((x) => x.discountPaisa) } };
}
