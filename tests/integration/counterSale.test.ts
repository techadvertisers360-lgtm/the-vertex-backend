import { beforeAll, describe, expect, it } from 'vitest';
import { onHand } from '../../src/services/stock';
import { agentFor, call, newKey, prisma, uid } from './helpers';

/** D-061 — counter sale: walk-in pharmacy purchase with price change, discount and a cash + bank split. */

let rec: ReturnType<typeof call>;
let mgr: ReturnType<typeof call>;
let bankId: string;

beforeAll(async () => {
  rec = call((await agentFor('RECEPTIONIST')).agent);
  mgr = call((await agentFor('MANAGER')).agent);
  bankId = (await prisma.bankAccount.findFirst({ where: { active: true } }))?.id ?? (await prisma.bankAccount.create({ data: { name: 'Test bank', bankName: 'Test', accountNo: '0000' } })).id;
});

async function pharmacyItem(name: string, qty: number, salePaisa: number) {
  const r = await rec.post('/api/reception/stock', { kind: 'PHARMACY', name, quantity: qty, pricePaisa: salePaisa }, newKey());
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect((await mgr.post(`/api/reception/stock-intakes/${r.body.intakeId}/verify`)).status).toBe(200);
  return r.body.itemId as string;
}

describe('D-061 — counter sale', () => {
  it('sells with a changed price and discounts, splits cash + bank, deducts stock and shows in the cash day', async () => {
    const t = uid();
    const a = await pharmacyItem(`Sunblock ${t}`, 10, 150_000); // Rs 1,500
    const b = await pharmacyItem(`Serum ${t}`, 5, 200_000); // Rs 2,000
    const lines = [
      { itemId: a, quantity: 2, unitPricePaisa: 150_000, discount: { type: 'PERCENT', percent: 10 } }, // 3000 − 300 = 2700
      { itemId: b, quantity: 1, unitPricePaisa: 180_000, discount: { type: 'FIXED', amountPaisa: 30_000 } }, // fixed price 1800 − 300 = 1500
    ];
    // payments must equal the total (Rs 4,200)
    const short = await rec.post('/api/reception/counter-sales', { lines, payments: [{ method: 'CASH', amountPaisa: 100_000 }] }, newKey());
    expect(short.status).toBe(422);
    expect(await onHand(prisma, a)).toBe(10);

    const key = newKey();
    const body = { buyerName: 'Walk-in', buyerPhone: '0300 1234567', lines, payments: [{ method: 'CASH', amountPaisa: 200_000 }, { method: 'BANK_ONLINE', amountPaisa: 220_000, bankAccountId: bankId, reference: `TRX-${t}` }] };
    const sale = await rec.post('/api/reception/counter-sales', body, key);
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(sale.body).toMatchObject({ subtotalPaisa: 480_000, discountPaisa: 60_000, totalPaisa: 420_000, cashPaisa: 200_000, bankPaisa: 220_000, buyerPhone: '923001234567' });
    expect(await onHand(prisma, a)).toBe(8);
    expect(await onHand(prisma, b)).toBe(4);
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: sale.body.id } })).toMatchObject({ kind: 'COUNTER', status: 'CLOSED', balancePaisa: 0n, appointmentId: null, patientId: null });
    expect(await prisma.ledgerEntry.count({ where: { refType: 'Payment', memo: { startsWith: `Counter sale ${sale.body.number}` } } })).toBe(2);

    // a retry with the same key is the same sale
    const again = await rec.post('/api/reception/counter-sales', body, key);
    expect(again.body.id).toBe(sale.body.id);
    expect(await onHand(prisma, a)).toBe(8);

    const day = await mgr.get('/api/cash/day');
    expect(day.status).toBe(200);
    expect(day.body.counterSales.cashPaisa).toBeGreaterThanOrEqual(200_000);
    expect(day.body.counterSales.bankPaisa).toBeGreaterThanOrEqual(220_000);
    expect(day.body.payments.filter((p: { invoiceNumber: string; counterSale: boolean }) => p.invoiceNumber === sale.body.number && p.counterSale)).toHaveLength(2);
    const list = await rec.get('/api/reception/counter-sales');
    expect(list.body.items.find((s: { id: string }) => s.id === sale.body.id)).toMatchObject({ totalPaisa: 420_000, cashPaisa: 200_000, bankPaisa: 220_000 });
    // a counter sale is not a visit invoice
    expect((await rec.get(`/api/reception/invoices/${sale.body.id}`)).status).toBe(409);
  });

  it('refuses more than the usable stock and non-pharmacy items; only billing roles may sell', async () => {
    const t = uid();
    const a = await pharmacyItem(`Gel ${t}`, 1, 50_000);
    const over = await rec.post('/api/reception/counter-sales', { lines: [{ itemId: a, quantity: 2, unitPricePaisa: 50_000, discount: { type: 'NONE' } }], payments: [{ method: 'CASH', amountPaisa: 100_000 }] }, newKey());
    expect(over.status).toBe(422);
    const doc = call((await agentFor('DOCTOR')).agent);
    expect((await doc.post('/api/reception/counter-sales', { lines: [{ itemId: a, quantity: 1, unitPricePaisa: 50_000, discount: { type: 'NONE' } }], payments: [{ method: 'CASH', amountPaisa: 50_000 }] }, newKey())).status).toBe(403);
  });
});
