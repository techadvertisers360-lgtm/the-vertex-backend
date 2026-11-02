import { describe, expect, it } from 'vitest';
import { invoiceSequenceName, invoiceTotals, renderInvoiceNumber, splitPayment } from '../../src/modules/invoices/money';
import { invoicesCsv, plainRupees, safeCell, type ExportRow } from '../../src/modules/invoices/export';

const line = (rupees: number, quantity = 1) => ({ unitPricePaisa: BigInt(rupees * 100), quantity });

describe('invoice totals: Total = Sub Total - Discount + Tax', () => {
  it('adds lines and quantities, with no tax when there is no rate', () => {
    expect(invoiceTotals([line(1500), line(2000, 2)], 50_000n, null)).toEqual({ subtotal: 550_000n, discount: 50_000n, tax: 0n, taxRateBp: null, total: 500_000n });
  });

  it('D-088: tax sits inside the total after the discount, and the amount to pay does not go up', () => {
    const t = invoiceTotals([line(10_000)], 100_000n, 1600); // Rs 9,000 × 16 / 116
    expect(t).toMatchObject({ subtotal: 1_000_000n, discount: 100_000n, tax: 124_138n, taxRateBp: 1600, total: 900_000n });
    expect(t.total).toBe(t.subtotal - t.discount);
  });

  it('rounds tax to the nearest paisa and stays exact on values floats get wrong', () => {
    expect(invoiceTotals([{ unitPricePaisa: 2n, quantity: 1 }], 0n, 5000).tax).toBe(1n); // 0.67 rounds up
    expect(invoiceTotals([{ unitPricePaisa: 1n, quantity: 1 }], 0n, 4900).tax).toBe(0n); // 0.33 rounds down
    expect(invoiceTotals([{ unitPricePaisa: 10n, quantity: 1 }, { unitPricePaisa: 20n, quantity: 1 }], 0n, null).total).toBe(30n);
    expect(invoiceTotals([{ unitPricePaisa: 9_007_199_254_740_991n, quantity: 2 }], 0n, null).total).toBe(18_014_398_509_481_982n);
  });

  it('treats a zero rate as no tax, shown as N/A', () => {
    expect(invoiceTotals([line(100)], 0n, 0)).toMatchObject({ tax: 0n, taxRateBp: null });
  });

  it('allows a discount of the full amount, and refuses more than that or a negative one', () => {
    expect(invoiceTotals([line(100)], 10_000n, null).total).toBe(0n);
    expect(() => invoiceTotals([line(100)], 10_001n, null)).toThrow(/zyada/);
    expect(() => invoiceTotals([line(100)], -1n, null)).toThrow(/Discount/);
  });

  it('refuses no lines, a negative price and a bad quantity', () => {
    expect(() => invoiceTotals([], 0n, null)).toThrow(/ek service/);
    expect(() => invoiceTotals([{ unitPricePaisa: -1n, quantity: 1 }], 0n, null)).toThrow(/Price/);
    expect(() => invoiceTotals([{ unitPricePaisa: 1n, quantity: 0 }], 0n, null)).toThrow(/Quantity/);
    expect(() => invoiceTotals([{ unitPricePaisa: 1n, quantity: 1.5 }], 0n, null)).toThrow(/Quantity/);
  });
});

describe('overpayment: the extra only goes to an advance when confirmed', () => {
  it('takes the whole amount when it fits the balance, including exactly the balance', () => {
    expect(splitPayment(1000n, 400n, { hasPatient: true })).toEqual({ toInvoice: 400n, toAdvance: 0n });
    expect(splitPayment(1000n, 1000n, { hasPatient: true })).toEqual({ toInvoice: 1000n, toAdvance: 0n });
  });

  it('refuses an overpayment until the extra is confirmed as an advance', () => {
    expect(() => splitPayment(1000n, 1001n, { hasPatient: true })).toThrow(/advance/);
    expect(splitPayment(1000n, 1500n, { hasPatient: true, extraToAdvance: true })).toEqual({ toInvoice: 1000n, toAdvance: 500n });
  });

  it('refuses it when there is no patient to hold the advance for', () => {
    expect(() => splitPayment(1000n, 1500n, { hasPatient: false, extraToAdvance: true })).toThrow(/patient/);
  });

  it('refuses zero and negative amounts', () => {
    expect(() => splitPayment(1000n, 0n, { hasPatient: true })).toThrow(/Amount/);
    expect(() => splitPayment(1000n, -5n, { hasPatient: true })).toThrow(/Amount/);
  });
});

describe('invoice number format', () => {
  it('renders each part and keeps today\'s format unchanged', () => {
    expect(renderInvoiceNumber('{PREFIX}-{YYYY}-{SEQ}', { prefix: 'VH-INV', year: 2026, seq: 7 })).toBe('VH-INV-2026-0007');
    expect(renderInvoiceNumber('INV/{YY}/{SEQ}', { prefix: 'x', year: 2026, seq: 12345 })).toBe('INV/26/12345');
  });

  it('uses a yearly count only when the number contains the year, so numbers cannot repeat', () => {
    expect(invoiceSequenceName('{PREFIX}-{YYYY}-{SEQ}', 2026)).toBe('invoice:2026');
    expect(invoiceSequenceName('INV/{YY}/{SEQ}', 2026)).toBe('invoice:2026');
    expect(invoiceSequenceName('INV-{SEQ}', 2026)).toBe('invoice:all');
  });
});

describe('export safety', () => {
  it('writes exact rupees', () => {
    expect(plainRupees(123_450n)).toBe('1234.50');
    expect(plainRupees(5)).toBe('0.05');
    expect(plainRupees(-5n)).toBe('-0.05');
  });

  it('stops a name running as a spreadsheet formula', () => {
    expect(safeCell('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
    expect(safeCell('Ali Khan')).toBe('Ali Khan');
  });

  it('quotes commas and line breaks in a CSV', () => {
    const row = { number: 'A-1', date: '2026-11-02', kind: 'DIRECT', status: 'OPEN', cancelled: false, cancelReason: null, patient: { id: 'p', name: 'Khan, Ali', phone: '923001234567' }, buyerName: null, buyerPhone: null, doctor: null, services: ['One', 'Two'], subtotalPaisa: 100n, discountPaisa: 0n, taxPaisa: null, totalPaisa: 100n, paidPaisa: 0n, balancePaisa: 100n } as unknown as ExportRow;
    const text = invoicesCsv([row]).toString('utf8');
    expect(text).toContain('"Khan, Ali"');
    expect(text).toContain('"1. One\n2. Two"');
    expect(text).toContain('N/A');
  });
});
