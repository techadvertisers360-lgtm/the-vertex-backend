import { ValidationError } from '../../lib/errors';

/**
 * Invoice arithmetic (D-084): integer paisa only, pure and unit-tested. The server is the only place these numbers
 * are worked out; a client never sends a total, tax or balance.
 *   Total = Sub Total - Discount (tax is inside the total, D-088)        Balance = Total - Paid
 */

export interface LineAmount {
  unitPricePaisa: bigint;
  quantity: number;
}

export interface InvoiceTotals {
  subtotal: bigint;
  discount: bigint;
  tax: bigint;
  taxRateBp: number | null;
  total: bigint;
}

/** Tax is the part of the discounted total that is tax, rounded to the nearest paisa; the patient pays no more (D-088). A null or zero rate means no tax ("N/A"). */
export function invoiceTotals(lines: LineAmount[], discount: bigint, taxRateBp: number | null): InvoiceTotals {
  if (!lines.length) throw new ValidationError('Kam az kam ek service add karein.');
  let subtotal = 0n;
  for (const l of lines) {
    if (l.unitPricePaisa < 0n) throw new ValidationError('Price sahi likhein.');
    if (!Number.isSafeInteger(l.quantity) || l.quantity <= 0) throw new ValidationError('Quantity sahi likhein.');
    subtotal += l.unitPricePaisa * BigInt(l.quantity);
  }
  if (discount < 0n) throw new ValidationError('Discount sahi likhein.');
  if (discount > subtotal) throw new ValidationError('Discount total se zyada nahi ho sakta.');
  const rate = taxRateBp && taxRateBp > 0 ? taxRateBp : null;
  const total = subtotal - discount;
  const divisor = BigInt(10_000 + (rate ?? 0));
  const tax = rate ? (total * BigInt(rate) + divisor / 2n) / divisor : 0n;
  return { subtotal, discount, tax, taxRateBp: rate, total };
}

/**
 * How much of a payment goes on the invoice and how much becomes the patient's advance. Paying more than the balance
 * is refused unless the extra is explicitly saved as an advance, which also needs a patient to hold it for.
 */
export function splitPayment(balance: bigint, amount: bigint, opts: { extraToAdvance?: boolean; hasPatient: boolean }): { toInvoice: bigint; toAdvance: bigint } {
  if (amount <= 0n) throw new ValidationError('Amount sahi likhein.');
  if (amount <= balance) return { toInvoice: amount, toAdvance: 0n };
  const extra = amount - balance;
  if (!opts.hasPatient) throw new ValidationError('Is invoice par patient nahi, is liye zyada raqam advance mein nahi ja sakti.', { extraPaisa: extra });
  if (!opts.extraToAdvance) throw new ValidationError('Amount balance se zyada hai. Zyada raqam ko advance mein save karne ki tasdeeq karein.', { extraPaisa: extra });
  return { toInvoice: balance, toAdvance: extra };
}

/** "{PREFIX}-{YYYY}-{SEQ}" → "VH-INV-2026-0007". {SEQ} is padded to at least four digits. */
export function renderInvoiceNumber(format: string, v: { prefix: string; year: number; seq: number }): string {
  return format
    .replace(/\{PREFIX\}/g, v.prefix)
    .replace(/\{YYYY\}/g, String(v.year))
    .replace(/\{YY\}/g, String(v.year).slice(-2))
    .replace(/\{SEQ\}/g, String(v.seq).padStart(4, '0'));
}

/** A format with a year restarts its count each year; one without keeps a single count, so numbers cannot repeat. */
export function invoiceSequenceName(format: string, year: number): string {
  return /\{YY(YY)?\}/.test(format) ? `invoice:${year}` : 'invoice:all';
}
