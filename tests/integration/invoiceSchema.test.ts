import { describe, expect, it } from 'vitest';
import { agentFor, call, makeUser, newKey, prisma, uid, uniquePhone } from './helpers';
import { clinicDateStr, dateOnlyStr } from '../../src/lib/time';

/** D-084 — invoice module database foundation. */

async function advanceEntry() {
  const staff = await makeUser('RECEPTIONIST');
  const patient = await prisma.patient.create({ data: { name: `Advance ${uid()}`, phone: uniquePhone(), createdById: staff.id } });
  return prisma.patientAdvanceEntry.create({
    data: { patientId: patient.id, type: 'RECEIPT', amountPaisa: 100_000n, method: 'CASH', actorId: staff.id, idempotencyKey: uid() },
  });
}

describe('D-084 — invoice database foundation', () => {
  it('starts with the four existing payment types as modes, each settling as its own method', async () => {
    const modes = await prisma.paymentMode.findMany({ where: { id: { in: ['pm_cash', 'pm_card', 'pm_online', 'pm_cheque'] } }, orderBy: { sortOrder: 'asc' } });
    expect(modes.map((m) => [m.name, m.method, m.active])).toEqual([
      ['Cash', 'CASH', true],
      ['Card', 'CARD', true],
      ['Online Transfer', 'BANK_ONLINE', true],
      ['Cheque', 'CHEQUE', true],
    ]);
  });

  it('starts with the Consultation, Procedure and Injection categories', async () => {
    const names = (await prisma.invoiceCategory.findMany({ where: { id: { in: ['ic_consultation', 'ic_procedure', 'ic_injection'] } } })).map((c) => c.name).sort();
    expect(names).toEqual(['Consultation', 'Injection', 'Procedure']);
  });

  it('advance entries can never be changed or deleted, even by direct SQL', async () => {
    const e = await advanceEntry();
    await expect(prisma.$executeRaw`UPDATE patient_advance_entries SET amountPaisa = 1 WHERE id = ${e.id}`).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM patient_advance_entries WHERE id = ${e.id}`).rejects.toThrow(/append-only/);
    expect((await prisma.patientAdvanceEntry.findUniqueOrThrow({ where: { id: e.id } })).amountPaisa).toBe(100_000n);
  });

  it('a retried advance key cannot write a second entry', async () => {
    const e = await advanceEntry();
    await expect(
      prisma.patientAdvanceEntry.create({ data: { patientId: e.patientId, type: 'RECEIPT', amountPaisa: 100_000n, method: 'CASH', actorId: e.actorId, idempotencyKey: e.idempotencyKey } }),
    ).rejects.toThrow();
  });

  it('payment modes and categories cannot be deleted, only turned off', async () => {
    await expect(prisma.$executeRaw`DELETE FROM payment_modes WHERE id = 'pm_cheque'`).rejects.toThrow(/cannot be deleted/);
    await expect(prisma.$executeRaw`DELETE FROM invoice_categories WHERE id = 'ic_injection'`).rejects.toThrow(/cannot be deleted/);
  });

  it('backend code from before the invoice date column can still create an invoice during a deploy', async () => {
    const staff = await makeUser('RECEPTIONIST');
    const id = uid();
    await prisma.$executeRaw`INSERT INTO invoices (id, number, createdById, updatedAt) VALUES (${id}, ${`OLD-${id}`}, ${staff.id}, NOW(3))`;
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(dateOnlyStr(inv.invoiceDate)).toBe(clinicDateStr(new Date()));
  });

  it('a payment can have only one reversal', async () => {
    const staff = await makeUser('RECEPTIONIST');
    const inv = await prisma.invoice.create({ data: { number: `T-${uid()}`, kind: 'DIRECT', invoiceDate: new Date(), createdById: staff.id } });
    const row = (amountPaisa: bigint, reversesPaymentId?: string) => ({ receiptNo: `R-${uid()}`, invoiceId: inv.id, amountPaisa, method: 'CASH' as const, cashierId: staff.id, idempotencyKey: uid(), reversesPaymentId });
    const paid = await prisma.payment.create({ data: row(50_000n) });
    await prisma.payment.create({ data: row(-50_000n, paid.id) });
    await expect(prisma.payment.create({ data: row(-50_000n, paid.id) })).rejects.toThrow();
  });

  it('a new counter sale records its clinic date', async () => {
    const rec = call((await agentFor('RECEPTIONIST')).agent);
    const mgr = call((await agentFor('MANAGER')).agent);
    const stock = await rec.post('/api/reception/stock', { kind: 'PHARMACY', name: `Syrup ${uid()}`, quantity: 5, pricePaisa: 50_000 }, newKey());
    expect(stock.status, JSON.stringify(stock.body)).toBe(201);
    expect((await mgr.post(`/api/reception/stock-intakes/${stock.body.intakeId}/verify`)).status).toBe(200);
    const sale = await rec.post(
      '/api/reception/counter-sales',
      { lines: [{ itemId: stock.body.itemId, quantity: 1, unitPricePaisa: 50_000, discount: { type: 'FIXED', amountPaisa: 0 } }], payments: [{ method: 'CASH', amountPaisa: 50_000 }] },
      newKey(),
    );
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: sale.body.id } });
    expect(dateOnlyStr(inv.invoiceDate)).toBe(clinicDateStr(new Date()));
    expect(inv.doctorId).toBeNull();
  });

  it('the API never accepts ADVANCE as a payment method', async () => {
    const rec = call((await agentFor('RECEPTIONIST')).agent);
    const manager = call((await agentFor('MANAGER')).agent);
    const body = { amountPaisa: 1000, method: 'ADVANCE' };
    expect((await rec.post('/api/reception/invoices/any-id/payments', body, newKey())).status).toBe(422);
    expect((await rec.post('/api/reception/invoices/any-id/payments', { ...body, method: 'CASH' }, newKey())).status).toBe(404); // control: only the method was refused
    const line = { itemId: 'x', quantity: 1, unitPricePaisa: 1000, discount: { type: 'FIXED', amountPaisa: 0 } };
    expect((await rec.post('/api/reception/counter-sales', { lines: [line], payments: [body] }, newKey())).status).toBe(422);
    expect((await manager.post('/api/inventory/vendors/any-id/payments', body, newKey())).status).toBe(422);
  });
});
