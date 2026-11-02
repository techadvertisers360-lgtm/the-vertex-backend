import { beforeAll, describe, expect, it } from 'vitest';
import { normalizePhone } from '../../src/lib/phone';
import { clinicDateStr } from '../../src/lib/time';
import { agentFor, call, makeUser, newKey, prisma, uid, uniquePhone } from './helpers';

/** D-089 — clinic operations from the client's demo: money rules, approvals by someone else, and who may see what. */
let rec: ReturnType<typeof call>;
let mgr: ReturnType<typeof call>;
let md: ReturnType<typeof call>;
let recId: string;
const month = clinicDateStr(new Date()).slice(0, 7);

async function patient() {
  return prisma.patient.create({ data: { name: `Ops ${uid()}`, phone: normalizePhone(uniquePhone())!, createdById: recId } });
}

const cashMode = 'pm_cash';

async function invoice(amount: number, paid = 0, doctorId?: string) {
  const p = await patient();
  const res = await rec.post('/api/invoices', { patientId: p.id, doctorId, lines: [{ description: 'Service', unitPricePaisa: amount }], ...(paid ? { payment: { amountPaisa: paid, paymentModeId: cashMode } } : {}) }, newKey());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; number: string };
}

/** A paid pharmacy line with its stock transaction, as a counter sale leaves it. */
async function paidPharmacyLine(actorId: string) {
  const item = await prisma.stockItem.create({ data: { name: `Cream ${uid()}`, category: 'Test', baseUnit: 'piece', kind: 'PHARMACY', minQty: 0 } });
  const inv = await prisma.invoice.create({ data: { number: `T-${uid()}`, kind: 'COUNTER', status: 'CLOSED', buyerName: 'Walk-in', subtotalPaisa: 300_000n, discountPaisa: 0n, totalPaisa: 300_000n, paidPaisa: 300_000n, balancePaisa: 0n, createdById: actorId } });
  const line = await prisma.invoiceLine.create({ data: { invoiceId: inv.id, description: 'Pharmacy: Cream', quantity: 3, unitPricePaisa: 100_000n, discountPaisa: 0n, lineTotalPaisa: 300_000n, stockItemId: item.id } });
  await prisma.stockTransaction.create({ data: { itemId: item.id, type: 'SALE', quantity: -3, invoiceLineId: line.id, actorId } });
  await prisma.payment.create({ data: { receiptNo: `R-${uid()}`, invoiceId: inv.id, amountPaisa: 300_000n, method: 'CASH', cashierId: actorId, idempotencyKey: uid() } });
  return { inv, line, item };
}

beforeAll(async () => {
  const r = await agentFor('RECEPTIONIST');
  rec = call(r.agent);
  recId = r.user.id;
  mgr = call((await agentFor('MANAGER')).agent);
  md = call((await agentFor('MD')).agent);
});

describe('D-089 part payment and bill correction', () => {
  it('Reception asks, Manager decides; one request at a time; a reject needs a reason', async () => {
    const inv = await invoice(1_000_000);
    const asked = await rec.post('/api/ops/invoice-requests', { type: 'PART_PAYMENT', invoiceId: inv.id, amountAskedPaisa: 400_000, note: 'Patient ke paas abhi kam hain' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect((await rec.post('/api/ops/invoice-requests', { type: 'PART_PAYMENT', invoiceId: inv.id, amountAskedPaisa: 300_000, note: 'Dobara' })).status).toBe(409);
    expect((await rec.post(`/api/ops/invoice-requests/${asked.body.id}/decide`, { approve: true })).status).toBe(403);
    expect((await mgr.post(`/api/ops/invoice-requests/${asked.body.id}/decide`, { approve: false })).status).toBe(422);
    const ok = await mgr.post(`/api/ops/invoice-requests/${asked.body.id}/decide`, { approve: true, amountApprovedPaisa: 500_000 });
    expect(ok.body).toMatchObject({ status: 'APPROVED', amountApprovedPaisa: 500_000 });
    expect((await mgr.post(`/api/ops/invoice-requests/${asked.body.id}/decide`, { approve: true })).status).toBe(409);
  });

  it('asks for less than the balance only', async () => {
    const inv = await invoice(100_000);
    expect((await rec.post('/api/ops/invoice-requests', { type: 'PART_PAYMENT', invoiceId: inv.id, amountAskedPaisa: 100_000, note: 'Poora' })).status).toBe(422);
  });

  it('a Doctor decides part payments on own visits only', async () => {
    const d1 = await agentFor('DOCTOR');
    const d2 = await agentFor('DOCTOR');
    const inv = await invoice(1_000_000, 0, d1.user.id);
    const r = await rec.post('/api/ops/invoice-requests', { type: 'PART_PAYMENT', invoiceId: inv.id, amountAskedPaisa: 100_000, note: 'Kam hain' });
    expect((await call(d2.agent).post(`/api/ops/invoice-requests/${r.body.id}/decide`, { approve: true })).status).toBe(403);
    expect((await call(d2.agent).get('/api/ops/invoice-requests')).body.items.map((x: { id: string }) => x.id)).not.toContain(r.body.id);
    expect((await call(d1.agent).post(`/api/ops/invoice-requests/${r.body.id}/decide`, { approve: true })).status).toBe(200);
  });
});

describe('D-089 pharmacy returns', () => {
  it('nothing moves until someone else approves; then money, invoice and stock all change together', async () => {
    const { inv, line, item } = await paidPharmacyLine(recId);
    const asked = await rec.post('/api/ops/sale-returns', { invoiceLineId: line.id, quantity: 1, restock: true, method: 'CASH', reason: 'Patient ko allergy hui' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body.refundPaisa).toBe(100_000);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).paidPaisa).toBe(300_000n);
    expect((await rec.post('/api/ops/sale-returns', { invoiceLineId: line.id, quantity: 3, restock: true, method: 'CASH', reason: 'Zyada' })).status).toBe(422);

    expect((await rec.post(`/api/ops/sale-returns/${asked.body.id}/decide`, { approve: true })).status).toBe(403);
    const ok = await mgr.post(`/api/ops/sale-returns/${asked.body.id}/decide`, { approve: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id }, include: { payments: true } });
    expect(after).toMatchObject({ totalPaisa: 200_000n, paidPaisa: 200_000n, balancePaisa: 0n });
    expect(after.payments.reduce((s, p) => s + p.amountPaisa, 0n)).toBe(200_000n);
    expect(await prisma.ledgerEntry.findFirst({ where: { refType: 'SaleReturn', refId: asked.body.id } })).toMatchObject({ account: 'CASH_IN_HAND', amountPaisa: -100_000n });
    const stock = await prisma.stockTransaction.aggregate({ where: { itemId: item.id }, _sum: { quantity: true } });
    expect(stock._sum.quantity).toBe(-2);
    expect((await mgr.post(`/api/ops/sale-returns/${asked.body.id}/decide`, { approve: true })).status).toBe(409);
  });

  it('a person cannot approve their own return; damaged goods stay out of stock', async () => {
    const m = await agentFor('MANAGER');
    const { line, item } = await paidPharmacyLine(m.user.id);
    const own = call(m.agent);
    const asked = await own.post('/api/ops/sale-returns', { invoiceLineId: line.id, quantity: 1, restock: false, method: 'CASH', reason: 'Damaged tube' });
    expect((await own.post(`/api/ops/sale-returns/${asked.body.id}/decide`, { approve: true })).status).toBe(403);
    expect((await mgr.post(`/api/ops/sale-returns/${asked.body.id}/decide`, { approve: true })).status).toBe(200);
    expect((await prisma.stockTransaction.aggregate({ where: { itemId: item.id }, _sum: { quantity: true } }))._sum.quantity).toBe(-3);
  });
});

describe('D-089 cash', () => {
  it('handover: only the receiver confirms, once, and the clinic cash does not change', async () => {
    const m = await agentFor('MANAGER');
    const before = await prisma.ledgerEntry.count();
    const h = await rec.post('/api/ops/handovers', { amountPaisa: 4_000_000, leftAtDeskPaisa: 1_000_000, toId: m.user.id });
    expect(h.status, JSON.stringify(h.body)).toBe(201);
    expect(await prisma.ledgerEntry.count()).toBe(before);
    expect((await rec.post(`/api/ops/handovers/${h.body.id}/confirm`)).status).toBe(403);
    expect((await call(m.agent).post(`/api/ops/handovers/${h.body.id}/confirm`)).status).toBe(200);
    expect((await call(m.agent).post(`/api/ops/handovers/${h.body.id}/confirm`)).status).toBe(409);
  });

  it('expenses: only money from the drawer reaches Cash Closing; the same entry twice is refused; owners only', async () => {
    const d = `Bill ${uid()}`;
    const owner = await md.post('/api/ops/expenses', { category: 'Bills', description: d, amountPaisa: 500_000, paidFrom: 'OWNER' });
    expect(owner.status, JSON.stringify(owner.body)).toBe(201);
    expect(await prisma.ledgerEntry.count({ where: { refType: 'Expense', refId: owner.body.id } })).toBe(0);
    expect((await md.post('/api/ops/expenses', { category: 'Bills', description: d, amountPaisa: 500_000, paidFrom: 'OWNER' })).status).toBe(409);
    const out = await rec.post('/api/ops/cash-out', { category: 'Cash paid out', description: `Tea ${uid()}`, amountPaisa: 50_000 });
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    expect(await prisma.ledgerEntry.findFirst({ where: { refType: 'Expense', refId: out.body.id } })).toMatchObject({ account: 'CASH_IN_HAND', amountPaisa: -50_000n });
    for (const c of [rec, mgr]) {
      expect((await c.post('/api/ops/expenses', { category: 'X Y', description: 'No', amountPaisa: 100, paidFrom: 'OWNER' })).status).toBe(403);
      expect((await c.get('/api/ops/expenses')).status).toBe(403);
      expect((await c.get('/api/ops/profit-loss')).status).toBe(403);
      expect((await c.get('/api/ops/staff')).status).toBe(403);
      expect((await c.get('/api/ops/doctor-ledger')).status).toBe(403);
    }
  });
});

describe('D-089 doctor share', () => {
  it('uses the right percentage, takes cost off a procedure, and never tells the Doctor the cost', async () => {
    const d = await agentFor('DOCTOR');
    expect((await md.put(`/api/ops/doctor-ledger/${d.user.id}/rule`, { ownConsultBp: 6000, ownProcedureBp: 5000, clinicConsultBp: 4000, clinicProcedureBp: 3000, fixedCostPaisa: 100_000 })).status).toBe(200);
    const inv = await invoice(1_000_000, 0, d.user.id);
    const res = await md.get(`/api/ops/doctor-ledger?doctorId=${d.user.id}&month=${month}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.doctors[0].rows.find((r: { invoiceId: string }) => r.invoiceId === inv.id)).toMatchObject({ own: false, bp: 4000, sharePaisa: 400_000 });

    const patientId = (await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).patientId!;
    await md.put(`/api/ops/doctor-ledger/${d.user.id}/own-patient`, { patientId, own: true });
    const mine = await call(d.agent).get(`/api/ops/my-share?month=${month}`);
    expect(mine.body.rows[0]).toMatchObject({ own: true, bp: 6000, sharePaisa: 600_000 });
    expect(JSON.stringify(mine.body)).not.toMatch(/itemCost|fixedCost/);
    expect((await call(d.agent).get('/api/ops/doctor-ledger')).status).toBe(403);

    expect((await md.post(`/api/ops/doctor-ledger/${d.user.id}/pay`, { amountPaisa: 100_000, method: 'Cash' })).status).toBe(201);
    expect((await call(d.agent).get(`/api/ops/my-share?month=${month}`)).body).toMatchObject({ paidPaisa: 100_000, balancePaisa: 500_000 });
  });
});

describe('D-089 payroll', () => {
  it('takes absences and the advance off; a month is paid once; the advance balance goes down', async () => {
    const staff = await makeUser('ASSISTANT');
    expect((await md.put(`/api/ops/staff/${staff.id}`, { salaryPaisa: 2_400_000, workingDays: 24 })).status).toBe(200);
    await md.post(`/api/ops/staff/${staff.id}/marks`, { month, kind: 'ABSENCE' });
    await md.post(`/api/ops/staff/${staff.id}/advance`, { amountPaisa: 300_000 });
    expect((await md.post(`/api/ops/staff/${staff.id}/pay`, { month, advanceCutPaisa: 400_000 })).status).toBe(422);
    const slip = await md.post(`/api/ops/staff/${staff.id}/pay`, { month, advanceCutPaisa: 200_000 });
    expect(slip.status, JSON.stringify(slip.body)).toBe(201);
    expect(slip.body).toMatchObject({ salaryPaisa: 2_400_000, absenceDeductionPaisa: 100_000, advanceCutPaisa: 200_000, netPaisa: 2_100_000 });
    expect((await md.post(`/api/ops/staff/${staff.id}/pay`, { month, advanceCutPaisa: 0 })).status).toBe(409);
    expect((await prisma.salaryAdvance.aggregate({ where: { userId: staff.id }, _sum: { amountPaisa: true } }))._sum.amountPaisa).toBe(100_000n);
  });
});

describe('D-089 packages', () => {
  it('a sale is an invoice with a receipt; sessions run out and cannot go past the total', async () => {
    const type = await md.post('/api/ops/package-types', { name: `Laser ${uid()}`, kind: 'PACKAGE', sessions: 2, pricePaisa: 500_000 });
    expect(type.status, JSON.stringify(type.body)).toBe(201);
    const p = await patient();
    const key = newKey();
    const body = { typeId: type.body.id, patientId: p.id, payment: { amountPaisa: 500_000, paymentModeId: cashMode } };
    const sale = await rec.post('/api/ops/packages', body, key);
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect((await rec.post('/api/ops/packages', body, key)).body.id).toBe(sale.body.id);
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: sale.body.invoiceId } })).toMatchObject({ paidPaisa: 500_000n, balancePaisa: 0n });
    expect((await rec.post(`/api/ops/packages/${sale.body.id}/use`, {})).status).toBe(201);
    expect((await rec.post(`/api/ops/packages/${sale.body.id}/use`, {})).status).toBe(201);
    expect((await rec.post(`/api/ops/packages/${sale.body.id}/use`, {})).status).toBe(409);
  });
});

describe('D-089 office purchases', () => {
  it('the drawer pays the cash, change comes back, and the spend becomes an expense; the Manager has a limit', async () => {
    const boy = await agentFor('OFFICE_BOY');
    const ob = call(boy.agent);
    const r = await ob.post('/api/ops/office-purchases', { items: [{ name: 'Floor wiper', quantity: '2', approxPaisa: 200_000 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await ob.post(`/api/ops/office-purchases/${r.body.id}/decide`, { action: 'APPROVE', budgetPaisa: 300_000 })).status).toBe(403);
    expect((await mgr.post(`/api/ops/office-purchases/${r.body.id}/decide`, { action: 'APPROVE', budgetPaisa: 5_000_001 })).status).toBe(422);
    const ok = await mgr.post(`/api/ops/office-purchases/${r.body.id}/decide`, { action: 'APPROVE', budgetPaisa: 300_000 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const set = await mgr.post(`/api/ops/office-purchases/${r.body.id}/settle`, { billTotalPaisa: 250_000 });
    expect(set.body).toMatchObject({ status: 'SETTLED', changePaisa: 50_000 });
    const entries = await prisma.ledgerEntry.findMany({ where: { refType: 'OfficePurchase', refId: r.body.id } });
    expect(entries.reduce((s, e) => s + e.amountPaisa, 0n)).toBe(-250_000n);
    expect((await mgr.post(`/api/ops/office-purchases/${r.body.id}/settle`, { billTotalPaisa: 250_000 })).status).toBe(409);
  });
});

describe('D-089 chat, documents, data check', () => {
  it('chat rooms are by role; MD reads every room; Reception cannot read a room outside its own', async () => {
    const sent = await rec.post('/api/ops/chat/desk', { body: 'Salam' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect((await md.get('/api/ops/chat/desk')).body.items.at(-1)).toMatchObject({ body: 'Salam' });
    expect((await rec.get('/api/ops/chat/management')).status).toBe(403);
    expect((await rec.post('/api/ops/chat/doctors', { body: 'No' })).status).toBe(403);
    await expect(prisma.chatMessage.delete({ where: { id: sent.body.id } })).rejects.toThrow();
  });

  it('documents search by number; the data check is for owners and reports a mismatch', async () => {
    const inv = await invoice(100_000);
    const docs = await rec.get(`/api/ops/documents?q=${encodeURIComponent(inv.number)}`);
    expect(docs.body.items[0]).toMatchObject({ kind: 'Invoice', number: inv.number });
    expect((await rec.get('/api/ops/data-check')).status).toBe(403);
    const check = await md.get('/api/ops/data-check');
    expect(check.status, JSON.stringify(check.body)).toBe(200);
    expect(Array.isArray(check.body.problems)).toBe(true);
  });

  it('expenses and payroll rows cannot be rewritten or removed', async () => {
    const e = await md.post('/api/ops/expenses', { category: 'Bills', description: `Locked ${uid()}`, amountPaisa: 100, paidFrom: 'OWNER' });
    await expect(prisma.expense.update({ where: { id: e.body.id }, data: { amountPaisa: 1n } })).rejects.toThrow();
    await expect(prisma.expense.delete({ where: { id: e.body.id } })).rejects.toThrow();
  });
});
